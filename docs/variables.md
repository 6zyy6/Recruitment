# 配置、凭据与容量

本文记录已落盘的Gmail OAuth/send与DeepSeek复筛配置名称；实际环境是否就绪、面试邮件配置与真实外部验收以最终交付记录为准。

这里只列名称与处理方式，不保存secret值、Cookie、核对链接或私人邮箱。Gmail OAuth client secret、AES密钥、refresh/access token及DeepSeek API key只在服务端环境或加密存储中使用；已核查自有业务代码没有将其返回/打包到客户端的路径，第三方依赖及托管注入仍需发布侧核查。原始核对token是特例：本次响应/URL/邮件需分发，服务端业务状态仅存哈希。公开Demo密码也确实在前端，不能用于生产身份保护。

## 运行配置与凭据

| 名称 | 使用方 | 范围 | 来源 | 轮换/撤销方式 | 风险与当前状态 |
| --- | --- | --- | --- | --- | --- |
| `DB` / hosting `d1` | `lib/server.ts`；`vite.config.ts` | Worker 服务端/本地模拟 D1 | `.openai/hosting.json` 声明绑定名，实际资源由 Sites 注入；本地 `.wrangler/state` | 由托管平台更换绑定并迁移数据 | 可读取全业务状态及会话；不是浏览器配置；缺失时 503 |
| hosting `r2` | Vite 托管配置 | 服务端 | 当前 `null` | 接入时由平台配置 | 当前不存原始简历文件；不要将“有模板字段”当成已启用文件存储 |
| `CONNECTORS` | `build/sites-worker.ts`、`lib/connector-context.ts` | 请求内服务端能力 | 托管请求上下文；开发辅助Worker | 平台撤销连接/请求到期 | 模板能力；实际Gmail使用独立OAuth服务，不由此绑定获得授权 |
| `MAIL_MODE` | `lib/server.ts`、`lib/operator.ts` | 服务端 | 部署环境；非`live`按预览 | 改为预览停真实发信；AI key仍存在时保持真实操作者门槛 | live或非空AI key要求真实允许操作者后再应用角色；配置不是用户授权的替代 |
| `MAIL_OPERATOR_EMAIL` | operator、Gmail服务 | 服务端 | 受保护部署配置 | 更换操作者后断开/重新OAuth；清理旧会话和state | 允许操作者标识，不写实际值进仓库；仅比较托管认证头，不能信任客户端自报 |
| `MAIL_BASE_URL` | Gmail来源/回调、邀请URL | 服务端 | 固定站点HTTPS源；OAuth服务本地可loopback | 域名改变需同步Google回调及重连 | 不含路径/query/用户信息；真实核对发送要求HTTPS，防请求Host注入链接 |
| `GMAIL_CLIENT_ID` | `lib/gmail.ts` | 服务端配置；OAuth URL可见ID | Google OAuth应用 | 在Google平台更换并重新授权 | 标识不是secret；回调固定`/api/gmail/callback` |
| `GMAIL_CLIENT_SECRET` | token交换/刷新 | 仅服务端 | secret管理/部署环境 | Google轮换后更新部署并验证重连 | 不在页面收集、不返回浏览器、不写日志 |
| `GMAIL_TOKEN_KEY` | AES-GCM加解密 | 仅服务端 | 32字节随机key的标准Base64 | 换key会使旧密文不可解密；当前无重加密迁移，需重新连接 | 12字节随机nonce+绑定行context；勿与数据库导出一起公开 |
| OAuth refresh/access token | `gmail.ts` | refresh加密D1；access请求内内存 | Google授权/刷新 | disconnect先删本地授权，再尽力Google revoke；可在Google账号侧撤销 | refresh密文在mail_settings，PKCE verifier也加密；不进入招聘快照/浏览器 |
| OAuth state/Cookie/verifier | OAuth connect/callback | state在官方URL；Cookie HttpOnly；D1只存state/Cookie哈希和加密verifier | 32字节随机，PKCE S256，10min | 一次消费、到期/下次connect清理、disconnect删除 | 绑定同一操作者ID/邮箱；防回调重放和错账号 |
| `DEEPSEEK_API_KEY` | `resume-ai.ts`由server传入 | 仅服务端 | 托管secret配置；模块真实调用已取得证据，整站验收另记 | 提供商撤销/轮换并更新部署；移除key停止后续请求 | 具外发/费用能力；缺失AI_NOT_CONFIGURED；非空key即使preview也要求真实操作者+HR；公开careers仅排pending不使用key |
| `DEEPSEEK_MODEL` | `resume-ai.ts` | 服务端 | 环境；源码默认`deepseek-flash` | 更换后重新验证结构/引文/岗位效果 | 实际响应model记录到报告；代码默认值不证明账号可用或效果通过 |
| `DEMO_PASSWORD_HASH` / 公开演示密码 | `lib/server.ts#login`；`Workspace.tsx`；烟测 | 服务端摘要 + 客户端公开演示值 | 源码固定 | 必须同步登录校验、前端和测试；要使已有会话失效需清会话表 | 用来演示流程，不是生产 secret；所有访问者可切换角色 |
| `recruitment_session` | 浏览器与 `getUser/login/logout` | HttpOnly Cookie | 服务端 32 字节随机；D1 仅存 SHA-256 | 登录删除当前旧会话，退出删除；12h 到期；未提供全员撤销界面 | 持有即拥有该演示角色；HTTPS 才附 Secure；不应写入日志/文档 |
| 核对 `token` / `tokenHash` | `candidate-review.ts`、核对 API/页面/Gmail 预览 | token 在一次签发响应、URL 和草稿中；哈希只在服务端状态 | 服务端 32 字节随机 | 默认 7 天；HR 重发撤销旧链接；可主动撤销；提交单次锁定 | token 不是候选人真实身份；不要记录到日志、截图或仓库；Gmail 草稿/浏览器历史可能留副本 |
| 面试答复`token` / 哈希 | `interview-invitation.ts`、server、独立答复页 | token在邮件fragment，业务库仅哈希；API读取/提交仍携token | 服务端32字节随机 | min(7天,开始时间)；排期/入会资料/主档邮箱变化或关闭撤销；答复单次锁定 | 邮件含单场入会资料，收件人用当前主档邮箱；摘要仅HR，不能据fragment推断API日志无token |
| careers `requestId`/`inputHash` | `careers.ts`、server | UUID公开提交；哈希/回执仅服务端幂等元数据 | 客户端UUID+规范化字段SHA-256 | 每次新投递新UUID；同内容重放复用旧回执，变内容409 | 不是身份或读取凭据；不接收私有candidateId；所有内部投影也去除元数据 |
| `BASE_URL` | 五组HTTP烟测 | 仅本地测试进程 | 环境变量，默认本地5173 | 每次指定可丢弃本地D1 | 新增记录；面试脚本还修改两条种子联系资料，不能对需保留数据的库运行 |
| `DEMO_PASSWORD` | 五组HTTP烟测的内部会话步骤 | 测试进程 | 环境变量，否则公开Demo密码 | 与演示登录同步 | 只改测试输入，不改网站密码；公开careers/token本身不依赖它 |
| `TEST_SITE_USER_ID` / `TEST_SITE_USER_EMAIL` | 五组HTTP脚本 | 仅本地测试请求头 | 测试进程同时设置两项 | 测完清除 | 仅模拟托管ingress；目标非loopback立即拒绝；不属于生产身份实现，不能证明线上注入/防伪造通过；不记录实际值 |
| `SITES_RUNTIME_ROOT` | `scripts/sites-env.mjs` | 本地工具 | 环境或项目 `.sites-runtime` | 换项目本地路径 | 非 secret，保存工具状态；忽略目录不随源码发布 |
| 本地 `executionProfile`、`CODEX_SANDBOX` | `scripts/run-framework.mjs`、`vite.config.ts` | 构建/开发工具 | `.sites-runtime/execution-profile.json`；宿主环境 | 重配本地执行环境 | 控制 portable/managed-linux、HMR 及本地 mock；不产生招聘角色授权 |
| `CLOUDFLARE_CF_FETCH_ENABLED`、`WRANGLER_SEND_METRICS`、`WRANGLER_WRITE_LOGS` | `vite.config.ts`、`scripts/sites-env.mjs` | 工具进程 | 默认 `false`，环境可覆盖 | 按环境设置 | 非应用 secret；托管访问日志另行管理，不能据本地关闭日志推断线上不记 URL |
| `WRANGLER_LOG_PATH`、`WRANGLER_REGISTRY_PATH`、`MINIFLARE_REGISTRY_PATH` | 同上 | 本地工具 | 默认项目内运行目录 | 清理/改路径 | 工具状态可能含调试数据；不应上传 `.wrangler`、`.sites-runtime` |
| `SITES_BUILD_TIMEOUT`、`SITES_BUILD_KILL_AFTER` | `scripts/build-verified.sh` | managed-linux 构建 | 环境，默认 3m/10s | 每次构建设置 | 只限制构建时间，不是 API 业务超时 |

`.gitignore`已忽略本地secret/运行目录。固定规则、careers及预览无需提供商secret；真实发信须完成网站OAuth，当前客户端配置不等于已授权或已真发。模型模块已单独真调用，不替代整站E2E；缺key/调用失败保留档案并明确状态，不生成假报告。

本地填写secret与线上配置是两步：忽略的本地配置文件不会自动启用线上，须由托管平台secret配置并重新部署；文档只维护名称，不记录其值。

## 固定业务限制

| 常量/上限 | 执行位置 | 拒绝或边界 |
| --- | --- | --- |
| 会话 12h | `lib/server.ts#SESSION_MS` | 过期后重新登录；过期行在下次登录清理，没有定时清理任务 |
| 邀请 7 天、256 位 token | `lib/candidate-review.ts#TTL/newReviewToken` | 过期读写 410；token 哈希仅用于查找，不是可直接使用的链接 |
| JSON 请求 6 MiB | `lib/server.ts#readBody` | 按 UTF-8 字节流式累计，超限立即中止读取并返回 413；接受正好达到上限的有效 JSON 对象 |
| 状态 JSON 1,900,000 字节 | `lib/server.ts#saveState` | 超限 413，CAS 前拒绝，不损坏原状态；不能据 CSV 上限推断全库容量 |
| CSV 界面 1 MiB；解析器 5 MiB/1000 行 | CSV 表单；`lib/csv.ts` | 前端与接口各有约束；整请求/状态限制可能更早触发 |
| 简历 3 MiB、100,000 字符；PDF 20 页/30s；DOCX 正文 2 MiB/512 个 ZIP 项 | `lib/resume-file.ts` | 本地解析时拒绝；不支持 OCR、旧 DOC、加密或损坏文档 |
| careers正文100,000字符、姓名80、邮箱254、技能30项/项60 | `lib/careers.ts` | 姓名/邮箱/有效正文/consent=true必需；教育与届别可未知；顶层/候选人字段严格白名单；共享请求/状态上限仍适用 |
| OAuth 10min；Gmail action 2KiB；提供商请求12s；发送占用2min后视为unknown | `gmail.ts`、`gmail-request.ts` | 超限流取消；一次state；同邀请不盲重发，过时sending不当作failed |
| 模型45s；输出4000tokens；证据3–10/问题1–5 | `resume-ai.ts` | DeepSeek JSON Output，应用Zod strict长度/枚举/额外字段校验；thinking disabled，非流式；引文不在两份原文中拒绝，无自动模型重试 |
| 会议URL 2048字符、会议号80、密码100 | `interview.ts`、`engine.ts` | URL仅HTTPS且无嵌入账号密码/空白控制符；入会资料只存授权投递/面试范围，匿名化同步清理 |
| 模型/邮件业务摘要补写CAS最多3次 | `server.ts` | 模型校验快照/岗位/请求时间；邮件以独立mail_jobs对账；并非外部调用重试3次 |
| 筛选/核对字段长度与枚举 | `lib/selection.ts`、`lib/candidate-review.ts` | 服务端校验；核对只准九项资料，不允许输入阶段、分数、职位或录用决定 |
| 时区 `Asia/Shanghai` | 入职日期判定、UI 日期转换及邀请期限文案 | 业务日期以北京时间解释；时间戳保存 ISO，计划/实际日期需遵守日期门禁 |

## 生产接入前必须补齐

以下是当前 Demo 与真实招聘部署的差距，不代表本轮已完成：

- 将公开演示账号换为受管身份/SSO、组织成员和角色来源，支持撤销会话与离职回收；明确页面和候选人入口的受众设置。
- 将个人资料放入适合规模的业务表/附件存储，定义租户隔离、保留期限、备份、恢复演练及删除副本范围；单行 JSON 的扩容不能靠放大上限解决。
- 核查托管身份头、内部角色及公开careers/token的分离。Gmail已有加密/回执/幂等，客户端配置后仍待OAuth和真实投递；模型模块真调用不证明公开入口、HR调用、保存和报告展示的整站链路，均需最终验收。日历/其它服务另行接入。
- 核查发布产物、平台日志和外部提供商不泄露 Cookie/token/个人资料；确定限流、监控、告警与事故处置。当前源码检查不能替代平台侧验证。
- 用 [tests.md](./tests.md) 的缺口安排容量、恢复、真实外部核对与端到端浏览器验收；不能把合成样本通过当成生产许可。
