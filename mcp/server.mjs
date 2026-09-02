#!/usr/bin/env node
/**
 * Zcode-commandcode-private — MCP stdio server.
 *
 * Exposes the Command Code Provider API to ZCode as four MCP tools. All
 * logic lives in core.mjs (shared with the local web dashboard):
 *
 *   commandcode_models   — live model catalog (SWR cache, ETag, circuit breaker)
 *   commandcode_generate — streaming generation via /alpha/generate (aggregated)
 *   commandcode_usage    — per-account usage / credits / plan report
 *   commandcode_status   — pool + catalog diagnostics
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio).
 */

import { listModels, generate, usageReport, statusInfo, CommandCodeError, ErrorCode, log } from './core.mjs'

const TOOLS = [
  {
    name: 'commandcode_models',
    description: 'List models available on the Command Code Provider API with a stale-while-revalidate on-disk cache. Returns id, name, context window, plan tier, vision/reasoning capabilities. Use force=true to bypass the cache and refresh now.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Bypass cache and refresh the catalog immediately (default false)' },
        filterByPlan: { type: 'boolean', description: 'Hide models above the account subscription tier (default true)' },
      },
    },
  },
  {
    name: 'commandcode_generate',
    description: 'Run a one-shot streaming generation against the Command Code API (/alpha/generate). Supports multi-turn messages, optional system prompt, reasoning effort for reasoning-capable models, and returns aggregated text, reasoning, tool calls, token usage and finish reason.',
    inputSchema: {
      type: 'object',
      required: ['model', 'messages'],
      properties: {
        model: { type: 'string', description: 'Model id, e.g. "z-ai/glm-5.3-flash" (see commandcode_models)' },
        messages: {
          type: 'array',
          description: 'Conversation messages; content may be a plain string, an array of text parts, or tool-call/tool-result blocks',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
              content: {},
            },
            required: ['role', 'content'],
          },
        },
        system: { type: 'string', description: 'System prompt' },
        maxTokens: { type: 'integer', description: 'Max output tokens (capped by model context)' },
        temperature: { type: 'number' },
        reasoningEffort: { type: 'string', description: 'Reasoning effort if supported by the model (low/medium/high/xhigh/max)' },
        includeEvents: { type: 'boolean', description: 'Include the raw stream events in the output (default false)' },
      },
    },
  },
  {
    name: 'commandcode_usage',
    description: 'Fetch the per-account Command Code usage report: account identity, request/token/cost summary, credits balance with 5-hour and weekly window limits, and subscription plan info. Each endpoint degrades independently; blocked explains a total failure.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'commandcode_status',
    description: 'Diagnostics for this Command Code integration: configured accounts with rotation state, model catalog freshness/circuit state, and the effective configuration. Read-only, no API calls to generate.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function toolCall(name, args) {
  switch (name) {
    case 'commandcode_models': return listModels(args ?? {})
    case 'commandcode_generate': return generate(args ?? {})
    case 'commandcode_usage': return usageReport()
    case 'commandcode_status': return statusInfo()
    default:
      throw new CommandCodeError(ErrorCode.INTERNAL_ERROR, `Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '2025-06-18'

function send(message) {
  const body = JSON.stringify(message)
  if (framing === 'lsp') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  } else {
    process.stdout.write(body + '\n')
  }
}

function toolErrorPayload(error) {
  const ccErr = error instanceof CommandCodeError ? error
    : new CommandCodeError(ErrorCode.INTERNAL_ERROR, `${error?.stack ?? error?.message ?? error}`)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(ccErr.toJSON(), null, 2) }],
  }
}

async function handleMessage(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      return {
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'zcode-commandcode-private', version: '1.0.0' },
        },
      }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'ping':
      return { id, result: {} }
    case 'tools/list':
      return { id, result: { tools: TOOLS } }
    case 'tools/call': {
      try {
        const data = await toolCall(params?.name, params?.arguments ?? {})
        return {
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          },
        }
      } catch (error) {
        log(`tool ${params?.name} failed:`, error?.message ?? error)
        return { id, result: toolErrorPayload(error) }
      }
    }
    default:
      if (id === undefined) return undefined
      return {
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      }
  }
}

let inputBuffer = ''
let framing = null // 'ndjson' (newline-delimited JSON, MCP stdio standard) | 'lsp' (Content-Length framing)
let lspHeader = ''

function dispatchLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch (error) {
    log('ignoring malformed JSON line:', error.message)
    return
  }
  handleMessage(message).then((response) => {
    if (response !== undefined) send(response)
  }).catch((error) => {
    log('handler crashed:', error?.stack ?? error)
    if (message?.id !== undefined) {
      send({ id: message.id, result: toolErrorPayload(error) })
    }
  })
}

// Some hosts wrap stdio servers in LSP-style Content-Length frames; accept
// both that and the MCP-standard newline-delimited JSON.
function dispatchLsp(chunk) {
  lspHeader += chunk
  while (true) {
    const headerEnd = lspHeader.indexOf('\r\n\r\n')
    const altEnd = headerEnd < 0 ? lspHeader.indexOf('\n\n') : -1
    if (headerEnd < 0 && altEnd < 0) return
    const sepLen = headerEnd >= 0 ? 4 : 2
    const header = lspHeader.slice(0, headerEnd >= 0 ? headerEnd : altEnd)
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) { // not actually LSP — fall back to ndjson for the whole buffer
      framing = 'ndjson'
      for (const line of lspHeader.split('\n')) dispatchLine(line)
      lspHeader = ''
      return
    }
    const length = Number(m[1])
    const bodyStart = (headerEnd >= 0 ? headerEnd : altEnd) + sepLen
    if (lspHeader.length - bodyStart < length) return // wait for full body
    const body = lspHeader.slice(bodyStart, bodyStart + length)
    lspHeader = lspHeader.slice(bodyStart + length)
    dispatchLine(body)
  }
}

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk
  if (framing === null) {
    if (/^Content-Length:/im.test(inputBuffer) && /\r\n\r\n|\n\n/.test(inputBuffer)) framing = 'lsp'
    else if (inputBuffer.includes('\n')) framing = 'ndjson'
    else return // not enough data to detect framing yet
  }
  if (framing === 'lsp') {
    dispatchLsp(inputBuffer)
    inputBuffer = ''
  } else {
    let nl
    while ((nl = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, nl)
      inputBuffer = inputBuffer.slice(nl + 1)
      dispatchLine(line)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

log('started', { apiBase: (process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai').replace(/\/+$/, ''), node: process.version })
