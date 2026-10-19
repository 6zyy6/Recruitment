# 会议资料功能交接 · 2026-10-20

本轮代码已按差异合入共享 `demo`，保留核心模块与 Gmail 任务已有修改。按用户已授权的协调安排，本聊天不单独发布，由“完善项目核心模块”统一集成发布。

## 已完成

- `Interview` 增加可选 `meetingUrl`、`meetingId`、`meetingPassword`，兼容 D1 中旧 JSON，无表结构迁移。
- 安排与改期均可录入平台、HTTPS 会议链接、会议号与可选密码。会议须由 HR 先在腾讯会议等平台创建，网站不自动创建会议。
- 工作台、面试日程和候选人详情复用入会资料展示，支持“加入会议”和“复制会议信息”。旧 `location` 为 HTTPS 链接时仍可加入；只有“腾讯会议”文字时显示待补充，不伪造链接。
- 改期保留未提交的会议资料，可显式清空；更新后重新确认人工通知。旧面试仅补录资料且原时间完全不变时可保存，新增或改到过去的时间仍拒绝。
- 服务端拒绝非 HTTPS、嵌入账号密码、空白/控制字符、超长会议链接。会议号限 80 字符，密码限 100 字符。匿名清理同时删除三项入会资料。
- 详情抽屉的面试操作单独换行，避免压缩会议信息。

## 本轮验证

- 先用新增测试复现字段未保存、无效链接未拒绝、匿名残留及旧时间无法补录，再实施修复。
- 共享 `demo` 的 `node --experimental-strip-types --test tests/interview.test.ts`：10/10 通过。
- 共享 `demo` 的 `npm run typecheck`、`git diff --check`：通过。
- 本轮会议功能在独立的线上源码检出 `site-source` 中通过完整 Sites 构建；未对共享 `demo/dist` 启动并行构建，最终合并后的构建由统一发布方执行。
- 浏览器 `http://127.0.0.1:5173`：为本地合成郭清越的旧面试补录资料，保存后出现入会链接、会议号和密码；复制操作显示成功；刷新后重新进入详情仍保留；无浏览器 error 日志。
- 浏览器测试链接为 `https://meeting.example.com/join/demo-ui-check`，平台标为“腾讯会议（合成验收）”，是明确的合成验收资料，不是真实可用会议。未修改线上业务数据。
- 截图：`outputs/demo-meeting-details.png`。

## 统一发布前需核对

在并行开发仍进行时运行过共享 `npm test`：115 项中 110 通过、5 项失败，新增会议 10 项全部通过。失败均为甄选门禁/旧测试夹具的集成问题：

1. `tests/engine.test.ts`：screening requires a human note and stages cannot be skipped。
2. 同文件：scheduling detects interviewer and cross-job candidate overlaps; cancellation frees the slot。
3. 同文件：HR and manager can complete a real candidate-to-join workflow with decision/evaluation/contract gates。
4. 同文件：campus records allow unknown and mismatched graduation years for human verification。
5. `tests/selection.test.ts`：policy changes and report reruns invalidate current HR conclusions while preserving audit and terminal history。

报错分别为 `SCREENING_APPROVAL_REQUIRED` / `SELECTION_REVIEW_REQUIRED`。本轮未修改其他任务负责的甄选规则或上述测试；统一发布方需在并行代码稳定后核对并跑最终全量回归。本轮没有启动独立线上发布。
