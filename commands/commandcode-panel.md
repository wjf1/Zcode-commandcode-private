---
description: Start the Command Code local web dashboard and return the URL. / 启动 Command Code 本地网页面板并返回链接。
---

这是用户请求打开 **Command Code 可视化面板**（zcode-commandcode-private 插件）。

固定信息：面板地址是 **http://127.0.0.1:18400**，启动脚本是
`C:\Users\admin\.zcode\workspace\default\Zcode-commandcode-private\mcp\dashboard.mjs`（换端口用 env `COMMANDCODE_DASHBOARD_PORT`）。

步骤：

1. 先用 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18400/` 探测面板是否已在运行。
2. 若返回 200，不要重复启动，直接跳到第 4 步。
3. 否则用 Bash 后台启动：`node "C:\Users\admin\.zcode\workspace\default\Zcode-commandcode-private\mcp\dashboard.mjs"`（run_in_background），等 2 秒再探测一次确认 200。
4. 回复用户，把 [Command Code 面板](http://127.0.0.1:18400) 作为 Markdown 链接给出，并提醒：面板只读展示用量/模型/状态，数据来自本机缓存与 Command Code API，key 只显示指纹。

不要把面板绑定到非回环地址，不要修改面板端口配置。启动失败时展示 dashboard 进程的报错输出，不要用 MCP 工具顶替。
