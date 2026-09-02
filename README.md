# Zcode-commandcode-private

ZCode 插件：把 [Command Code](https://commandcode.ai) Provider API 接入 ZCode。功能对标
[wjf1/dsh-commandcode](https://github.com/wjf1/dsh-commandcode)（DSH-Desktop LLM provider 插件，MIT），
但 ZCode 的插件体系**不支持注册 LLM provider 路由**，因此以 MCP server + skill + slash command 的
形式提供同等能力。

## 功能（对标 dsh-commandcode）

| dsh-commandcode 特性 | 本插件的 ZCode 实现 |
|---|---|
| `commandcode` provider 路由注册 | MCP 工具 `commandcode_generate`（流式聚合） |
| 实时模型目录 `/provider/v1/models` | MCP 工具 `commandcode_models`（SWR 缓存 + ETag + 断路器） |
| 多账号轮换（429/401 自动切换、窗口探测复活） | MCP 层内置 `AccountPool`（`COMMANDCODE_ACCOUNTS`） |
| 用量/额度/套餐看板（5 小时 + 周窗口） | MCP 工具 `commandcode_usage` + `/commandcode` 命令 |
| 结构化错误诊断（code + context + hint） | 所有错误以稳定错误码 JSON 返回 |
| 计划感知的模型过滤 | `commandcode_models` 内置（可关闭） |
| 凭据：env / `~/.commandcode/auth.json` | 同样支持两种来源 |
| 设置页 UI / OAuth 登录 / Models 卡片 | 不适用（ZCode 无宿主 UI），用 env 配置 + `commandcode_status` 诊断替代 |

## 安装

### 方式一：插件市场（在线）

本仓库同时是一个 ZCode 插件 marketplace（根目录 `marketplace.json`）。在 ZCode 的
**Settings → Plugin Management → Discover → `+`** 中添加 GitHub 仓库：

```
wjf1/Zcode-commandcode-private
```

然后在插件卡片上点 **Get** 安装即可。

### 方式二：一键安装（离线/本地）

新电脑上只要有 Node.js >= 18，把本目录整个拷贝过去，然后：

```powershell
node install.mjs
```

脚本自动完成四件事，并做幂等校验（可重复执行）：

1. 注册 MCP server 到 `~/.zcode/cli/config.json` —— 使用当前 node.exe 的**绝对路径**，规避 GUI 启动的 ZCode 按 PATH 找不到 node 的问题
2. 安装 skill 与 `/commandcode`、`/commandcode-panel` 命令到用户级目录
3. 把面板固定网址（http://127.0.0.1:18400）与插件使用规则写入 `~/.zcode/AGENTS.md`
4. 检查凭据（`COMMANDCODE_API_KEY` 环境变量或 `~/.commandcode/auth.json`），缺失时给出配置指引

完成后重启 ZCode 即生效。唯一无法自动迁移的是 **API key 本身**（出于安全不随插件打包），新机器上需设置一次环境变量或运行 `command-code login`。

### 手动安装（本地目录 marketplace）

ZCode 设置 → Plugin Management → Discover → `+` → 选择本目录。此方式 MCP 由插件清单提供，无需写用户 config（`node install.mjs --plugin-mode` 可跳过 config 写入）。

## 配置（环境变量，可写在 MCP server 的 env 中）

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMMANDCODE_API_KEY` | — | 主 API key（或运行 `command-code login`） |
| `COMMANDCODE_ACCOUNTS` | `[]` | 多账号：`[{"label":"Work","apiKeyEnv":"COMMANDCODE_API_KEY_WORK"}]` |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | API base |
| `COMMANDCODE_MODELS_CACHE_PATH` | `~/.commandcode/models-cache.json` | 目录缓存 |
| `COMMANDCODE_REQUEST_TIMEOUT_MS` | `60000` | 首字节超时 |
| `COMMANDCODE_STREAM_IDLE_TIMEOUT_MS` | `300000` | 流空闲超时 |
| `COMMANDCODE_FILTER_MODELS_BY_PLAN` | `1` | 套餐过滤开关 |
| `COMMANDCODE_MAX_RETRIES` | `3` | 瞬态错误重试次数 |
| `COMMANDCODE_ALLOW_PRIVATE` | `0` | 测试专用：放行私网地址（默认严格禁止） |

## 用法

- `/commandcode` — 用量看板；`/commandcode --models` 模型表；`/commandcode --refresh` 强制刷新目录
- `/commandcode-panel` — 启动本地可视化面板并返回链接(见下)
- Skill `commandcode` 自动在相关请求时触发（模型目录、额度、生成、排障）
- 直接调 MCP 工具：`commandcode_models` / `commandcode_generate` / `commandcode_usage` / `commandcode_status`

## 安全约束

所有出站请求仅允许公网 http(s)；localhost、环回、私有（RFC1918/CGNAT/链路本地等）与保留地址、
以及解析到私网的域名都会被拒绝（错误码 `BLOCKED_HOST`）。`COMMANDCODE_ALLOW_PRIVATE=1` 仅供本地
测试，日常请保持关闭。

## 可视化面板（本地网页仪表盘）

```powershell
node C:\Users\admin\.zcode\workspace\default\Zcode-commandcode-private\mcp\dashboard.mjs
```

然后浏览器打开 **http://127.0.0.1:18400**（会话内可点 [Command Code 面板](http://127.0.0.1:18400)）。

- 只绑定 127.0.0.1 回环地址；提供 `/api/usage`、`/api/models`、`/api/status` 三个只读接口
- 与 MCP server 共用 `core.mjs`（同一份目录缓存、账号池、SSRF 防护）
- key 只显示指纹（如 `user_5…VmJ9`），不回传到页面
- 换端口：`COMMANDCODE_DASHBOARD_PORT=8080 node mcp/dashboard.mjs`
- 会话内也可用 `/commandcode-panel` 让 agent 启动并返回链接

### 面板内容

- **用量与额度** — 套餐卡片、可用余额、5 小时/周窗口进度条(带实时重置倒计时)、请求/成功率/tokens 统计、多账号页签、按端点降级的失败明细
- **模型目录** — 全部模型的卡片网格,搜索、套餐筛选(Go/Pro/Provider/无档位)、Vision/Reasoning 徽标、强制刷新
- **运行诊断** — 连接状态、目录新鲜度与断路器、账号池轮换状态、超时/重试配置

深色/浅色主题自动跟随系统,60 秒自动刷新(带倒计时)。深链:`http://127.0.0.1:18400/#models`、`/#status`。
架构:`mcp/core.mjs` 共享核心,`mcp/server.mjs`(MCP stdio)与 `mcp/dashboard.mjs`(面板)复用同一套逻辑与缓存。

## License

MIT。协议细节与设计参考 wjf1/dsh-commandcode（MIT）、mitian233/dsh-plugin-commandcode-provider、
safzanpirani/pi-commandcode-provider。
