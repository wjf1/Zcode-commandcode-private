---
description: Show Command Code account usage, credits, windows, and plan. / 查看 Command Code 各账号用量、额度窗口与套餐。
argument-hint: "[--models | --refresh]"
---

这是用户请求的 Command Code (commandcode.ai) 状态查看，数据来自 `commandcode` MCP server（插件 zcode-commandcode-private）。

行为按参数分支：

1. 无参数（默认）：调用 `commandcode_usage` 工具，把返回的 JSON 渲染成简洁看板：
   - 每个账号一行：label、state（ok / cooldown / disabled / unconfigured）、activeAccount 标记；
   - 当前账号的 usage（请求数、成功率、tokens、credits 消耗）；
   - credits：monthly / purchased / free 余额，5 小时窗口与周窗口用 `used/cap` 加百分比进度条（如 `▓▓▓░░ 62%`），`exceeded=true` 时明确提示窗口耗尽并给出 resetAt 的本地时间；
   - plan：套餐名、status、monthlyCredits、currentPeriodEnd；
   - `report.failures` 非空时列出失败项，`blocked` 非空时按其值（invalid-key / service-unavailable / network）给出对应的中文排查建议。
2. 参数含 `--models`：改为调用 `commandcode_models`，输出模型表（id、名称、上下文窗口、plan、Vision/Reasoning 能力），按 plan 排序。
3. 参数含 `--refresh`：调用 `commandcode_models` 时传 `force=true` 强制刷新目录。

工具不可用时：提示用户检查 zcode-commandcode-private 插件是否启用、`COMMANDCODE_API_KEY` 是否配置，不要用其他工具模拟。不要修改任何文件。
