#!/usr/bin/env node
/**
 * Diagnostic tee wrapper: spawns the real MCP server, pipes stdio through,
 * and records every byte with timestamps to %TEMP%\cc-tee-*.log.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const LOG = join(HERE, `tee-${STAMP}.log`)
const t0 = Date.now()
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`

appendFileSync(LOG, `${ts()} wrapper spawned pid=${process.pid} args=${JSON.stringify(process.argv.slice(1))}\n`)

const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})
appendFileSync(LOG, `${ts()} child spawned pid=${child.pid}\n`)

process.stdin.setEncoding('utf-8')
let inBuf = ''
process.stdin.on('data', (chunk) => {
  inBuf += chunk
  let nl
  while ((nl = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, nl)
    inBuf = inBuf.slice(nl + 1)
    if (line.trim()) appendFileSync(LOG, `${ts()} APP->SRV: ${line}\n`)
    child.stdin.write(line + '\n')
  }
})
process.stdin.on('end', () => { appendFileSync(LOG, `${ts()} APP closed stdin\n`); child.stdin.end() })

child.stdout.setEncoding('utf-8')
let outBuf = ''
child.stdout.on('data', (chunk) => {
  outBuf += chunk
  let nl
  while ((nl = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, nl)
    outBuf = outBuf.slice(nl + 1)
    if (line.trim()) appendFileSync(LOG, `${ts()} SRV->APP: ${line.slice(0, 2000)}\n`)
    process.stdout.write(line + '\n')
  }
})

child.stderr.setEncoding('utf-8')
let errBuf = ''
child.stderr.on('data', (chunk) => {
  errBuf += chunk
  let nl
  while ((nl = errBuf.indexOf('\n')) >= 0) {
    const line = errBuf.slice(0, nl)
    errBuf = errBuf.slice(nl + 1)
    if (line.trim()) appendFileSync(LOG, `${ts()} SRV-ERR: ${line}\n`)
    process.stderr.write(line + '\n')
  }
})

child.on('exit', (code, signal) => {
  appendFileSync(LOG, `${ts()} child exited code=${code} signal=${signal}\n`)
  process.exit(code ?? 0)
})
process.on('SIGINT', () => { child.kill(); process.exit(0) })
process.on('SIGTERM', () => { child.kill(); process.exit(0) })
