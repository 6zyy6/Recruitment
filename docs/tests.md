# 业务规则与验证映射

本文映射核心、careers、Gmail、会议/邀请及DeepSeek测试。`existing`表示检查已存在，最终数量与结果只看VERIFICATION；历史数字不代替共享冻结版结论。模型模块单独真实调用也不等于整站E2E；v8已有本人单封真实收信、匿名核对及HR回写记录，邮件外部闭环的逐项结果只看VERIFICATION，不能由mock替代。

依据来自 [architecture.md](./architecture.md)、[flows.md](./flows.md)、[permissions.md](./permissions.md)、[variables.md](./variables.md)、[automation.md](./automation.md) 与 [GMAIL-INTEGRATION.md](./GMAIL-INTEGRATION.md)。历史核心补强曾通过82项及typecheck，HTTP主流程18/18（`mvfk3clq`）、甄选13/13（`mvfk86m0`）、核对10/10（`mvfk3ew2`）共41组；这些是新增真实模型/Gmail集成前的版本证据。最终全量数量、失败修复、构建和部署事实只在 [VERIFICATION.md](../VERIFICATION.md) 归档，不用历史数字描述当前全量通过。

## 现有覆盖（existing）

| 用例 → 规则 | 预期行为及拒绝情况 | 文档与实现来源 | 仓库证据 | 状态 |
| --- | --- | --- | --- | --- |
| 职位需求 → 分权审批 | HR 建需求并提交；负责经理审批；HR/其他经理不得代批；校招字段需完整 | flows §2；`engine.ts#createJob/jobStatus` | `engine.test.ts`：`HR cannot publish without manager approval...`；`api-smoke.mjs` 社招/校招审批 | existing |
| 职位关闭 → 在途投递完整性 | 有活动投递拒绝关闭，处理完后才能关闭 | flows §2；`engine.ts#jobStatus` | `engine.test.ts`：`jobs with active applications cannot close...` | existing |
| 文件/字段识别 → 不编造候选人事实 | 文字编码/格式/大小校验；缺失/冲突留空；工作年份、岗位要求、推荐人不冒充本人事实；原文指令当数据 | flows §3；`resume-parser.ts`、`resume-file.ts` | `resume-parser.test.ts` 的 15 项文件/字段测试；PDF/DOCX 成功解析另有历史人工记录 | existing；PDF/DOM 成功分支非本地单测覆盖 |
| 主档/投递 → 联系方式、同人多岗与去重 | 标点/过短/超长电话拒绝，国际格式有效；明确关联独立投递；同岗活动投递幂等；重复联系方式不能静默合并 | flows §3；`engine.ts#candidateFields/createApplication/duplicateCandidate` | `engine.test.ts` 的电话、重复联系人、明确关联、冲突身份用例；`candidate-review.test.ts` 电话校验；`api-smoke.mjs` 同人多岗 | existing |
| CSV → 部分成功与重试 | BOM/引号/换行可解析；无效行拒绝；重复需明确关联；成功行重试不再创建 | flows §3；`csv.ts`、`engine.ts#importPreview/importCommit` | `engine.test.ts` CSV、批次冲突用例；`api-smoke.mjs` 部分成功 | existing |
| 核对签发 → 只有 HR 能授权 | 匿名/其他角色拒绝；当前revision；有效邮箱；256位随机、仅存哈希、7天；未明确发送保持preview | flows §4；`candidate-review.ts`、`server.ts` | `candidate-review.test.ts` 安全token/HR/邮箱/投影；`review-delivery.test.ts` 预览/待发送；核对HTTP基线 | existing |
| 核对读取/提交 → 最小资料与一次确认 | 白名单读写；明确确认；版本冲突不写；过期/撤销/已使用/进入 Offer 返回 Gone；重发旧 token 失效 | flows §4；permissions；`candidate-review.ts` | `candidate-review.test.ts` 白名单/注入/期限/重放/版本/重发用例；对应 HTTP 脚本 | existing |
| 核对更正 → 不串投递、不误失效 | 更正主档及本投递；清本投递旧筛选和经理决定；保留测评及其它投递；原样确认保留结论；都不晋级 | flows §4；`submitCandidateReview` | `candidate-review.test.ts` 更正、已有经理决定、原样确认三个用例；HTTP 更正场景 | existing |
| 条件初筛/复筛 → 政策与真实报告边界 | 新投递自动按本岗位快照初筛；unknown/missing保留并允许请求模型；复筛须完成当前初筛且有原文；旧报告不冒充llm；改规则/重跑/更正使当前决定失效 | flows §5；`selection.ts`、`resume-workflow.ts` | `selection.test.ts` 自动初筛、宽进及CSV正文边界；`resume-workflow.test.ts` 缺项保留/无正文/过期/迟到；`engine.test.ts` 宽进不绕过HR及后续门禁；legacy `runResumeReview`确定性测试仅证明旧辅助函数 | existing；最终HTTP需新版合同回归 |
| 人工复核 → AI不得自动淘汰/推进 | 通过需当前初筛及mode=llm复筛和依据；待核实不晋级；只有HR人工拒绝才关闭/取消 | flows §5；`selection.ts#confirm_screening` | `selection.test.ts` 人工通过/拒绝/当前报告用例；AI流程单测证明不自动批准 | existing |
| 已采用甄选 → 推进/录用不能绕过当前 HR 通过 | 新甄选资料未通过、报告重跑后结论失效，应拒绝推进、经理录用及发 Offer；旧 V1 路径保持兼容 | flows §5/§7；`engine.ts#screeningApproved`、`selection.ts` | `engine.test.ts`：`new screening records require current HR approval before advancing or hiring`；V1 筛选兼容用例 | existing |
| 测评 → 答卷合同与不可自动录用 | 题目快照；非法种类/重复待答/未知题目/非法选项/不完整拒绝；提交锁定；偏好无总分/诊断；文本规则引用原答案 | flows §6；`selection.ts` | `selection.test.ts` 测评 5 类用例；`selection-smoke.mjs` 三类答卷与锁定 | existing |
| 面试 → 时间与资源一致 | 过去/无效时间拒绝；面试官及跨岗位同候选人重叠拒绝；取消释放；改期需重新通知 | flows §6；`engine.ts#validateInterview` | `engine.test.ts`：`scheduling detects interviewer and cross-job candidate overlaps...` | existing |
| 会议资料 → 安全入会与旧记录兼容 | HTTPS无嵌入账号密码；会议号/密码限长；改期保留未提交字段、可清空；旧时段不变可补资料，新/改过去时段拒绝；匿名化清理 | flows §6；`interview.ts`、`engine.ts` | `interview.test.ts` 10项；[meeting-handoff.md](./meeting-handoff.md) 历史人工及单独测试记录 | existing；不证明自动建会或面试邮件已完成 |
| 评价 → 独立、锁定、可理由退回 | 未完成面试/缺评分证据拒绝提交；草稿仅本人；提交前不见同伴；提交后锁定；退回清经理决定/辅助报告 | flows §6；permissions；`engine.ts` | `engine.test.ts` 盲评/锁定/退回；`selection.test.ts` 辅助报告；`api-smoke.mjs` 双面试官 | existing |
| 辅助报告 → 本人独立评价在先 | 提交前/他人评价拒绝；只本人可见，原评分保持，不读取同伴意见 | flows §6；`selection.ts#interviewAssist`、`projectState` | `selection.test.ts`：`interview assist requires independent submitted own scorecard...` 及权限用例 | existing |
| 录用与 Offer → 人工门禁 | 负责经理留据且完成面试/评价收齐才可录用；HR 发 Offer 再核对，待面试不能跳过；到期需明确确认 | flows §7；`engine.ts` | `engine.test.ts` 完整闭环、评价未齐、Offer 到期；`api-smoke.mjs` | existing |
| 实际入职 → 答复/协议不可替代到岗 | 接受 Offer 仅待入职；校招签署/豁免后才能确认；社招无校招门槛；未来实际日期/提前未到岗拒绝 | flows §7；`engine.ts#offerResponse/agreement/join` | `engine.test.ts` 完整闭环、社招/校招协议；`api-smoke.mjs` 分步状态 | existing |
| 会话与角色 → API 侧实际隔离 | 未登录/错误密码 401；Cookie 属性正确；重新登录旧 token 失效、退出立即失效；经理/面试官资源范围；管理员无业务读写 | flows §1/§8；permissions；`server.ts`、`projectState` | `engine.test.ts` 权限；`selection.test.ts` 甄选隔离；`api-smoke.mjs` 会话轮换/退出及 Cookie 属性；三个 HTTP 脚本 | existing；12h 自然到期未完整覆盖 |
| HTTP 输入 → 早拒绝、不修改数据 | 仅接受 JSON 对象；按 UTF-8 字节限制 6 MiB，超限流中止；匹配/缺失 Origin 允许，外站 Origin 403；错误响应 no-store | flows §1；variables；`server.ts#readBody/checkOrigin/errorResponse` | `server.test.ts` 全部 5 项；`api-smoke.mjs` 三入口异常 JSON/超限及 Origin 状态不变检查 | existing |
| 写入并发 → 旧页面不能覆盖 | expectedRevision 不匹配拒绝且源状态不变；并发签发 D1 CAS 只允许一次提交 | flows 通用；`applyAction`、`saveState` | `engine.test.ts` 乐观版本；`api-smoke.mjs` 旧 revision；`candidate-review-smoke.mjs` 并发 CAS | existing |
| 合成资料清理 → 清理存储副本 | 主档、投递、备注/导入行、甄选/答卷、核对 token/快照都清理；保留去标识流程 | flows §8；`engine.ts#anonymizeCandidate` | `engine.test.ts`、`selection.test.ts`、`candidate-review.test.ts` 三组匿名化回归 | existing；不涵盖平台日志/外部副本 |
| 指标 → 同 cohort 与事件口径 | 10/6/4/2/1/1 对账，人数去重；筛选先于汇总；截止时间/日期边界；零分母未知；反馈分母排除不成熟/取消/未到场 | architecture §核心模块；`metrics.ts` | `metrics.test.ts` 全部 5 个用例 | existing |
| 操作者 → 真模型/邮件不向公开Demo开放 | live或非空AI key必须真实允许Sites ID/邮箱；Demo Cookie/query/body不能替代；缺配置/未认证/他人拒绝 | permissions；`operator.ts` | `operator.test.ts` 身份/配置/替代声明/preview+key门禁；`gmail.test.ts` 操作者与来源 | existing；托管入口头可信性另需集成验收 |
| Gmail OAuth → 可验证且可撤销的发件授权 | state/Cookie/ID/邮箱/10min/一次消费/PKCE；verified发件身份和send scope；只存AES密文；断开中迟到callback不重连 | flows §9；`gmail.ts`；GMAIL-INTEGRATION | `gmail.test.ts` 加密、PKCE、scope/state、断开与callback并发用例；提供商全部mock | existing |
| Gmail发送 → 回执与幂等 | 单收件人/MIME防注入；邀请ID原子claim、同ID不重发；2xx+ID才sent；5xx/网络/无ID/发送后写库失败unknown | flows §4；`gmail.ts` | `gmail.test.ts` MIME/并发/成功/拒绝/中断/写库失败/本地回执查找 | existing；无真实投递结论 |
| 回执回填 → 不改事实、隔离新旧邀请 | pending/unknown阻止再真发；合法messageId；已sent不降级；回执重复幂等；旧回执不覆盖新摘要/同人其它投递 | flows §4；`recordCandidateReviewDelivery` | `review-delivery.test.ts` 预览/回执/迟到/多岗/不确定状态用例 | existing |
| 模型出站/输出 → 有依据而无能力分 | 脱敏已知标识、缺key零外发；固定DeepSeek端点/json_object/禁thinking；应用严格schema、无score、逐字quote；未完整/拒绝/假引文失败；脱敏错误不露key | automation；`resume-ai.ts` | `resume-ai.test.ts` 出站payload/schema/引文/错误与model元信息用例，均mock | existing；不等于真实调用通过 |
| 模型迟到 → 不覆盖新资料 | 当前初筛+正文即可pending，missing/unknown保留关注；无规则/无正文/过期才blocked；相关事实/岗位/关闭/新请求后结果丢弃，失败保留档案 | automation；`resume-workflow.ts` | `resume-workflow.test.ts` 宽进、blocked、绑定/迟到/失败用例 | existing |
| 面试邀请 → 预览/模板/唯一发送 | HR+当前revision、筛选和未来排期/冲突校验；用主档当前邮箱；预览无写；UUID去重；pending/sent/unknown禁止再发，failed可明确重试 | flows §10；`interview-invitation.ts` | `interview-invitation.test.ts` 预览/字段/权限/冲突/重复用例；`interview-invitation-server.test.ts` CAS先存pending/并发/真实权限/回执修复 | existing；Gmail边界mock |
| 面试答复 → 独立权限与双状态 | 最多7天/开始失效；仅本场必要信息；版本/改期原因校验，答复锁定且不自动改时间/阶段；邮件接受不代表确认参加 | flows §10；`read/submitInterviewInvitation` | `interview-invitation.test.ts` 最小返回/期限/答复/迟到回执；API本地smoke | existing |
| 邀请生命周期 → 恢复旧值不复活 | 排期/会议资料/主档邮箱变化撤销；迟到旧回执不替代新摘要；非HR隐藏收件人/答复/完整token；匿名化清理 | flows §10；`engine.ts`、邀请模块 | `interview-invitation-lifecycle.test.ts` 四类回归；服务端重复读取unknown无写/重复审计用例 | existing |
| live入口 → 真实身份与公开token分离 | 公开Demo密码/Cookie及其他Sites账号不能碰D1/Gmail；允许账号仍需D1；公开核对/面试token不要求管理登录 | permissions；`server.ts`、`operator.ts` | `live-mail-api.test.ts` 入口/错误指导/公开token路径；mock无真实外发 | existing；最终类型检查另记 |
| careers公开合同 → 无内部state | 仅开放职位十字段；提交姓名/邮箱/正文/同意+UUID，严格白名单；新建独立主档，不关联已有私档；最小回执 | flows §11；`careers.ts`、公开API | `careers.test.ts` 公开字段/独立主档/校验/未知/100k正文；careers-smoke | existing；原checkout专项结果不代表冻结版 |
| careers幂等/并发 → 只写一次 | 同request同规范化内容回原回执且revision不变，即使职位后关闭；改内容409；同岗匹配联系方式通用冲突；CAS竞争重算 | flows §11；`submitCareerApplication/careersAction` | `careers.test.ts` 幂等/重复/并发重算；careers-smoke实际D1双POST | existing |
| careers与模型/HR门禁 → 公开无费用、不走V1 | 公共新投递含当前规则/AI pending，无模型fetch、无自动发信/晋级；授权HR后续ensure；缺HR通过不能推进/录用 | flows §11；careers/selection/workflow/engine | `careers.test.ts` 匿名unknown/差异零fetch、新投递不能绕历史门禁 | existing |

### 当前检查入口与门禁

- `npm test`：Node内置测试运行器执行`tests/*.test.ts`，包括新增Gmail/operator/delivery/interview/resume-ai/workflow文件。历史六文件82项基线仅作版本对比；新全量数量与结果看最终执行记录。mock只验证应用合同，不会验证真实提供商。
- `npm run typecheck`、`npm run lint`、`npm run build`：分别检查类型、静态规则和部署构建。lint/build 的通过情况必须看本次输出，不能由单测替代。
- `npm run test:api`串行五组：workflow/selection/review/interview/careers；仅可丢弃本地D1。脚本新增样本，面试脚本还修改两条seed联系资料；其`--mail-disabled`要求mailReady=false且无真发，不应对保留库执行。基础脚本显式`--reset`才清库，但无reset不表示完全只新增数据。
- `TEST_SITE_USER_ID/EMAIL`须成对配置，仅允许loopback，模拟可信ingress来走live/AI本地管理路径；非本地目标拒绝。测试不会证明线上身份头注入/剥离伪造头，需独立托管集成证据。
- 当前仓库没有 CI workflow 或可证实的合并强制检查设置。[README](../README.md) 定义本地验证入口，[VERIFICATION.md](../VERIFICATION.md) 保存实际执行证据；发布还需完成对应人工界面验收。测试通过不等于原 Spec 全部场景、真实外部邀请或生产运行指标通过。

## 建议新增的测试（proposed，尚未实现或尚未固定为可重复检查）

| 用例 → 规则 | 预期/拒绝情况 | 证据来源 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 会话自然到期 → 凭据生命周期 | 注入时钟/到期记录，12h 到期后原 Cookie 返回 401，不能靠客户端时间延长 | flows §1；variables；`server.ts#getUser` | 自动化集成 | proposed；轮换/退出及 Cookie 属性已有 HTTP 覆盖 |
| 状态容量 → 有界持久化 | 达 1,900,000 字节上限拒绝且旧 revision/payload 不变；边界内可保存 | variables；`server.ts#saveState` | 自动化集成 | proposed |
| PDF/DOCX 浏览器解析 → 成功及异常分支 | 文字 PDF/DOCX 正确，扫描/加密/20 页以上/超时拒绝；解析无外部上传；重复上传替换需明确操作 | flows §3；`resume-file.ts`、`CandidateIntake.tsx`；既有人工验收记录 | 自动化浏览器集成；解析对照人工复核 | proposed |
| public 核对入口 → 实际受众 | 干净浏览器不登录应用也可凭有效 token 核对；无 token 无资料；提交后锁定；noindex/referrer 与缓存头正确 | architecture 公开路由；flows §4；核对页面及 API | 受控线上合成测试 | proposed |
| 真实Gmail → OAuth/收信闭环 | 允许Sites操作者完成Google授权；明确发送合成邀请；Gmail消息ID/收件人访问提交/HR回填分别核对；错误/unknown不假报送达 | flows §4/§9；GMAIL-INTEGRATION；服务端和UI | 受控线上 + 人工收信复核，按用户已授权测试范围 | v8 单次人工真实闭环已通过；固定可重复外部回归仍 proposed，mock不能替代 |
| 真实模型整站 → 权限/保存/报告与效果 | 单独模块调用已取证；仍需整站HR入口真实请求、逐字证据回写/展示、匿名careers不付费、非HR拒绝；不以模块请求替代全部E2E | automation；server、resume-ai、careers | 受控整站集成 + 岗位相关人工评估 | proposed；模块证据及最终结果分别记VERIFICATION |
| 真实面试邮件 → 外部闭环 | 核对候选人当前主档收件邮箱、会议资料与真实消息ID；外部打开确认/改期申请，HR回写；已实现的模板/幂等mock不能代替收信 | flows §10；[interview-invitations.md](./interview-invitations.md) | 受控线上合成投递 + 人工收信/浏览器复核 | proposed；已有单测/本地HTTP另列existing |
| Gmail备用草稿 → 不混淆回执 | 预览正确；打开草稿不写sent；unknown/sending先核对发件箱，不能诱发重复邮件 | flows §4；两个邀请组件 | 人工复核/浏览器集成 | proposed |
| 任意资料字段 → 投影不泄露联系方式 | 同一组电话/邮箱变体放入每个可返回自由文本字段；面试官响应无匹配敏感文本；HR/经理保留授权内容 | permissions；`projectState/redactText` | 自动化属性/回归测试 | proposed，现有定点脱敏测试不等于穷尽 |
| 界面端到端 → 错误不显示成功 | 完成六模块关键流程；409 刷新并保留可重试反馈；角色切换无旧数据残留；键盘/小屏可用 | flows；`Workspace.tsx` 与相关组件；历史人工记录 | 自动化浏览器 + 人工可用性复核 | proposed，尚无提交到仓库的浏览器测试套件 |

## 未覆盖的交付差距（none）

按越过边界时的暴露程度排序。这里的 `none` 表示当前无足够验证，也可能连能力本身尚未实现，不能将其计为通过。

| 优先级/用例 → 规则 | 预期与负例 | 文档与实现证据 | 状态 |
| --- | --- | --- | --- |
| 高：真实身份/租户 → 非员工不能读写招聘资料 | 受管身份、成员回收、多租户跨组织拒绝；公开 Demo 密码不能代表身份验证 | architecture 身份/风险；固定 `DEMO_USERS` 与公开密码 | none；生产 SSO/多租户未实现 |
| 高：真实个人资料 → 全生命周期保护 | 保留期限、用户权利请求、导出权限、日志/备份/外部副本删除，运维访问可追踪 | permissions 数据边界；匿名化仅覆盖当前 D1 状态 | none；完整资料治理未实现 |
| 高：备份/恢复 → 故障后可恢复并对账 | 隔离环境恢复、验证 revision/关系/会话策略；损坏数据不得静默丢弃 | architecture 已知限制；`loadState` 直接解析 JSON | none；无备份恢复演练/修复工具 |
| 高：负载/滥用 → 容量和可用性 | 大规模投递、并发写、限流、登录暴力尝试；故障告警有响应 | variables 容量；单行 CAS、无生产限流/监控配置 | none；无生产容量或可用性证明 |
| 中：审计 → 所有受保护变化可追责 | 职位审批、会话/拒绝、运维操作有独立审计；不可被业务重置覆盖 | architecture 审计限制；当前仅同库 `events` | none；不是不可变审计系统 |
| 中：未接入外部集成 → 不伪报成功 | 日历创建/冲突、电子签、HRIS、渠道同步；自动收信/退信/已读回执 | architecture；现有Gmail仅发信无阅读scope，会议资料手动录入 | none；这些能力未实现/未验证，Gmail发送代码不证明收件 |
| 中：模型/专业测评 → 有效性与偏差 | 真实模型岗位效果、适用人群、公平性与人工复核；专业问卷信效度；严格引文不等于语义/公平通过 | automation；真实复筛代码+固定规则测评 | none；无系统效果/偏差评估，专业心理量表未接入 |
