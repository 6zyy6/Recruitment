# 受保护业务流程

本文依据已落盘核心规则、Gmail OAuth、面试邀请及DeepSeek复筛代码；最终提供商切换、真实调用与部署验收见 [VERIFICATION.md](../VERIFICATION.md)。

本文记录影响权限、资料完整性和外部副作用的路径；角色范围以 [permissions.md](./permissions.md) 为准。用户发起内部业务修改携带当前 `expectedRevision`，业务规则后执行 D1 CAS；冲突返回 409，前端刷新重试。模型结果及邮件回执的服务端补写以最新状态作 CAS，另校验请求/邀请归属，不依靠客户端旧 revision 覆盖。

live身份门禁仅保护内部管理：公开careers职位/新投递及两类token答复独立放行，不返回内部state。匿名投递只建立初筛/AI待处理状态，后续付费调用仍须授权HR。公开提交的UUID/幂等和CAS见§11。

## 1. 建立或退出应用会话

参与者：演示使用者。前提：选择固定 Demo 用户。成功：得到该用户的 12 小时应用会话。

| 步骤/边界 | 权限与拒绝行为 | 写入或副作用 |
| --- | --- | --- |
| live 身份入口 → 应用会话 | live 或配置AI key时要求 Sites 认证的允许操作者；缺配置503、未登录401、他人403；之后才检查 Demo 用户/密码 | 真实操作者约束和应用角色同时成立；托管入口必须保证身份头来源 |
| `Workspace.tsx` → `POST /api/session` | `readBody` 限制 JSON 对象与请求大小；有 Origin 且不匹配时 403；账号/密码错误 401 | 浏览器不能提供角色声明来提权 |
| `server.login` → D1 `sessions` | 身份来自 `DEMO_USERS`；公开 Demo 密码仅适合合成资料 | 删除当前旧会话及已过期记录；保存新随机 token 的哈希和过期时间 |
| API → 浏览器 | Cookie 为 HttpOnly、SameSite=Lax，HTTPS 时 Secure；响应 `no-store` | Cookie 保存原始 token，客户端 JS 不直接读取 |
| `DELETE /api/session` → D1 | 同一 Origin 规则；按当前 Cookie 定位会话 | 删除哈希记录并清空 Cookie；不删除业务资料 |

证据：`app/api/session/route.ts`、`lib/server.ts`；错误密码/未登录 HTTP 用例在 `scripts/api-smoke.mjs`。生产身份治理未实现。

## 2. 职位从需求到开放

参与者：HR、该职位负责经理。前提：有效应用会话。成功：审批后的职位可以接收投递。

| 步骤/边界 | 权限与拒绝行为 | 状态变化 |
| --- | --- | --- |
| 工作台 → `createJob` | 服务端仅 HR；人数、类型、经理有效；校招缺批次/届别拒绝 | 新职位为 `draft`，服务端保存 owner 与 manager |
| HR → `jobStatus` 提交 | 仅允许定义的状态转换 | `draft → pending` |
| 经理 → `jobStatus` 审批/驳回 | 必须 `role=manager` 且 `job.managerId=user.id`；HR 或其他经理不能审批；驳回需原因 | `pending → open/draft` |
| HR → 暂停/恢复/关闭 | 仅 HR；有活动投递时关闭被拒绝 | 暂停不接新投递；恢复开放；关闭为终态 |

证据：`lib/engine.ts` 的 `createJob`、`jobStatus`，对应 `tests/engine.test.ts`。职位状态变化没有独立不可变审批账本；投递时间线不能代替它。

## 3. 简历入库、关联与 CSV

参与者：HR。前提：职位为 `open`。成功：创建一个主档和本次独立投递，或明确关联既有主档。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| 本地文件 → 浏览器解析 | `resume-file.ts` 校验格式、3 MiB、PDF 20 页及结构；扫描/加密/损坏/旧 DOC 拒绝；解析结果仅为待核实字段 | 原文件不上传；规则原文及证据显示供 HR 核实 |
| 浏览器 → `createCandidate` | HR、开放职位、至少一种合法联系方式；重复联系方式409；前端提取结果仍待核实；live或AI key启用还要求真实操作者 | 保存主档/独立快照，自动线索初筛；完成且有原文即排入模型复筛，缺项不阻止，不自动晋级 |
| HR → `createApplication` | 明确选定已有候选人；同岗仍活动的投递返回已有记录 | 同人其它岗位另建快照；不修改既有投递 |
| CSV → `importPreview` | HR、开放职位；CSV/单行/联系方式校验，冲突标到行；界面 1 MiB，CSV 解析器 5 MiB/1000 行上限 | 保存预检批次，没有批量静默覆盖 |
| HR → `importCommit` | 重复档案必须明确 `linkDuplicates=true`；重新校验；成功/错误/跳过行不重复执行 | 部分成功逐行保存，新建/关联投递；重试不重复建成功行 |
| HR → `updateCandidate` | HR 与联系方式冲突校验 | 只更改主档，历史投递快照保持；相关投递留 `profile_updated` |

证据：`CandidateIntake.tsx`、`lib/resume-file.ts`、`lib/resume-parser.ts`、`lib/csv.ts`、`lib/engine.ts`；文件、提取、重复关联、部分成功和幂等测试见 [tests.md](./tests.md)。

## 4. 候选人资料核对与邀请

参与者：HR、持有有效令牌的候选人。前提：投递活动且在新投递/筛选/面试阶段，有有效邮箱。成功：一次确认并锁定，仅更正授权字段。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| HR → `POST /api/candidate-review` 签发 | HR、当前 revision、可编辑投递/有效邮箱；默认预览；明确 `sendEmail=true` 还要求真实操作者、live、Gmail已连接、固定公开HTTPS地址；前次 pending/unknown 需先核实撤销 | 256 位 token 仅存哈希；7天；新邀请撤销旧待核对；写审计；发送模式先写 pending |
| 服务端 → HR 浏览器 | 本次响应给链接/预览；快照移除整个 token 存储集合 | 无发送请求维持 preview；前端“发送”入口会明确请求发送，未配置失败，不能显示伪成功 |
| 已确认发送 → Gmail API | 服务端校验操作者/来源；按邀请 ID 原子占用mail_jobs；验证已连接邮箱及安全 MIME，刷新 token 后再查连接版本 | 一次提供商POST；2xx且消息ID才能 sent；拒绝 failed；提交后网络/5xx/无ID unknown，不盲重试；摘要CAS补写，读取快照可从本地回执对账 |
| 用户选择人工备用 → Gmail 草稿 | 仅用户主动打开 compose URL；unknown/sending 先核对发件箱避免重复 | 将预览及链接交给Gmail；用户最终发送；草稿路径本身不能取得网站发送回执 |
| token 页面 → `GET /api/candidate-review` | 不需应用 Cookie；token 哈希匹配、未过期/撤销/使用，投递可编辑，签发后资料未变；失效 410，资料冲突 409 | 仅返回本人九项资料、职位标题/类型与期限；不返回简历原文或 HR 数据；`no-store/no-referrer` |
| 页面 → 提交确认 | token 同上，加当前 `expectedVersion`、`confirmed=true` 和字段白名单；注入阶段/评分等字段、联系方式冲突拒绝；CAS 冲突 409 | 原样确认保留结论；真实更正仅更新主档和本投递，清本投递旧筛选及经理决定，保留测评/其它投递；均不晋级 |
| 成功提交/撤销 | 单次锁定，重复读写 410；HR 可撤销待核对邀请 | 提交后页面移除地址栏 token；服务端记录 `candidate` 审计；撤销使旧 token 立即无效 |

令牌拥有者可代表候选人提交，并非已认证的真实候选人身份。public 可访问、Gmail接受、收件人送达/已读是不同证据，均须单独记录。证据：`lib/candidate-review.ts`、`lib/server.ts`、`lib/gmail.ts` 及核对组件；单测/HTTP基线与真实投递验收分开，详见 [GMAIL-INTEGRATION.md](./GMAIL-INTEGRATION.md)。

## 5. 条件、资料证据与人工筛选

参与者：HR；负责经理只读。前提：投递活动且未进入 Offer。成功：保存可回溯依据与独立人工结论。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| HR → 配置岗位条件 | 仅 HR；学历枚举、技能与届别限额校验；关闭职位拒绝 | 保存政策版本时间；历史报告留原政策快照；活动且 Offer 前投递的 HR 结论及经理决定失效 |
| 新投递/HR → 条件初筛 | 服务端固定规则；当前政策；宽进整理线索，missing/unknown保留并交后续核实，不阻止模型请求；未提及不当作不具备 | 保存初筛证据；重跑清旧复筛/人工结论及经理决定；不晋级/淘汰 |
| 初筛完成 → `generateResumeReview` | 真实允许操作者+HR、活动且Offer前、有简历；服务端key；初筛需当前且有证据记录，无全部命中要求 | 先CAS保存投递/pending，再向固定DeepSeek Chat Completions API发脱敏原文与岗位要求；45s超时、无自动重试；批量多条仅保存待处理，详情`ensure_resume_review`再触发 |
| 模型 → 验证/回写 | 完整响应、严格JSON结构、matched非空引文、所有引文须同时存在于原文及脱敏原文；比对快照/岗位/请求时间；迟到结果不写 | 无数值分/自动决定；合法报告保存model、policy、证据、缺口和待问问题；失败保存failed/message且无假报告；结果CAS最多重试3次 |
| HR → 核实投递资料 | 学历/技能/届别有效，必须留 5–2000 字符依据 | 只改本投递并重做初筛；清旧复筛、人工结论、筛选备注及经理决定；主档/其它投递/测评保持；满足条件后可重新请求模型 |
| HR → 人工通过/待核实/拒绝 | 仅HR；必须留依据；通过需当前初筛及`mode=llm`复筛，旧固定规则不冒充真实报告；过时拒绝 | 通过/待核实只记录；人工拒绝关闭投递并取消待面试；报告自身没有关闭权限 |
| HR/经理 → 后续推进/录用 | `engine.ts#screeningApproved` 对已有 `selection` 的投递要求当前初筛、复筛及 HR 通过；在进入面试、经理录用和发 Offer 都检查 | 更正/重跑后不可复用旧 HR 或经理决定；高分不代替人工职责确认 |

证据：`lib/selection.ts`、`lib/engine.ts`、`lib/resume-ai.ts`、`lib/resume-workflow.ts`；硬规则见 [automation.md](./automation.md)。历史V1无甄选字段才兼容旧人工路径，新投递含careers都自动建立selection；初筛宽进，未知/差异不拦模型。单独模型真实调用已有证据，整站HR入口/公开路径/HTTP全链路仍由最终验收分别确认。

## 6. 测评与面试协作

参与者：HR、被分配的面试官、负责经理。成功：原始答卷与独立评价可核查，辅助报告不覆盖人工评分。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| HR → 指派/代录测评 | 仅 HR；投递活动且未到 Offer；同类待答卷不能重复；未知题目、非法选项、不完整答案拒绝 | 题目快照、原答案、规则判分及证据保存；提交锁定；不晋级；没有外部考试邀请 |
| HR → 排期/改期/结果确认 | HR；面试阶段活动；新/改时间不得过去、≤8h，重叠409；旧时段完全不变允许补会议资料；会议URL须HTTPS无账号密码，号/密码限长 | 保存面试及手动建会资料；未提交会议字段保留、可清空；改期/资料修改清通知；不自动向腾讯等平台建会 |
| HR → 面试邮件邀请 | 当前筛选通过、未来有效排期、当前主档邮箱；真实发送另验证Gmail操作者与授权 | 预览后明确发送，邮件与答复双状态；详细模板、幂等、改期失效及候选人流程见§10与 [专项文档](./interview-invitations.md) |
| 分配面试官 → 评价草稿/提交 | 必须本人属于该面试；只能填自己；提交需 HR 确认完成、全部 1–5 分、事实依据及建议；已提交锁定 | 草稿只本人可见；本人提交前不返回同场同伴评价，提交后仅返回同伴已提交评价 |
| 本人 → 生成辅助核对 | 仅本人已提交评价；未提交/他人评价拒绝；经理还需负责岗位 | 只整理本人分数和证据，不读取同伴意见，不另行改分；其他用户不返回此辅助报告 |
| HR/负责经理 → 退回评价 | 必须面试阶段活动投递、已提交评价和退回原因；Offer 后拒绝 | 解锁为草稿，清辅助报告和经理录用结论，保留退回轨迹 |

证据：`lib/engine.ts`、`lib/selection.ts`、`projectState`；业务与会议测试。本节可选测评/面试辅助仍为固定规则，不包含音视频、监考或专业心理量表；模型复筛见§5，真实面试邮件/答复见§10。

## 7. 经理决策、Offer 与实际入职

参与者：负责经理、HR。前提：投递活动。成功：把决策、答复、协议与实际到岗分开记录。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| 经理 → 录用结论 | 必须负责本职位、面试阶段、决策依据；录用需至少一场完成面试且收齐评价，并满足已采用的甄选门禁 | 保存 `hire/reject` 与依据；不直接发 Offer 或写入职 |
| HR → 发 Offer | 面试阶段、首次、经理已录用；完成评价收齐且无待进行面试；未来截止时间；甄选门禁再次校验 | 进入 `offer`，登记模拟发放及编号；没有外部 Offer 文档或邮件 |
| HR → 答复登记 | 当前 `sent` 才可答复；未到期不能标过期，到期后不能接受 | 接受需计划日期，进入 `onboarding`；拒绝/过期/撤回关闭；到期不会由后台自动写入 |
| HR → 协议登记 | 已接受 Offer、待入职；豁免需依据 | 保存签署/豁免台账，不代表电子签服务完成，不计已入职 |
| HR → 实际入职/未到岗 | 待入职及已接受；校招需签署/豁免；实际日期不得未来；未到计划日不能标未入职 | 实际确认才写 `joined`/`joinedAt`；未入职需原因并关闭；时间线供统计 |

证据：`lib/engine.ts`，`tests/engine.test.ts` 完整闭环及负例、`scripts/api-smoke.mjs`。没有电子签、薪酬审批、背调或 HRIS 同步。

## 8. 按权限读取、指标与资料清理

参与者：所有内部角色；匿名清理仅 HR。成功：读不到权限外业务数据，指标基于同一可见投递范围，清理覆盖已存副本。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| 浏览器 → 招聘快照 API | 必须有效会话；服务端 `projectState` 按经理岗位、面试任务范围投影；管理员业务集合为空 | 不把完整状态交浏览器后再隐藏；所有角色移除 token 存储集合 |
| 可见状态 → `getMetrics` | 只计算已返回给当前角色的集合；类型/批次/岗位/日期/搜索先过滤 | 按投递 cohort 及阶段事件统计；“录入错误”排除，零分母返回未知，人数按 candidateId 去重 |
| HR → 匿名化 | HR；指定候选人必须存在；revision/CAS 同上 | 清主档、所有投递快照、甄选/答卷、核对邀请、相关文本/导入原始行；保留去标识流程记录 |
| HR → 重置演示数据 | 仅 HR；这是共享数据的破坏性操作 | 用种子替换业务集合并增加 revision；不是备份恢复 |

证据：`lib/engine.ts` 的 `projectState`、`anonymizeCandidate`、`reset`，`lib/metrics.ts`；权限、清理与指标单测。备份副本、托管日志和 Gmail 草稿不在应用匿名化范围内。

## 9. 连接、使用与撤销 Gmail

参与者：允许的 Sites 真实操作者；前提：服务端OAuth配置完成。成功：安全保存可撤销的发件授权，连接本身不发送邮件。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| `/mail-connect` → `/api/gmail` 状态/管理 | 状态不向访客披露发件邮箱；POST先检查真实ID/邮箱、固定来源，再读最多2KiB JSON；Demo Cookie不能授权 | 只向允许操作者返回连接状态/发件地址；不返回凭据 |
| connect → Google授权页 | 固定回调、PKCE S256、仅gmail.send+openid/email；10min state绑Cookie及操作者 | D1仅存state/Cookie哈希和加密verifier；回调路径HttpOnly Cookie |
| Google → callback → token/userinfo | state一次消费、未过期、同Cookie/操作者；拒绝授权、scope缺失、无refresh token、邮箱未验证均拒绝 | 交换token并确认发件邮箱；AES-GCM加密refresh token绑定操作者/发件行；不向浏览器返回token；303回连接页 |
| disconnect → D1/Google revoke | 同操作者与来源；断开期间在途callback不能重新连接 | 先删本地授权/待授权，尽力撤销Google；提供商撤销未确认明确提示；保留既有发送回执；之后新发送拒绝 |

证据：`lib/gmail.ts`、`lib/gmail-request.ts`、`lib/gmail-server.ts`、`lib/operator.ts`，OAuth/加密/并发及负例在 `tests/gmail.test.ts`、`tests/operator.test.ts`。真实OAuth配置与浏览器往返需独立受控验收。

## 10. 面试邀请、邮件回执与候选人答复

参与者：HR、允许的真实发信操作者、持独立token的候选人。成功：有效排期经过明确发送；提供商接受与候选人答复分开，任何答复不自动改变排期或录用。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| 详情/日程 → `POST /api/interview-invitation`预览 | HR+当前revision；活动面试阶段/待进行；新版当前初筛+复筛+HR通过，旧版筛选依据；未来≤8h、有效面试官/地点，无同人或面试官冲突 | 不写库/不发信；展示收件人/主题/正文及Gmail就绪状态；收件人为候选人当前主档邮箱，不是资格快照，不自动群发面试官 |
| 模板 → HR明确发送 | 正文来自实际岗位/轮次/北京时间/地点/会议链接号密码/准备事项；预览只含答复URL占位符 | 明确发送才生成专属token；手动创建的入会资料交给该收件人，不自动向会议平台建会 |
| 发送 → 待发送记录 | HR、live、允许Sites操作者、已连接Gmail、本站公开HTTPS；requestId须有效UUID且未用；同排期/邮箱有有效pending/sent/unknown拒绝重复 | 256位随机token只存SHA-256；expiry=min(7天,面试开始)；CAS保存pending后外发；新邀请撤销旧答复链接 |
| 服务端 → Gmail → 本地回执 | 复用按邀请ID原子claim；同请求/并发revision只发一次；failed/unknown不假报接受 | 邮件含`/interview-response#token=...`；pending/sent/failed/unknown独立保存，sent才设notified；JSON CAS冲突可由快照查mail_jobs修复，无盲重发/重复审计 |
| fragment页面 → `GET /api/interview-response` | 不需内部会话/真实操作者；校验token、期限、排期指纹、主档邮箱及活动面试阶段；撤销/failed/开始/关闭/Offer失效410 | 仅本场轮次时间地点入会资料、候选人姓名/岗位标题及答复状态；API读取仍携token，fragment不替代日志保护 |
| 候选人 → `POST /api/interview-response` | 当前expectedVersion；仅confirmed/reschedule_requested，申请原因5–1000字符；已答复锁定409；跨Origin拒绝 | 保存答复、时间/备注，HR可见；不改面试时间、阶段、测评或经理决定 |
| HR调整/撤销/清理 | 改排期/轮次/地点/会议资料/分配、主档邮箱变化、关闭均撤销旧链接；恢复旧值不复活；不确定发送需核实后明确撤销再发 | 不召回旧邮件；failed可重新预览后手动重试；完整token集合不投影，摘要/收件人/答复仅HR；匿名化清相关记录 |

专项合同与历史验证见 [interview-invitations.md](./interview-invitations.md)。实现是`lib/interview-invitation.ts`与`lib/server.ts`编排，复用`gmail-server.ts`；业务/服务端/生命周期测试使用mock或合成资料。真实收信、外部打开与HR回写须以最终受控验收记录为准。

## 11. 公开职位与匿名新投递

参与者：无需内部账号的候选人。前提：职位开放，提供本次资料并明确同意。成功：独立主档与新投递进入HR待处理，仅公开最小回执，不调用付费模型或发送邮件。

| 步骤/边界 | 权限与拒绝行为 | 数据与副作用 |
| --- | --- | --- |
| `/careers` → `GET /api/careers` | live/AI已启用也无需操作者或Cookie；只读`status=open` | 仅id/title/department/location/type/batch/graduationYears/description/skills/createdAt；不返回owner/manager、筛选私策、state、候选人或投递 |
| 本地文件/粘贴 → `POST /api/careers` | 限JSON对象/6MiB与同Origin规则；顶层仅requestId/jobId/candidate/consent；必须consent=true和有效UUID | 候选人仅name/email/phone/school/major/education/graduationYear/skills/resume/availability；姓名邮箱正文必填，格式/枚举/长度有效，未知教育/届别保留，不接受candidateId、角色、stage或score |
| 匿名资料 → 幂等和开放职位检查 | UUID+规范化资料SHA-256；同请求同内容返回旧回执不写，改内容409；未知/非开放职位拒绝 | 检查同岗邮箱/电话重复含历史关闭投递，通用409；未经验证联系方式不读出/关联/覆盖私有主档；跨岗也另建独立主档和快照 |
| 服务端 → D1 CAS | 不采用客户端内部revision；从最新状态重算，CAS冲突重读并再次校验最多3次 | 只写一次候选人、新投递/created事件及服务端careerSubmissions；并发同内容同回执，竞争重复不新增两份 |
| 新投递 → 初筛与待处理 | 建立当前`runRuleReview`及`queueResumeReview`，missing/unknown作关注项不阻止pending；匿名路径不调用finishResumeReview | `stage=new`、decision=pending，来源自助投递；无llm报告/HR通过；不能走V1绕过，授权HR后续ensure才能调用模型 |
| API → 候选人/内部投影 | 成功仅reference/jobTitle/submittedAt；参考号不提供读取私有资料能力 | 无候选人ID/投递ID/联系方式/简历/state；幂等元数据对所有内部角色投影也删除；无自动邮件或晋级 |

实现：`lib/careers.ts`、`lib/server.ts#careersSnapshot/careersAction`、`app/api/careers/route.ts`。专项范围见 [careers-handoff.md](./careers-handoff.md)，共享版规则与并发证据见`tests/careers.test.ts`及本地careers烟测；原checkout结果不能代替最终共享版验收。
