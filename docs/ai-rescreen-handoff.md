# AI 简历复筛交接 · 2026-10-20

本轮按用户要求从固定规则报告改为真实模型接口，随后按用户最新选择切换为 DeepSeek。用户填写密钥并确认后，已保存为 Sites 服务端 Secret（环境修订 2），并用完全合成简历完成一次真实提供商调用。与其他功能由「完善项目核心模块」聊天统一检查发布，本聊天未单独部署；线上生效及网站端到端验证仍需新版部署。

## 行为

- 新建、关联已有候选人和 CSV 导入均自动按本次岗位生成规则初筛。按用户最新确认采用宽进原则：完成当前岗位的线索初筛且存在简历正文即可进入模型复筛；`missing` 和 `unknown` 作为待核实信息传递，不阻止复筛、不自动淘汰。详见 [初筛调研与交接](./initial-screening-handoff.md)。
- 单份投递在保存后调用真实模型。重新初筛、人工核实筛选资料、打开符合条件的旧投递详情也会触发复筛。批量导入先记录待复筛，HR 打开对应投递时完成调用，避免一次导入产生无限并发请求。
- 投递先落库，随后调用模型；模型失败保留投递，记录可重试状态，不生成模拟替代报告。结果按请求时的候选人资料和岗位条件核验，CAS 保存时保留其他并发修改；资料变更、关闭或更新请求会丢弃迟到结果。
- 详情与甄选中心展示同一份结果：摘要、逐项原文与说明、缺口、建议追问、模型和时间。历史规则报告明确标识；过期报告不作为当前报告。没有引用依据时不展示为简历原文。
- 新的 HR「通过」要求当前有效的真实模型报告。模型结果不自动推进、不写 HR 结论、不产生经理录用决定；原有各阶段人工门槛继续执行。历史已保存的阶段和结论不批量重置。

## 服务端配置

| 名称 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | Sites 运行时 secret；只在 Worker 服务端读取，不写源码、manifest、浏览器或文档。 |
| `DEEPSEEK_MODEL` | 可选模型名，默认 `deepseek-flash`，按 2026-10-20 官方文档确认。 |
| `MAIL_OPERATOR_EMAIL` | 与现有真实邮件共用的指定 Sites 操作者。配置模型密钥后，即使 `MAIL_MODE` 仍是预览，也必须通过 Sites 身份及指定账号校验，公开 Demo Cookie 无法触发模型。 |

用户无需启用 OpenAI Developers。本机私密录入文件 `.env.deepseek.local` 权限 `0600`，经 `git check-ignore` 核实忽略。用户填写并确认后，已通过内存读取和 Sites 原生环境工具保存 `DEEPSEEK_API_KEY` 为 secret，同时保存 `DEEPSEEK_MODEL`，不回显值、不放入命令行、不提交 Git。此次更新仅修改 DeepSeek 两个变量，保留原有邮件与指定操作者配置。线上应用环境修订仍须随统一发布完成。

真实请求采用 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 固定端点 `https://api.deepseek.com/chat/completions`，使用 [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/) 和服务端 Zod 严格结构校验，关闭思考模式，45 秒超时。JSON Output 本身不保证业务字段正确，必须通过本地校验。请求只传岗位相关资料，去掉已知姓名和联系方式及岗位未要求的院校；简历与岗位文字均作为不可信数据。服务端核验引用确实存在于简历正文，拒绝伪造引文；不生成匹配分或录用结论。错误信息不回传提供商响应或密钥。未对 DeepSeek 的数据保留策略作独立审计，也不再声称请求使用 OpenAI 的 `store:false` 或 `json_schema strict` 参数。

文本模拟面试、偏好问卷和面试辅助核对仍为原有规则演示，本轮没有接入这些模块的模型能力。

## 验证

- 切换提供商前全量 `npm test`：155/155 通过；`npm run typecheck` 通过。该数字为历史验证，不替代 DeepSeek 切换后的最新运行记录。
- DeepSeek 切换后：8 项模型请求/引文/脱敏/异常模拟测试及 9 项操作者授权测试通过。随后当前 `resume-ai` 与 `resume-workflow` 合计 13 项测试通过，类型检查通过。全量回归由统一集成聊天处理，不将旧日志中的运行数字当作最终全量结果。
- 用户填写密钥后，真实调用当前 `generateResumeReview` 使用完全合成的前端岗位和简历，返回 `deepseek-flash`，耗时 4282 ms，7 项证据、5 个追问，全部引文通过逐字核验，无数值评分。证据保存在 `outputs/deepseek-live-report.json`；未写入生产招聘数据。此测试验证提供商与报告处理链路，不代表已部署网站的 HTTP/浏览器端到端验收。
- `node scripts/selection-smoke.mjs`：本地运行 `mvfkheoi`，12 项通过、3 项明确跳过。密钥缺失时已验证 `failed` 状态、没有假报告、HR 通过被拒绝。
- 跳过的真实模型依赖项：真实报告成功与 HR 通过；面试安排与面试官报告可见性（经理写权限隔离仍已验证）；真实复筛完成后的经理决定、面试和 Offer 门禁。成功路径的断言保留，配置后重跑。跳过项不能算通过。
- 浏览器本地检查了沈星河投递详情：自动尝试复筛，显示密钥缺失与重试按钮，已移除原先的重复说明框。截图：`outputs/ai-rescreen-detail.png`。本轮浏览器检查为桌面视口；窄屏规则已做静态检查，未声称全部移动端实测。
- 未把模拟或真实合成验证结果写入生产数据库；未单独发布。真实调用仅使用合成资料。

## 主要文件

- `lib/resume-ai.ts`：真实模型请求和响应核验。
- `lib/resume-workflow.ts`、`lib/server.ts`：保存、调用与并发结果合并。
- `lib/selection.ts`、`lib/engine.ts`、`lib/domain.ts`：自动初筛、状态与人工门槛。
- `lib/operator.ts`：配置模型后要求指定 Sites 操作者。
- `components/recruitment/Workspace.tsx`、`SelectionCenter.tsx`、`app/workspace.css`：结果卡片、旧记录自动触发与重试。
- `tests/resume-ai.test.ts`、`resume-workflow.test.ts`、`operator.test.ts`、`engine.test.ts`、`selection.test.ts`、`scripts/selection-smoke.mjs`：相关验证。

`lib/candidate-review.ts` 只增加资料更正时清除 `aiReview`，防止继续显示旧排队状态。
