/**
 * Zcode-commandcode-private — shared core (MCP server + local dashboard).
 *
 * Everything here is UI-agnostic: config, SSRF-guarded HTTP, structured
 * errors, multi-account pool, model catalog (SWR + circuit breaker),
 * usage report, streaming generation, and the tool-level operations
 * (listModels / generate / usageReport / statusInfo) shared by the MCP
 * server (server.mjs) and the local web dashboard (dashboard.mjs).
 *
 * Ported from https://github.com/wjf1/dsh-commandcode (MIT). Zero runtime
 * dependencies (Node >= 18). See README.md for configuration.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://api.commandcode.ai'
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const GENERATE_MAX_TOKENS_CAP = 65_536
const COMMAND_CODE_CLI_VERSION = '1.38.2'
const DEFAULT_MODELS_CACHE_PATH = join(homedir(), '.commandcode', 'models-cache.json')

const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_STALE_MS = 24 * 60 * 60 * 1000
const CATALOG_TIMEOUT_MS = 15_000
const CATALOG_CIRCUIT_THRESHOLD = 5
const CATALOG_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000

const RETRYABLE_CODES = new Set([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'NETWORK_ERROR',
])
const NON_RETRYABLE_CODES = new Set([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION', 'MODEL_NOT_IN_PLAN', 'MODEL_NOT_FOUND',
  'PROVIDER_PROTOCOL_ERROR', 'STREAM_IDLE_TIMEOUT',
])

const KNOWN_EFFORTS = {
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
}

const KNOWN_IMAGE_MODELS = new Set([
  'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.7-Flash', 'Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.8-Max',
  'claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-5',
  'deepseek/deepseek-v4-flash-vision-exp',
  'google/gemini-3.5-flash', 'google/gemini-3.6-flash', 'gpt-5.4', 'gpt-5.5',
])

const KNOWN_PLANS = {
  'Qwen/Qwen3.8-Flash': 'go',
  'Qwen/Qwen3.8-27B': 'go',
  'deepseek/deepseek-v4-flash': 'go',
  'minimax/minimax-m3-free': 'go',
  'moonshotai/Kimi-K2.5': 'go',
}
const PLAN_LABELS = { go: 'Go', pro: 'Pro', provider: 'Provider' }
const PLAN_ORDER = { go: 0, pro: 1, provider: 2 }

const KNOWN_SUBSCRIPTION_PLANS = {
  'individual-free': { name: 'Free', monthlyCredits: 0 },
  'individual-go': { name: 'Go', monthlyCredits: 5 },
  'individual-pro': { name: 'Pro', monthlyCredits: 50 },
  'individual-pro-annual': { name: 'Pro (Annual)', monthlyCredits: 50 },
}

export const PLUGIN_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const strVal = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined)
const numVal = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const recordOrEmpty = (v) => (isRecord(v) ? v : {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...args) {
  const out = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  process.stderr.write(`[zcode-commandcode-private] ${out}\n`)
}

function readEnvInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---------------------------------------------------------------------------
// Structured errors (ported from src/errors.ts)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  RATE_LIMIT: 'RATE_LIMIT',
  MODEL_NOT_IN_PLAN: 'MODEL_NOT_IN_PLAN',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PROVIDER_PROTOCOL_ERROR: 'PROVIDER_PROTOCOL_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  STREAM_IDLE_TIMEOUT: 'STREAM_IDLE_TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
  CATALOG_UNAVAILABLE: 'CATALOG_UNAVAILABLE',
  BLOCKED_HOST: 'BLOCKED_HOST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
}

export class CommandCodeError extends Error {
  constructor(code, message, context = {}, cause) {
    super(message)
    this.name = 'CommandCodeError'
    this.code = code
    this.context = context
    if (cause) this.cause = cause
  }
  hint() {
    switch (this.code) {
      case ErrorCode.MISSING_CREDENTIAL:
        return 'Set COMMANDCODE_API_KEY (or COMMANDCODE_ACCOUNTS) in the environment, or run `command-code login` so ~/.commandcode/auth.json exists.'
      case ErrorCode.INVALID_CREDENTIAL:
        return 'The API key is expired or revoked; re-run `command-code login` or paste a new key.'
      case ErrorCode.RATE_LIMIT:
        return 'The 5-hour usage window is exhausted; wait for reset (see commandcode_usage) or add another account for rotation.'
      case ErrorCode.MODEL_NOT_IN_PLAN:
        return 'The model is above your subscription tier; enable on-demand credits or upgrade the plan.'
      case ErrorCode.MODEL_NOT_FOUND:
        return 'Run commandcode_models with force=true to refresh the catalog and pick a listed model id.'
      case ErrorCode.REQUEST_TIMEOUT:
      case ErrorCode.STREAM_IDLE_TIMEOUT:
        return 'Increase COMMANDCODE_REQUEST_TIMEOUT_MS / COMMANDCODE_STREAM_IDLE_TIMEOUT_MS, or check network stability.'
      case ErrorCode.NETWORK_ERROR:
        return 'Check connectivity to the Command Code API base URL.'
      case ErrorCode.BLOCKED_HOST:
        return 'The configured API base must be a public http(s) host; private/loopback addresses are blocked for safety.'
      default:
        return 'Retry the request; if it persists, inspect commandcode_status diagnostics.'
    }
  }
  toJSON() {
    return { code: this.code, message: this.message, context: this.context, hint: this.hint() }
  }
}

function httpError(status, bodyText, context = {}, retryAfterMs) {
  const err = new CommandCodeError(
    status === 401 || status === 403 ? ErrorCode.INVALID_CREDENTIAL
      : status === 429 ? ErrorCode.RATE_LIMIT
      : status === 404 ? ErrorCode.MODEL_NOT_FOUND
      : status >= 500 ? ErrorCode.SERVER_ERROR
      : ErrorCode.NETWORK_ERROR,
    `Command Code API returned HTTP ${status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`,
    { ...context, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  )
  err.retryAfterMs = retryAfterMs
  return err
}

// ---------------------------------------------------------------------------
// SSRF guard: only public http(s) hosts are allowed (Mimosa security rule)
// ---------------------------------------------------------------------------

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]
const BLOCKED_V6 = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
]

function ipToBits6(ip) {
  const dbl = ip.indexOf('::')
  let head = [], tail = []
  if (dbl >= 0) {
    head = ip.slice(0, dbl).split(':').filter(Boolean)
    tail = ip.slice(dbl + 2).split(':').filter(Boolean)
  } else {
    head = ip.split(':').filter(Boolean)
  }
  const pad = 8 - head.length - tail.length
  const groups = [...head, ...Array(Math.max(pad, 0)).fill('0'), ...tail]
  let out = ''
  for (const g of groups) out += (g || '0').padStart(4, '0')
  return out
}

function ipInCidr(ip, [net, prefixRaw]) {
  const prefix = Number(prefixRaw)
  if (net.includes(':') !== ip.includes(':')) return false
  if (net.includes(':')) {
    return ipToBits6(ip).slice(0, prefix) === ipToBits6(net).slice(0, prefix)
  }
  const pa = ip.split('.').map(Number)
  const pb = net.split('.').map(Number)
  const fullBytes = Math.floor(prefix / 8)
  for (let i = 0; i < 4; i++) {
    if (i < fullBytes) { if (pa[i] !== pb[i]) return false }
    else if (prefix % 8 !== 0 && i === fullBytes) {
      const mask = 0xff << (8 - (prefix % 8))
      if ((pa[i] & mask) !== (pb[i] & mask)) return false
    }
  }
  return true
}

function isPrivateIp(ip) {
  for (const cidr of BLOCKED_V4) if (ipInCidr(ip, cidr)) return true
  for (const cidr of BLOCKED_V6) if (ipInCidr(ip, cidr)) return true
  return false
}

async function assertPublicHttpUrl(rawUrl, context = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new CommandCodeError(ErrorCode.BLOCKED_HOST, `Invalid URL: ${rawUrl}`, context)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CommandCodeError(ErrorCode.BLOCKED_HOST,
      `Only http/https is allowed, got ${url.protocol}`, context)
  }
  if (process.env.COMMANDCODE_ALLOW_PRIVATE === '1') return url
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new CommandCodeError(ErrorCode.BLOCKED_HOST, `Host "${host}" is a private/loopback name`, context)
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) {
      throw new CommandCodeError(ErrorCode.BLOCKED_HOST, `Host "${host}" is a private/reserved IP`, context)
    }
  }
  // Resolve DNS and validate every answer so a public name cannot resolve
  // into a private network.
  try {
    const answers = await dnsLookup(host, { all: true, verbatim: true })
    for (const a of answers) {
      if (isPrivateIp(a.address)) {
        throw new CommandCodeError(ErrorCode.BLOCKED_HOST,
          `Host "${host}" resolves to private/reserved address ${a.address}`, context)
      }
    }
  } catch (err) {
    if (err instanceof CommandCodeError) throw err
    throw new CommandCodeError(ErrorCode.NETWORK_ERROR, `DNS lookup failed for "${host}": ${err.message}`, context)
  }
  return url
}

// ---------------------------------------------------------------------------
// Fetch wrapper: SSRF guard + first-byte timeout + retry with jittered backoff
// ---------------------------------------------------------------------------

const maxRetries = readEnvInt('COMMANDCODE_MAX_RETRIES', 3)

async function doFetch(url, init, { timeoutMs, context = {} }) {
  const urlObj = await assertPublicHttpUrl(url, context)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new CommandCodeError(
    ErrorCode.REQUEST_TIMEOUT, `Request timed out after ${timeoutMs}ms`, context)), timeoutMs)
  try {
    return await fetch(urlObj, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithRetry(url, init, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? readEnvInt('COMMANDCODE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS)
  const context = opts.context ?? {}
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await doFetch(url, init, { timeoutMs, context })
      if (response.ok) return response
      const bodyText = await response.text().catch(() => '')
      const retryAfter = response.headers.get('retry-after')
      const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined
      const err = httpError(response.status, bodyText, context, retryAfterMs)
      const code = err.code
      const rotatable = response.status === 429 || response.status === 401 || response.status === 403
      if (rotatable && opts.onRejection) {
        const next = await opts.onRejection(response.status === 429 ? 'rate-limit' : 'invalid-credential')
        if (next !== undefined && next !== opts.currentKey) {
          opts.currentKey = next
          const headers = { ...init.headers, authorization: `Bearer ${next}` }
          init = { ...init, headers }
          continue // rotate immediately, no backoff
        }
      }
      if (NON_RETRYABLE_CODES.has(code) || response.status === 304 || code === ErrorCode.INVALID_CREDENTIAL) throw err
      lastErr = err
    } catch (err) {
      if (err instanceof CommandCodeError && err.name === 'CommandCodeError') {
        if (err.code === ErrorCode.REQUEST_TIMEOUT || err.code === ErrorCode.NETWORK_ERROR ||
            err.code === ErrorCode.SERVER_ERROR || err.code === ErrorCode.RATE_LIMIT) {
          lastErr = err
        } else {
          throw err
        }
      } else {
        lastErr = new CommandCodeError(ErrorCode.NETWORK_ERROR, `${err?.message ?? err}`, context, err)
      }
    }
    if (attempt < maxRetries) {
      const wait = err => err?.retryAfterMs ?? Math.floor(
        Math.min(500 * 2 ** attempt, 15 * 60 * 1000) * Math.random())
      await sleep(wait(lastErr))
    }
  }
  throw lastErr ?? new CommandCodeError(ErrorCode.NETWORK_ERROR, 'request failed', context)
}

// ---------------------------------------------------------------------------
// Circuit breaker (ported from src/retry.ts)
// ---------------------------------------------------------------------------

class CircuitBreaker {
  constructor(threshold, cooldownMs) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.failures = 0
    this.openedAt = 0
  }
  get isOpen() {
    return this.failures >= this.threshold && Date.now() - this.openedAt < this.cooldownMs
  }
  recordSuccess() { this.failures = 0; this.openedAt = 0 }
  recordFailure() {
    this.failures += 1
    if (this.failures === this.threshold) this.openedAt = Date.now()
  }
  get state() {
    if (this.failures < this.threshold) return 'closed'
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
  }
}

// ---------------------------------------------------------------------------
// Credentials & multi-account pool (ported from src/accounts.ts)
// ---------------------------------------------------------------------------

function resolveAuthFileApiKey() {
  const authPath = join(homedir(), '.commandcode', 'auth.json')
  if (!existsSync(authPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (!isRecord(parsed)) return undefined
    const direct = strVal(parsed.key) ?? strVal(parsed.apiKey) ?? strVal(parsed.access_token)
    if (direct) return direct
    if (isRecord(parsed.credentials)) return strVal(parsed.credentials.key) ?? strVal(parsed.credentials.apiKey)
    if (isRecord(parsed.commandcode)) return strVal(parsed.commandcode.key) ?? strVal(parsed.commandcode.apiKey)
    return undefined
  } catch { return undefined }
}

function buildSlots() {
  const slots = [{
    id: 'default',
    label: 'Default',
    envVar: process.env.COMMANDCODE_API_KEY_ENV ?? 'COMMANDCODE_API_KEY',
    allowAuthFile: true,
  }]
  let accounts = []
  const raw = process.env.COMMANDCODE_ACCOUNTS
  if (raw && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) accounts = parsed
    } catch (err) {
      log('warning: COMMANDCODE_ACCOUNTS is not valid JSON, ignoring:', err.message)
    }
  }
  accounts.forEach((account, i) => {
    if (!isRecord(account)) return
    const envVar = strVal(account.apiKeyEnv)?.trim()
    const apiKey = strVal(account.apiKey)
    if (!envVar && !apiKey) return
    slots.push({
      id: envVar ?? `account-${i + 2}`,
      label: strVal(account.label)?.trim() ?? `Account ${i + 2}`,
      envVar,
      literal: apiKey,
      allowAuthFile: false,
    })
  })
  return slots
}

class AccountPool {
  constructor() {
    this.states = new Map() // key -> {kind, ...}
    this.probeInflight = undefined
  }
  async resolveSlotKey(slot) {
    if (slot.literal) return slot.literal
    if (slot.envVar && process.env[slot.envVar]) return process.env[slot.envVar]
    if (slot.allowAuthFile) return resolveAuthFileApiKey()
    return undefined
  }
  isUsable(state) {
    if (!state || state.kind === 'ok') return true
    if (state.kind === 'cooldown') return Date.now() >= state.until
    return false
  }
  async resolveKey({ exclude } = {}) {
    const slots = buildSlots()
    const resolved = (await Promise.all(slots.map(async (slot) => {
      const key = await this.resolveSlotKey(slot)
      if (!key) return undefined
      return { slot, key, state: this.states.get(key) }
    }))).filter(Boolean)
    let usable = resolved.filter((r) => this.isUsable(r.state))
    if (usable.length === 0 && resolved.length > 0) {
      await this.probeAllWindows(resolved)
      usable = resolved.filter((r) => this.isUsable(this.states.get(r.key)))
    }
    const candidates = exclude ? usable.filter((r) => r.key !== exclude) : usable
    return candidates[0]
  }
  markRejected(key, rejection) {
    if (rejection === 'invalid-credential') {
      this.states.set(key, { kind: 'disabled', rejection })
    } else {
      this.states.set(key, { kind: 'cooldown', rejection, until: Date.now() + 5 * 60 * 1000 })
    }
  }
  async probeAllWindows(accounts) {
    if (this.probeInflight) { await this.probeInflight; return }
    this.probeInflight = (async () => {
      await Promise.all(accounts.map(async (account) => {
        const state = this.states.get(account.key)
        if (!state || state.kind === 'ok') return
        try {
          const result = await probeFiveHourWindow(config.apiBase, account.key)
          if (!result) return
          if (!result.exceeded) this.states.set(account.key, { kind: 'ok' })
          else if (state.kind === 'cooldown') {
            this.states.set(account.key, {
              kind: 'cooldown', rejection: state.rejection,
              until: result.resetAt > 0 ? result.resetAt : state.until,
            })
          }
        } catch { /* leave state unchanged */ }
      }))
    })()
    try { await this.probeInflight } finally { this.probeInflight = undefined }
  }
  async describe() {
    const slots = buildSlots()
    return (await Promise.all(slots.map(async (slot) => {
      const key = await this.resolveSlotKey(slot)
      if (!key) return { id: slot.id, label: slot.label, configured: false, active: false, state: 'unconfigured' }
      const state = this.states.get(key)
      return {
        id: slot.id, label: slot.label, configured: true,
        keyFingerprint: `${key.slice(0, 6)}…${key.slice(-4)}`,
        state: !state || state.kind === 'ok' ? 'ok'
          : state.kind === 'cooldown' ? `cooldown until ${new Date(state.until).toISOString()}`
          : 'disabled',
      }
    })))
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
  get apiBase() { return (process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '') },
  get modelsCachePath() { return process.env.COMMANDCODE_MODELS_CACHE_PATH ?? DEFAULT_MODELS_CACHE_PATH },
  get filterModelsByPlan() { return process.env.COMMANDCODE_FILTER_MODELS_BY_PLAN !== '0' },
  get streamIdleTimeoutMs() { return readEnvInt('COMMANDCODE_STREAM_IDLE_TIMEOUT_MS', DEFAULT_STREAM_IDLE_TIMEOUT_MS) },
}

const pool = new AccountPool()

async function currentAccount({ exclude } = {}) {
  const account = await pool.resolveKey({ exclude })
  if (!account) {
    throw new CommandCodeError(ErrorCode.MISSING_CREDENTIAL,
      'No Command Code API key configured', { slots: buildSlots().map((s) => s.id) })
  }
  return account
}

// ---------------------------------------------------------------------------
// Model catalog: SWR + on-disk cache + ETag + circuit breaker (src/catalog.ts)
// ---------------------------------------------------------------------------

function parseCatalogResponse(value) {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new CommandCodeError(ErrorCode.PROVIDER_PROTOCOL_ERROR,
      'Unexpected Command Code models response shape: expected { object: "list", data: [...] }')
  }
  const models = []
  for (const entry of value.data) {
    if (!isRecord(entry)) continue
    const id = strVal(entry.id)
    const name = strVal(entry.name) ?? strVal(entry.id) ?? 'Unknown'
    const contextLength = numVal(entry.context_length) ?? numVal(entry.contextWindow)
    if (!id || !contextLength || contextLength <= 0) continue
    models.push({ id, name, contextWindow: contextLength, maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS) })
  }
  if (models.length === 0) {
    throw new CommandCodeError(ErrorCode.CATALOG_UNAVAILABLE, 'Models endpoint returned an empty catalog')
  }
  return models
}

async function readModelsCache(cachePath) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf-8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined
    return {
      models: parsed.models,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
    }
  } catch { return undefined }
}

async function writeModelsCache(cachePath, cache) {
  const dir = cachePath.replace(/[\\/][^\\/]+$/, '')
  await mkdir(dir, { recursive: true }).catch(() => {})
  const tmp = `${cachePath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  await rename(tmp, cachePath).catch(async () => {
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
    await rm(tmp, { force: true })
  })
}

const catalogBreaker = new CircuitBreaker(CATALOG_CIRCUIT_THRESHOLD, CATALOG_CIRCUIT_COOLDOWN_MS)
const catalog = {
  memory: [],
  fetchedAt: 0,
  etag: undefined,
  refreshInFlight: undefined,
  get isFresh() { return this.memory.length > 0 && Date.now() - this.fetchedAt < CATALOG_TTL_MS },
  get isStaleAcceptable() { return this.memory.length > 0 && Date.now() - this.fetchedAt < CATALOG_STALE_MS },
  get state() {
    return {
      count: this.memory.length,
      fetchedAt: this.fetchedAt,
      fresh: this.isFresh,
      circuit: catalogBreaker.state,
      cachePath: config.modelsCachePath,
    }
  },
  async list({ force = false } = {}) {
    if (!force && this.isFresh) return this.memory
    if (!force && this.isStaleAcceptable) { this.scheduleRefresh(); return this.memory }

    if (!force) {
      const disk = await readModelsCache(config.modelsCachePath)
      if (disk && disk.models.length > 0) {
        this.memory = disk.models
        this.fetchedAt = disk.fetchedAt
        this.etag = disk.etag
        if (Date.now() - disk.fetchedAt < CATALOG_TTL_MS) return this.memory
        this.scheduleRefresh()
        return this.memory
      }
    }
    return this.refresh({ blocking: true, force })
  },
  async find(modelId) {
    let hit = this.memory.find((m) => m.id === modelId)
    if (hit) return hit
    await this.list().catch(() => {})
    return this.memory.find((m) => m.id === modelId)
  },
  scheduleRefresh() {
    if (this.refreshInFlight) return
    this.refreshInFlight = this.refresh({ blocking: false })
      .catch(() => {})
      .finally(() => { this.refreshInFlight = undefined })
  },
  async refresh({ blocking, force = false }) {
    if (!force && catalogBreaker.isOpen) {
      if (this.memory.length > 0) return this.memory
      const err = new CommandCodeError(ErrorCode.CATALOG_UNAVAILABLE,
        `Model catalog circuit breaker is open (${catalogBreaker.state}); no cache available`,
        { endpoint: `${config.apiBase}/provider/v1/models` })
      if (blocking) throw err
      return this.memory
    }
    try {
      const headers = { accept: 'application/json' }
      if (this.etag && !force) headers['If-None-Match'] = this.etag
      const response = await doFetch(`${config.apiBase}/provider/v1/models`, { headers },
        { timeoutMs: CATALOG_TIMEOUT_MS, context: { endpoint: '/provider/v1/models' } })
      if (response.status === 304) {
        this.fetchedAt = Date.now()
        catalogBreaker.recordSuccess()
        return this.memory
      }
      if (!response.ok) throw httpError(response.status, '', { endpoint: '/provider/v1/models' })
      const etag = response.headers.get('etag') ?? undefined
      const models = parseCatalogResponse(await response.json())
      this.memory = models
      this.fetchedAt = Date.now()
      this.etag = etag
      catalogBreaker.recordSuccess()
      await writeModelsCache(config.modelsCachePath,
        { models, fetchedAt: this.fetchedAt, etag }).catch(() => {})
      return models
    } catch (error) {
      catalogBreaker.recordFailure()
      const wrapped = error instanceof CommandCodeError ? error
        : new CommandCodeError(ErrorCode.NETWORK_ERROR, `${error?.message ?? error}`,
          { endpoint: '/provider/v1/models' }, error)
      if (this.memory.length > 0) return this.memory
      const disk = await readModelsCache(config.modelsCachePath).catch(() => undefined)
      if (disk && disk.models.length > 0) {
        this.memory = disk.models
        this.fetchedAt = disk.fetchedAt
        return disk.models
      }
      if (blocking) throw wrapped
      return this.memory
    }
  },
}

function modelVisibleInPlan(modelId, access) {
  if (access === undefined) return true // fail open
  const modelPlan = KNOWN_PLANS[modelId]
  if (modelPlan === undefined) return true
  if (access.onDemandCredits > 0) return true
  const userPlanOrder = access.planId === undefined ? 99 : PLAN_ORDER[access.planId] ?? 99
  return userPlanOrder >= PLAN_ORDER[modelPlan]
}

function planLabel(modelId) {
  const plan = KNOWN_PLANS[modelId]
  return plan === undefined ? undefined : PLAN_LABELS[plan]
}

function formatContext(n) {
  return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1_000)}K`
}

function capabilityDescription(modelId, contextWindow) {
  const parts = []
  const plan = planLabel(modelId)
  if (plan) parts.push(plan)
  if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push('Vision')
  if (KNOWN_EFFORTS[modelId]) parts.push('Reasoning')
  if (contextWindow > 0) parts.push(`${formatContext(contextWindow)} ctx`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Usage report (src/usage-remote.ts + adapter.getUsage)
// ---------------------------------------------------------------------------

async function probeFiveHourWindow(apiBase, apiKey) {
  try {
    const response = await doFetch(`${apiBase}/alpha/billing/credits`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    }, { timeoutMs: 10_000, context: { endpoint: '/alpha/billing/credits' } })
    if (!response.ok) return undefined
    const parsed = await response.json()
    const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : parsed
    const fiveHour = isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined
    if (!fiveHour) return undefined
    return { exceeded: fiveHour.exceeded === true, resetAt: numVal(fiveHour.resetAt) ?? 0 }
  } catch { return undefined }
}

async function getUsageReport(apiKey) {
  const report = { failures: [] }
  const failedStatuses = []
  let networkFailures = 0
  const endpoints = [
    { path: '/alpha/whoami', key: 'account' },
    { path: '/alpha/usage/summary', key: 'usage' },
    { path: '/alpha/billing/credits', key: 'credits' },
    { path: '/alpha/billing/subscriptions', key: 'plan' },
  ]
  await Promise.all(endpoints.map(async ({ path, key }) => {
    try {
      const response = await doFetch(`${config.apiBase}${path}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      }, { timeoutMs: 10_000, context: { endpoint: path } })
      if (!response.ok) {
        failedStatuses.push(response.status)
        report.failures.push(`${path}: HTTP ${response.status}`)
        return
      }
      failedStatuses.push(undefined)
      const body = await response.json()
      if (key === 'account') {
        const user = isRecord(body.user) ? body.user : body
        report.account = {
          id: strVal(user.id) ?? '', name: strVal(user.name) ?? '', userName: strVal(user.userName) ?? '',
        }
      } else if (key === 'usage') {
        report.usage = {
          totalCount: numVal(body.totalCount) ?? 0, totalCost: numVal(body.totalCost) ?? 0,
          successRate: numVal(body.successRate) ?? 0, completedCount: numVal(body.completedCount) ?? 0,
          failedCount: numVal(body.failedCount) ?? 0, totalTokensIn: numVal(body.totalTokensIn) ?? 0,
          totalTokensOut: numVal(body.totalTokensOut) ?? 0, totalCredits: numVal(body.totalCredits) ?? 0,
          periodBasis: strVal(body.periodBasis) ?? '',
        }
      } else if (key === 'credits') {
        const creditFields = isRecord(body.credits) ? body.credits : body
        const windowLimits = isRecord(body.windowLimits) ? body.windowLimits : body
        const fh = isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : isRecord(body.fiveHour) ? body.fiveHour : {}
        const wk = isRecord(windowLimits.weekly) ? windowLimits.weekly : isRecord(body.weekly) ? body.weekly : {}
        report.credits = {
          monthlyCredits: numVal(creditFields.monthlyCredits) ?? 0,
          purchasedCredits: numVal(creditFields.purchasedCredits) ?? 0,
          freeCredits: numVal(creditFields.freeCredits) ?? 0,
          fiveHour: { used: numVal(fh.used) ?? 0, cap: numVal(fh.cap) ?? 0, exceeded: fh.exceeded === true, resetAt: numVal(fh.resetAt) ?? 0 },
          weekly: { used: numVal(wk.used) ?? 0, cap: numVal(wk.cap) ?? 0, exceeded: wk.exceeded === true, resetAt: numVal(wk.resetAt) ?? 0 },
        }
      } else if (key === 'plan') {
        const planSource = isRecord(body.data) ? body.data : body
        const planId = strVal(planSource.planId) ?? strVal(planSource.id) ?? ''
        const known = KNOWN_SUBSCRIPTION_PLANS[planId]
        const rawPeriodEnd = planSource.currentPeriodEnd
        report.plan = {
          planId,
          name: known?.name ?? strVal(planSource.name) ?? planId,
          status: strVal(planSource.status) ?? '',
          monthlyCredits: known?.monthlyCredits ?? null,
          currentPeriodEnd: numVal(rawPeriodEnd) ?? (typeof rawPeriodEnd === 'string' ? Date.parse(rawPeriodEnd) || 0 : 0),
        }
      }
    } catch (error) {
      failedStatuses.push(undefined)
      networkFailures += 1
      report.failures.push(`${path}: ${error instanceof CommandCodeError ? error.code : error?.message ?? String(error)}`)
    }
  }))
  const codes = failedStatuses.filter((s) => s !== undefined)
  if (codes.length === endpoints.length && codes.every((c) => c === 401)) report.blocked = 'invalid-key'
  else if (codes.length === endpoints.length && codes.every((c) => c >= 500)) report.blocked = 'service-unavailable'
  else if (networkFailures === endpoints.length) report.blocked = 'network'
  return report
}

// ---------------------------------------------------------------------------
// Streaming generation (adapter.stream wire protocol)
// ---------------------------------------------------------------------------

function parseStreamEventLine(line) {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try { return JSON.parse(trimmed) } catch { return undefined }
}

function mapFinishReason(reason) {
  if (typeof reason === 'string') {
    if (reason === 'length') return 'max-tokens'
    if (reason === 'tool_calls' || reason === 'tool_call') return 'tool-calls'
  }
  return 'stop'
}

function messageToCC(message) {
  const role = message.role
  if (role === 'system') return undefined // caller folds into params.system
  const content = message.content
  if (typeof content === 'string') return { role, content: [{ type: 'text', text: content }] }
  if (Array.isArray(content)) {
    return { role, content: content.map((part) => {
      if (typeof part === 'string') return { type: 'text', text: part }
      if (!isRecord(part)) return { type: 'text', text: String(part) }
      if (part.type === 'tool-call') {
        return { type: 'tool-call', toolCallId: strVal(part.toolCallId) ?? part.id ?? randomUUID(),
          toolName: strVal(part.toolName) ?? part.name ?? '', input: recordOrEmpty(part.input ?? part.arguments) }
      }
      if (part.type === 'tool-result') {
        const value = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? part.output ?? '')
        return { type: 'tool-result', toolCallId: strVal(part.toolCallId) ?? '', toolName: strVal(part.toolName) ?? 'unknown',
          output: part.isError === true ? { type: 'error-text', value } : { type: 'text', value } }
      }
      return { type: 'text', text: strVal(part.text) ?? JSON.stringify(part) }
    }) }
  }
  return { role, content: [{ type: 'text', text: String(content ?? '') }] }
}

async function* streamGenerate({ model, messages, system, maxTokens, temperature, reasoningEffort, tools }) {
  const account = await currentAccount()
  const entry = await catalog.find(model)
  const modelMax = entry?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const resolvedMax = Math.min(maxTokens ?? modelMax, modelMax, GENERATE_MAX_TOKENS_CAP)
  const supported = KNOWN_EFFORTS[model]
  const effort = reasoningEffort && reasoningEffort !== 'off' && supported?.includes(reasoningEffort)
    ? reasoningEffort : undefined

  const body = {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}, zcode-commandcode-private`,
      structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [],
    },
    memory: null, taste: null, skills: null,
    params: {
      model,
      messages: messages.map(messageToCC).filter(Boolean),
      tools: Array.isArray(tools) ? tools : [],
      system: system ?? '',
      max_tokens: resolvedMax,
      temperature: numVal(temperature) ?? 1,
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
    },
    threadId: randomUUID(),
  }

  const requestTimeoutMs = readEnvInt('COMMANDCODE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS)
  let key = account.key
  const tried = new Set()
  let response

  while (true) {
    tried.add(key)
    try {
      response = await doFetch(`${config.apiBase}/alpha/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          accept: 'text/event-stream',
          'x-command-code-version': COMMAND_CODE_CLI_VERSION,
        },
        body: JSON.stringify(body),
      }, { timeoutMs: requestTimeoutMs, context: { model, endpoint: '/alpha/generate' } })
      if (response.ok) break
      const errText = await response.text().catch(() => '')
      const status = response.status
      if (status === 429 || status === 401 || status === 403) {
        pool.markRejected(key, status === 429 ? 'rate-limit' : 'invalid-credential')
        const nextAccount = await pool.resolveKey({ exclude: key })
        if (nextAccount && !tried.has(nextAccount.key)) { key = nextAccount.key; continue }
      }
      throw httpError(status, errText, { model, endpoint: '/alpha/generate' })
    } catch (error) {
      if (error instanceof CommandCodeError) throw error
      throw new CommandCodeError(ErrorCode.NETWORK_ERROR, `${error?.message ?? error}`,
        { model, endpoint: '/alpha/generate' }, error)
    }
  }

  if (!response.body) {
    throw new CommandCodeError(ErrorCode.PROVIDER_PROTOCOL_ERROR, 'Command Code API returned no response body', { model })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idleTimer
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => reader.cancel().catch(() => {}), config.streamIdleTimeoutMs)
  }
  resetIdle()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseStreamEventLine(line)
        if (event !== undefined) yield event
      }
    }
    if (buffer.trim()) {
      const event = parseStreamEventLine(buffer)
      if (event !== undefined) yield event
    }
  } catch (error) {
    if (error instanceof CommandCodeError) throw error
    if (error?.name === 'AbortError') {
      throw new CommandCodeError(ErrorCode.STREAM_IDLE_TIMEOUT,
        `Stream idle for more than ${config.streamIdleTimeoutMs}ms`, { model }, error)
    }
    throw new CommandCodeError(ErrorCode.NETWORK_ERROR, `${error?.message ?? error}`, { model }, error)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    reader.cancel().catch(() => {})
  }
}

async function generateText(args) {
  const result = {
    model: args.model,
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: undefined,
    finishReason: 'stop',
    events: args.includeEvents === true ? [] : undefined,
  }
  let sawFinish = false
  for await (const event of streamGenerate(args)) {
    if (!isRecord(event)) continue
    if (result.events) result.events.push(event)
    switch (event.type) {
      case 'text-delta': result.text += strVal(event.text) ?? ''; break
      case 'reasoning-delta': result.reasoning += strVal(event.text) ?? ''; break
      case 'tool-call':
        result.toolCalls.push({
          id: strVal(event.toolCallId) ?? randomUUID(),
          name: strVal(event.toolName) ?? '',
          arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
        })
        break
      case 'finish': {
        sawFinish = true
        result.finishReason = mapFinishReason(event.finishReason)
        const usage = recordOrEmpty(event.usage)
        const details = recordOrEmpty(usage.inputTokenDetails)
        result.usage = {
          inputTokens: numVal(usage.inputTokens) ?? 0,
          outputTokens: numVal(usage.outputTokens) ?? 0,
          cacheReadTokens: numVal(details.cacheReadTokens) ?? 0,
        }
        break
      }
      case 'error':
        throw new CommandCodeError(ErrorCode.PROVIDER_PROTOCOL_ERROR,
          strVal(event.message) ?? 'Command Code stream error', { model: args.model, endpoint: '/alpha/generate' })
      default: break
    }
  }
  if (!sawFinish) result.finishReason = 'stop'
  return result
}

// ---------------------------------------------------------------------------
// Shared tool-level operations (MCP tools & dashboard API both use these)
// ---------------------------------------------------------------------------

export async function listModels({ force = false, filterByPlan } = {}) {
  const models = await catalog.list({ force })
  let access
  if (config.filterModelsByPlan && filterByPlan !== false) {
    try {
      const account = await currentAccount()
      const report = await getUsageReport(account.key)
      access = {
        planId: report.plan?.planId,
        onDemandCredits: report.credits?.purchasedCredits ?? 0,
      }
    } catch { access = undefined } // fail open
  }
  const visible = models
    .filter((m) => modelVisibleInPlan(m.id, access))
    .sort((a, b) => {
      const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ''] ?? 99
      const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ''] ?? 99
      return pa !== pb ? pa - pb : a.id.localeCompare(b.id)
    })
    .map((m) => ({
      id: m.id, name: m.name,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens,
      contextLabel: formatContext(m.contextWindow),
      plan: planLabel(m.id), vision: KNOWN_IMAGE_MODELS.has(m.id),
      reasoningEfforts: KNOWN_EFFORTS[m.id],
    }))
  return { catalog: catalog.state, planFiltered: access !== undefined, total: visible.length, models: visible }
}

export async function generate(args) {
  if (!isRecord(args) || typeof args.model !== 'string' || !Array.isArray(args.messages)) {
    throw new CommandCodeError(ErrorCode.UNSUPPORTED_OPTION,
      'generate requires "model" (string) and "messages" (array)')
  }
  return generateText(args)
}

export async function usageReport() {
  const account = await currentAccount()
  const report = await getUsageReport(account.key)
  const accounts = await pool.describe()
  return { activeAccount: account.slot.id, accounts, report }
}

export async function statusInfo() {
  const authFile = resolveAuthFileApiKey() !== undefined
  return {
    plugin: 'zcode-commandcode-private',
    apiBase: config.apiBase,
    catalog: catalog.state,
    accounts: await pool.describe(),
    authFilePresent: authFile,
    env: {
      apiKeyEnv: process.env.COMMANDCODE_API_KEY_ENV ?? 'COMMANDCODE_API_KEY',
      apiKeySet: Boolean(process.env.COMMANDCODE_API_KEY),
      accountsJsonSet: Boolean(process.env.COMMANDCODE_ACCOUNTS),
      requestTimeoutMs: readEnvInt('COMMANDCODE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      filterModelsByPlan: config.filterModelsByPlan,
      maxRetries,
    },
  }
}

export { config, pool, catalog, log }
