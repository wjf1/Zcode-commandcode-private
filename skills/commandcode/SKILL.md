---
name: commandcode
description: Use when the user asks about Command Code (commandcode.ai) models, usage, credits, plan limits, or wants to generate text through the Command Code Provider API from ZCode. Covers listing models with plan-aware filtering, streaming generation with reasoning effort, multi-account rotation on 429/401, and usage diagnostics. Triggers include "commandcode", "CC 模型", "用量看板", "五小时窗口", "额度".
---

# Command Code integration (zcode-commandcode-private)

This workspace has the `commandcode` MCP server (plugin **zcode-commandcode-private**) which bridges ZCode to the Command Code Provider API (`https://api.commandcode.ai`). It ports the feature set of `wjf1/dsh-commandcode` (SWR model catalog, circuit breaker, multi-account rotation, structured errors) to ZCode's MCP plugin model — ZCode cannot register LLM provider routes directly, so generation is exposed as tools instead.

## Tools

| Tool | Purpose |
|---|---|
| `commandcode_models` | List models (SWR cache, ETag, circuit breaker). `force=true` refreshes; `filterByPlan=false` disables plan filtering. |
| `commandcode_generate` | One-shot streaming generation: `{model, messages, system?, maxTokens?, temperature?, reasoningEffort?}`. Returns aggregated `text`, `reasoning`, `toolCalls`, `usage`, `finishReason`. |
| `commandcode_usage` | Per-account usage/credits/plan report with 5-hour & weekly windows. |
| `commandcode_status` | Diagnostics: account rotation states, catalog freshness, effective config. No API calls. |

## Web dashboard（可视化面板）

本地网页面板固定地址 **http://127.0.0.1:18400**（只绑定回环地址，只读：用量/模型/状态，key 只显示指纹）。启动脚本 `mcp/dashboard.mjs`；会话内用 `/commandcode-panel` 命令启动并取链接。用户问"面板/仪表盘/可视化"时优先指向这里。

## When to use which

- "有哪些模型 / model catalog / 上下文窗口" → `commandcode_models`（结果会缓存 1 小时，强制刷新加 `force:true`）。
- "我的额度 / 用量 / 5 小时窗口 / 套餐" → `commandcode_usage`；窗口耗尽时提示等待 resetAt 或在 env 中追加账号。
- 连接问题排查 → 先 `commandcode_status`（不产生 API 调用），再按错误 `code` 处理：`MISSING_CREDENTIAL` 配 key、`INVALID_CREDENTIAL` 重新登录、`RATE_LIMIT` 等窗口重置、`BLOCKED_HOST` 检查 API base。
- 让模型直接生成文本 → `commandcode_generate`。reasoning 模型可传 `reasoningEffort`（支持值见 `commandcode_models` 返回的 `reasoningEfforts` 字段）。

## Configuration (env, set in ZCode MCP settings)

- `COMMANDCODE_API_KEY` — primary key（也可来自 `command-code login` 写入的 `~/.commandcode/auth.json`）
- `COMMANDCODE_ACCOUNTS` — JSON 数组 `[{"label":"Work","apiKeyEnv":"COMMANDCODE_API_KEY_WORK"}]` 启用多账号；429/401 自动轮换
- `COMMANDCODE_API_BASE` — 默认 `https://api.commandcode.ai`
- `COMMANDCODE_MODELS_CACHE_PATH` — 目录缓存，默认 `~/.commandcode/models-cache.json`
- `COMMANDCODE_REQUEST_TIMEOUT_MS` / `COMMANDCODE_STREAM_IDLE_TIMEOUT_MS` — 超时（默认 60s / 300s）
- `COMMANDCODE_FILTER_MODELS_BY_PLAN=0` — 关闭套餐过滤

## Guarantees

- 所有错误都是结构化 JSON：`code`（稳定错误码）+ `message` + `context`（status/model/endpoint）+ `hint`（用户可执行的排查建议）。向用户报告时展示 `code` 和 `hint`。
- 出站请求仅允许公网 http(s)；localhost/私有/保留地址会被 `BLOCKED_HOST` 拒绝。
- 模型目录离线时回退到磁盘缓存（最长 24 小时 stale 窗口）。
