#!/usr/bin/env node
/**
 * Debug/acceptance suite for zcode-commandcode-private.
 * Spawns the MCP server as a subprocess and drives it over stdio JSON-RPC,
 * including against a local mock Command Code API (requires the server's
 * COMMANDCODE_ALLOW_PRIVATE=1 test escape hatch).
 *
 * Usage: node test/run-tests.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(PLUGIN_ROOT, 'mcp', 'server.mjs')
const MOCK_PORT = 18321
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
// Mock Command Code API
// ---------------------------------------------------------------------------

let generateRequests = []
let catalogHits = 0

const mockServer = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8')
    const url = new URL(req.url, MOCK_BASE)
    const auth = req.headers.authorization ?? ''
    const key = auth.replace(/^Bearer\s+/i, '')
    res.setHeader('content-type', 'application/json')

    if (url.pathname === '/provider/v1/models') {
      catalogHits++
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'Qwen/Qwen3.8-Flash', name: 'Qwen 3.8 Flash', context_length: 131072 },
          { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', context_length: 200000 },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000 },
          { id: 'bad-entry' }, // no context_length -> dropped
        ],
      }))
      return
    }
    if (url.pathname === '/alpha/whoami') {
      if (!key || key === 'expired-key') { res.statusCode = key ? 401 : 401; res.end(JSON.stringify({ error: 'bad key' })); return }
      res.end(JSON.stringify({ success: true, user: { id: 'u1', name: 'Tester', userName: 'tester' } }))
      return
    }
    if (url.pathname === '/alpha/usage/summary') {
      if (key === 'expired-key') { res.statusCode = 401; res.end('{}'); return }
      res.end(JSON.stringify({ totalCount: 12, totalCost: 0.5, successRate: 0.98, completedCount: 11, failedCount: 1, totalTokensIn: 1000, totalTokensOut: 2000, totalCredits: 3, periodBasis: 'day' }))
      return
    }
    if (url.pathname === '/alpha/billing/credits') {
      if (key === 'expired-key') { res.statusCode = 401; res.end('{}'); return }
      if (key === 'tired-key') {
        res.end(JSON.stringify({ credits: { monthlyCredits: 50, purchasedCredits: 0, freeCredits: 2 }, windowLimits: { fiveHour: { used: 50, cap: 50, exceeded: true, resetAt: Date.now() + 3600_000 }, weekly: { used: 60, cap: 200, exceeded: false, resetAt: 0 } } }))
        return
      }
      res.end(JSON.stringify({ credits: { monthlyCredits: 50, purchasedCredits: 10, freeCredits: 2 }, windowLimits: { fiveHour: { used: 8, cap: 50, exceeded: false, resetAt: 0 }, weekly: { used: 60, cap: 200, exceeded: false, resetAt: 0 } } }))
      return
    }
    if (url.pathname === '/alpha/billing/subscriptions') {
      if (key === 'expired-key') { res.statusCode = 401; res.end('{}'); return }
      res.end(JSON.stringify({ success: true, data: { planId: 'individual-go', status: 'active', currentPeriodEnd: new Date().toISOString() } }))
      return
    }
    if (url.pathname === '/alpha/generate') {
      generateRequests.push({ key, body: JSON.parse(body || '{}') })
      // Rotation drill: first key gets 429, second key gets 401, third works.
      if (key === 'tired-key') { res.statusCode = 429; res.setHeader('retry-after', '0'); res.end(JSON.stringify({ error: 'rate limited' })); return }
      if (key === 'expired-key') { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid' })); return }
      res.setHeader('content-type', 'text/event-stream')
      res.write(JSON.stringify({ type: 'reasoning-start' }) + '\n')
      res.write(JSON.stringify({ type: 'reasoning-delta', text: 'thinking' }) + '\n')
      res.write(JSON.stringify({ type: 'reasoning-end' }) + '\n')
      res.write(JSON.stringify({ type: 'text-delta', text: 'Hello' }) + '\n')
      res.write(JSON.stringify({ type: 'text-delta', text: ', world!' }) + '\n')
      res.write(JSON.stringify({ type: 'tool-call', toolCallId: 'tc1', toolName: 'read_file', input: { path: 'a.txt' } }) + '\n')
      res.write(JSON.stringify({ type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 } } }) + '\n')
      res.end()
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
})

// ---------------------------------------------------------------------------
// MCP test client
// ---------------------------------------------------------------------------

class McpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buffer = ''
    this.stderr = ''
    this.proc.stderr.on('data', (c) => { this.stderr += c })
    this.pending = new Map()
    this.nextId = 1
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let nl
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg)
            this.pending.delete(msg.id)
          }
        } catch { /* ignore */ }
      }
    })
  }
  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async initialize() {
    const res = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    return res
  }
  tool(name, args) { return this.request('tools/call', { name, arguments: args ?? {} }) }
  toolData(name, args) {
    return this.tool(name, args).then((res) => {
      if (res.error) throw new Error(`RPC error: ${JSON.stringify(res.error)}`)
      const text = res.result.content[0].text
      return { raw: res.result, data: JSON.parse(text), isError: res.result.isError === true }
    })
  }
  kill() { this.proc.kill(); return new Promise((r) => this.proc.on('exit', r)) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function withEnv(env, fn) {
  const client = new McpClient(env)
  try { await fn(client) } finally { await client.kill() }
}

const tmp = await mkdtemp(join(tmpdir(), 'ccplug-'))
const cachePath = join(tmp, 'models-cache.json')

await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r))
console.log(`mock API on ${MOCK_BASE}\n`)

const BASE_ENV = {
  COMMANDCODE_API_BASE: MOCK_BASE,
  COMMANDCODE_ALLOW_PRIVATE: '1',
  COMMANDCODE_MODELS_CACHE_PATH: cachePath,
  COMMANDCODE_API_KEY: 'good-key',
  COMMANDCODE_ACCOUNTS: JSON.stringify([
    { label: 'Tired', apiKeyEnv: 'CC_KEY_TIRED' },
    { label: 'Expired', apiKey: 'expired-key' },
  ]),
  CC_KEY_TIRED: 'tired-key',
}

console.log('== 1. MCP handshake & tools/list ==')
await withEnv(BASE_ENV, async (client) => {
  const init = await client.initialize()
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'zcode-commandcode-private', JSON.stringify(init.result))
  const list = await client.request('tools/list', {})
  const names = list.result.tools.map((t) => t.name)
  check('four tools listed', ['commandcode_models', 'commandcode_generate', 'commandcode_usage', 'commandcode_status'].every((n) => names.includes(n)), names.join(','))
  check('tools have inputSchema', list.result.tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'))
  const ping = await client.request('ping', {})
  check('ping ok', !ping.error)
})

console.log('\n== 2. commandcode_status ==')
await withEnv(BASE_ENV, async (client) => {
  await client.initialize()
  const { data, isError } = await client.toolData('commandcode_status')
  check('status ok, not error', isError === false)
  check('apiBase echoed', data.apiBase === MOCK_BASE)
  check('3 accounts configured', Array.isArray(data.accounts) && data.accounts.length === 3, JSON.stringify(data.accounts))
  check('default account from env key', data.accounts.some((a) => a.id === 'default' && a.configured && a.keyFingerprint?.startsWith('good-k')))
  check('env account slot resolved', data.accounts.some((a) => a.label === 'Tired' && a.configured))
  check('literal key slot resolved', data.accounts.some((a) => a.label === 'Expired' && a.configured))
})

console.log('\n== 3. commandcode_models (catalog parse + SWR cache) ==')
await withEnv(BASE_ENV, async (client) => {
  await client.initialize()
  const { data } = await client.toolData('commandcode_models')
  check('malformed entry dropped, 3 models', data.total === 3, `got ${data.total}`)
  check('qwen model has plan Go + efforts', data.models.some((m) => m.id === 'Qwen/Qwen3.8-Flash' && m.plan === 'Go' && Array.isArray(m.reasoningEfforts)))
  check('glm model has efforts but no plan mapping (parity with registry)', data.models.some((m) => m.id === 'z-ai/glm-5.3-flash' && m.plan === undefined && Array.isArray(m.reasoningEfforts)))
  check('sorted by plan (Go tier first)', data.models[0].id === 'Qwen/Qwen3.8-Flash', data.models.map((m) => m.id).join(','))
  check('context formatted', data.models.some((m) => m.id === 'claude-sonnet-5'))
  const cacheRaw = await readFile(cachePath, 'utf-8').catch(() => '')
  check('on-disk cache written', cacheRaw.includes('"models"'))
  const again = await client.toolData('commandcode_models')
  check('second call served from cache', again.data.catalog.fresh === true, JSON.stringify(again.data.catalog))
})

console.log('\n== 4. commandcode_usage (multi-account + degraded endpoints) ==')
await withEnv(BASE_ENV, async (client) => {
  await client.initialize()
  const { data } = await client.toolData('commandcode_usage')
  check('active account is default', data.activeAccount === 'default', data.activeAccount)
  check('account identity parsed', data.report.account?.userName === 'tester')
  check('usage numbers parsed', data.report.usage?.totalCount === 12)
  check('credits windows parsed', data.report.credits?.fiveHour?.used === 8 && data.report.credits?.fiveHour?.cap === 50)
  check('plan resolved with monthly credits', data.report.plan?.planId === 'individual-go' && data.report.plan?.monthlyCredits === 5)
  check('not blocked (>=1 endpoint ok)', data.report.blocked === undefined)
})

console.log('\n== 5. Rotation: 429 -> next key; 401 -> skip to working key ==')
generateRequests = []
await withEnv({
  ...BASE_ENV,
  COMMANDCODE_API_KEY: 'tired-key', // default slot starts rate-limited
  COMMANDCODE_ACCOUNTS: JSON.stringify([
    { label: 'Expired', apiKey: 'expired-key' },
    { label: 'Good', apiKey: 'good-key' },
  ]),
}, async (client) => {
  await client.initialize()
  const { data } = await client.toolData('commandcode_generate', {
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'low',
  })
  const keysTried = generateRequests.map((r) => r.key)
  check('rotation tried tired-key(429) -> expired-key(401) -> good-key(200)',
    keysTried.join('->') === 'tired-key->expired-key->good-key',
    keysTried.join(' -> '))
  check('aggregated text', data.text === 'Hello, world!', JSON.stringify(data.text))
  check('reasoning captured', data.reasoning === 'thinking')
  check('tool call parsed', data.toolCalls?.[0]?.name === 'read_file' && data.toolCalls[0].arguments.path === 'a.txt')
  check('finishReason mapped to tool-calls', data.finishReason === 'tool-calls', data.finishReason)
  check('usage parsed incl. cache read', data.usage?.inputTokens === 10 && data.usage?.outputTokens === 5 && data.usage?.cacheReadTokens === 3)
  check('reasoning_effort forwarded when supported', generateRequests.at(-1)?.body?.params?.reasoning_effort === 'low')
  check('wire body has config/params/threadId', ['config', 'params', 'threadId'].every((k) => k in (generateRequests.at(-1)?.body ?? {})))
})

console.log('\n== 6. All accounts rejected -> structured error with hint ==')
await withEnv({ ...BASE_ENV, COMMANDCODE_API_KEY: 'expired-key', COMMANDCODE_ACCOUNTS: '' }, async (client) => {
  await client.initialize()
  const { raw } = await client.toolData('commandcode_generate', { model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] })
  check('isError set', raw.isError === true)
  const err = JSON.parse(raw.content[0].text)
  check('stable INVALID_CREDENTIAL code', err.code === 'INVALID_CREDENTIAL', err.code)
  check('hint present', typeof err.hint === 'string' && err.hint.length > 10)
})

console.log('\n== 7. Missing credential -> MISSING_CREDENTIAL ==')
await withEnv({ ...BASE_ENV, COMMANDCODE_API_KEY: '', COMMANDCODE_ACCOUNTS: '', COMMANDCODE_ALLOW_PRIVATE: '1', CC_KEY_TIRED: '', HOME: tmp }, async (client) => {
  await client.initialize()
  const { raw } = await client.toolData('commandcode_usage')
  const err = JSON.parse(raw.content[0].text)
  check('MISSING_CREDENTIAL code', err.code === 'MISSING_CREDENTIAL', err.code)
  check('hint mentions COMMANDCODE_API_KEY', err.hint.includes('COMMANDCODE_API_KEY'))
})

console.log('\n== 8. SSRF guard: private/loopback targets blocked ==')
// Use commandcode_generate (no catalog/disk-cache degradation path) so the
// guard's rejection surfaces as the tool error, and a fresh cache dir.
const SSRF_ENV = (apiBase) => ({
  ...BASE_ENV,
  COMMANDCODE_ALLOW_PRIVATE: '0',
  COMMANDCODE_API_BASE: apiBase,
  COMMANDCODE_MODELS_CACHE_PATH: join(tmpdir(), `ccplug-ssrf-${Math.random().toString(36).slice(2)}`, 'cache.json'),
  COMMANDCODE_MAX_RETRIES: '0',
})
for (const [name, apiBase] of [
  ['BLOCKED_HOST for 127.0.0.1', 'http://127.0.0.1:9999'],
  ['BLOCKED_HOST for localhost name', 'http://localhost:9999'],
  ['BLOCKED_HOST for non-http scheme', 'ftp://example.com'],
  ['BLOCKED_HOST for 169.254.169.254 (cloud metadata)', 'http://169.254.169.254/latest'],
]) {
  await withEnv(SSRF_ENV(apiBase), async (client) => {
    await client.initialize()
    const { raw } = await client.toolData('commandcode_generate', { model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] })
    const err = JSON.parse(raw.content[0].text)
    check(name, err.code === 'BLOCKED_HOST', `${err.code}: ${err.message}`)
  })
}

console.log('\n== 9. Offline resilience: catalog served from cache when API down ==')
await withEnv({ ...BASE_ENV, COMMANDCODE_API_BASE: 'https://api.invalid.nonexistent-zcode-test', COMMANDCODE_API_KEY: '' }, async (client) => {
  await client.initialize()
  const { data, isError } = await client.toolData('commandcode_models')
  check('models served from stale disk cache despite DNS failure', !isError && data.total === 3 && data.catalog.circuit !== undefined, JSON.stringify(data.catalog))
})

await rm(tmp, { recursive: true, force: true })
mockServer.close()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
