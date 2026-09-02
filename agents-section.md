## Command Code 插件（zcode-commandcode-private）

- 本机装有 Command Code 集成插件，MCP server 名为 `commandcode`，工具前缀 `commandcode_*`（models / generate / usage / status）。
- **可视化面板固定网址：http://127.0.0.1:18400**（本地回环、只读）。用户提到"面板 / 仪表盘 / 可视化 / panel"或要求打开 Command Code 网页时，执行 `/commandcode-panel`：先探测 18400 端口，未运行则后台启动 `node "<PLUGIN_ROOT>/mcp/dashboard.mjs"`，然后把 [Command Code 面板](http://127.0.0.1:18400) 以 Markdown 链接回复。
- 用量/额度/模型目录问题优先用 `commandcode_usage` / `commandcode_models`，连接问题先 `commandcode_status`（不产生 API 调用）。
- API key 在用户级环境变量 `COMMANDCODE_API_KEY` 中；未装 `command-code` CLI 属正常，无需建议安装。
