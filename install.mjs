#!/usr/bin/env node
/**
 * Zcode-commandcode-private — one-click installer.
 *
 *   node install.mjs
 *
 * Idempotent: safe to re-run (re-copies files, re-registers the MCP server,
 * does not duplicate the AGENTS.md section). Performs:
 *
 *   1. Runtime check (Node >= 18)
 *   2. Register the `commandcode` MCP server in ~/.zcode/cli/config.json,
 *      using THIS node executable's absolute path (process.execPath), so
 *      GUI-launched ZCode finds node even when it is not on the GUI PATH.
 *   3. Copy skill -> ~/.zcode/skills/commandcode, commands -> ~/.zcode/commands
 *   4. Merge the "remembered panel URL" section into ~/.zcode/AGENTS.md
 *   5. Verify credentials (COMMANDCODE_API_KEY env or ~/.commandcode/auth.json)
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const IS_WIN = platform() === 'win32'
const ZCODE_DIR = join(HOME, '.zcode')
const AGENTS_MARKER = '## Command Code 插件（zcode-commandcode-private）'

let ok = 0
let warn = 0
function step(msg) { ok++; console.log(`  [ok]   ${msg}`) }
function warnStep(msg) { warn++; console.log(`  [warn] ${msg}`) }

// --- 1. Runtime check -------------------------------------------------------

const nodeMajor = Number(process.versions.node.split('.')[0])
console.log(`\nZcode-commandcode-private 安装器\n  插件目录: ${PLUGIN_ROOT}\n  Node:     ${process.version} (${process.execPath})\n`)
if (nodeMajor < 18) {
  console.error('  [fail] 需要 Node.js >= 18,当前 ' + process.version)
  process.exit(1)
}
step(`Node >= 18 (${process.version})`)

// --- 2. Register MCP server --------------------------------------------------

const configPath = join(ZCODE_DIR, 'cli', 'config.json')
let config = {}
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (err) {
    console.error(`  [fail] ${configPath} 不是合法 JSON,请先修复: ${err.message}`)
    process.exit(1)
  }
}
config.mcp = config.mcp ?? {}
config.mcp.servers = config.mcp.servers ?? {}
const serverEntry = process.argv.includes('--plugin-mode')
  ? undefined // plugin-mode: the plugin manifest provides the server; skip user-config registration
  : {
      type: 'stdio',
      command: process.execPath, // absolute path to this node.exe — GUI-safe
      args: [join(PLUGIN_ROOT, 'mcp', 'server.mjs').replace(/\\/g, '/')],
      env: {},
      timeoutMs: 120000,
    }
if (serverEntry) {
  config.mcp.servers.commandcode = serverEntry
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  step(`MCP server 已注册到 ${configPath} (node 绝对路径,GUI 启动安全)`)
}

// --- 3. Copy skill + commands to user scope ---------------------------------

function copyTo(src, destDir) {
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, join(destDir, src.split(/[\\/]/).pop()))
}
const skillsDir = join(ZCODE_DIR, 'skills')
const commandsDir = join(ZCODE_DIR, 'commands')
copyTo(join(PLUGIN_ROOT, 'skills', 'commandcode', 'SKILL.md'), join(skillsDir, 'commandcode'))
step('skill 已安装到 ~/.zcode/skills/commandcode')
for (const name of ['commandcode.md', 'commandcode-panel.md']) {
  copyTo(join(PLUGIN_ROOT, 'commands', name), commandsDir)
}
step('命令已安装: /commandcode, /commandcode-panel')

// --- 4. Merge AGENTS.md (panel URL memory) -----------------------------------

const agentsPath = join(ZCODE_DIR, 'AGENTS.md')
const agentsSection = readFileSync(join(PLUGIN_ROOT, 'agents-section.md'), 'utf-8')
  .split('<PLUGIN_ROOT>').join(PLUGIN_ROOT.replace(/\\/g, '/'))
let agents = ''
try { agents = readFileSync(agentsPath, 'utf-8') } catch { /* new file */ }
if (agents.includes(AGENTS_MARKER)) {
  step('AGENTS.md 已包含 Command Code 段落,跳过')
} else {
  const merged = (agents.trimEnd() ? agents.trimEnd() + '\n\n' : '') + agentsSection
  writeFileSync(agentsPath, merged)
  step('AGENTS.md 已写入面板固定网址与插件使用规则')
}

// --- 5. Credentials check -----------------------------------------------------

const envKey = process.env.COMMANDCODE_API_KEY
const authFile = join(HOME, '.commandcode', 'auth.json')
if (envKey) {
  step(`COMMANDCODE_API_KEY 已配置 (${envKey.slice(0, 8)}…,用户级环境变量,新进程可继承)`)
} else if (existsSync(authFile)) {
  step('~/.commandcode/auth.json 存在,凭据可用')
} else {
  warnStep('未找到凭据:请设置用户级环境变量 COMMANDCODE_API_KEY,或运行 command-code login')
  console.log('         PowerShell(永久): [Environment]::SetEnvironmentVariable(\'COMMANDCODE_API_KEY\',\'<你的key>\',\'User\')')
}

// --- Done ---------------------------------------------------------------------

console.log(`
完成:${ok} 项成功,${warn} 项警告。下一步:
  1. 重启 ZCode(或 Settings → MCP 切换一次 commandcode 开关)
  2. 新会话中执行 /commandcode 查看用量,/commandcode-panel 打开可视化面板
     (面板地址固定: http://127.0.0.1:18400)
  3. MCP 工具: commandcode_models / commandcode_generate / commandcode_usage / commandcode_status
`)

if (serverEntry === undefined) {
  console.log('(--plugin-mode:未写入用户 config,MCP 由插件清单提供)\n')
}
