#!/usr/bin/env node
/**
 * Zcode-commandcode-private — local web dashboard.
 *
 * Serves a single-page visual panel (dashboard.html) backed by the same
 * core logic as the MCP server: /api/usage, /api/models, /api/status.
 *
 *   node mcp/dashboard.mjs            # http://127.0.0.1:18400
 *   COMMANDCODE_DASHBOARD_PORT=8080 node mcp/dashboard.mjs
 *
 * Security: binds to 127.0.0.1 only (loopback), serves static HTML and
 * read-only JSON endpoints; all outbound API requests still go through
 * the core's SSRF guard. No credentials are ever returned to the page —
 * only key fingerprints.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listModels, usageReport, statusInfo, CommandCodeError, ErrorCode, PLUGIN_VERSION } from './core.mjs'

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html')
const PORT = (() => {
  const raw = process.env.COMMANDCODE_DASHBOARD_PORT
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 18400
})()

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function errorPayload(error) {
  const ccErr = error instanceof CommandCodeError ? error
    : new CommandCodeError(ErrorCode.INTERNAL_ERROR, `${error?.message ?? error}`)
  return { error: ccErr.toJSON() }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(HTML_PATH, 'utf-8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (url.pathname === '/api/usage') {
      sendJson(res, 200, await usageReport())
      return
    }
    if (url.pathname === '/api/models') {
      sendJson(res, 200, await listModels({ force: url.searchParams.get('force') === '1' }))
      return
    }
    if (url.pathname === '/api/status') {
      sendJson(res, 200, await statusInfo())
      return
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      // Optional playground endpoint; kept read-only-guarded by core errors.
      const chunks = []
      for await (const c of req) chunks.push(c)
      let args = {}
      try { args = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') } catch { /* handled below */ }
      sendJson(res, 200, await generate(args))
      return
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${url.pathname}` } })
  } catch (error) {
    sendJson(res, error instanceof CommandCodeError ? 400 : 500, errorPayload(error))
  }
})

server.on('error', (err) => {
  process.stderr.write(`[zcode-commandcode-private] dashboard error: ${err.message}\n`)
  process.exit(1)
})

// Loopback only: the dashboard is a local UI, never exposed to the network.
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[zcode-commandcode-private] dashboard v${PLUGIN_VERSION} → http://127.0.0.1:${PORT}\n`)
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
