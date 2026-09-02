// Simulates a GUI-style MCP host launch: absolute node.exe path, env without PATH.
const { spawn } = require('node:child_process')
const NODE_EXE = 'C:/Users/admin/AppData/Local/hermes/node/node.exe'
const SERVER = 'C:/Users/admin/.zcode/workspace/default/Zcode-commandcode-private/mcp/server.mjs'
const p = spawn(NODE_EXE, [SERVER], {
  env: {
    SYSTEMROOT: process.env.SYSTEMROOT, USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    COMMANDCODE_API_KEY: process.env.COMMANDCODE_API_KEY,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buf = ''
p.stdout.on('data', (c) => (buf += c))
p.stderr.on('data', (c) => process.stderr.write('[srv] ' + c))
p.on('error', (e) => { console.log('SPAWN ERROR:', e.message); process.exit(1) })
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
const t = setInterval(() => {
  const i = buf.indexOf('\n')
  if (i >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    try {
      const m = JSON.parse(line)
      if (m.id === 1) { console.log('HANDSHAKE OK:', m.result.serverInfo.name); clearInterval(t); p.kill(); process.exit(0) }
    } catch {}
  }
}, 50)
setTimeout(() => { console.log('TIMEOUT'); p.kill(); process.exit(1) }, 10000)
