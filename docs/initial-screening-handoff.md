# 简历初筛工程交接

更新日期：2026-10-20。范围：本轮初筛语义、AI 复筛衔接与开源源码调研；供集成和发布接手使用。

## 用户最新口径与本轮行为

> 初筛无所谓，就是把相关的内容有的先留下，后面有ai复筛和人工审核

初筛采用宽进原则，负责整理岗位相关线索、条件差异和未知项，后续交给 AI 复筛与 HR 核实。不能把“所有要求都命中”作为生成 AI 复筛报告的前提。

- `lib/selection.ts` 的 `initialScreeningReady` 只表示已有 `kind === "rule"` 且含非空 `evidence` 的线索报告；不再检查每项都是 `matched` 或 `info`。它不代表候选人符合岗位、初筛已通过或可以录用。
- `missing`、`unknown` 原样保留在报告中，并允许请求 AI 复筛；即使当前全部为未知，也可以由后续复筛核实，不自动淘汰。
- 岗位政策必须仍为当前版本，且投递快照有非空简历正文；报告不存在、线索列表为空、政策过期或正文为空，仍不能启动 AI 复筛。`initialScreeningReady` 本身不承担政策时效与正文检查，调用方继续负责。
- `lib/resume-workflow.ts` 的 `queueResumeReview`，以及 `review_resume`、`ensure_resume_review` 两条动作路径使用同一语义。满足前提后进入 `pending`；模型调用失败仍为失败状态，不能伪造已完成报告。
- 提示语说明“初筛已完成，缺项与未知交由 AI 和 HR 核实”，不再暗示缺项、未知必须先全部修正才能复筛。

## 保留的人工与流程门禁

HR 确认“通过”仍要求当前有效的真实 AI 复筛报告，以及原有人工结论和判断依据。初筛完成、排队或模型报告生成均不自动推进阶段、不替 HR 作决定。经理角色权限、经理决定、面试及 Offer 等原有门禁不在本轮放宽范围。

政策、投递资料变化或重跑报告仍按现有逻辑使旧复筛、HR 结论和经理决定失效；输入快照核对继续阻止过期模型结果回写。历史终态处理沿用现有规则，不批量重置。

## 源码调研与取舍

以下均为固定 commit 的源码链接。本轮学习设计，没有直接引入这些项目的依赖或复制其评分器；SkillNER 由并行源码调研核查后交接汇总。

| 项目 / 许可证 | 固定版本与关键源码 | 可借鉴 | 不照搬到本项目初筛 |
| --- | --- | --- | --- |
| Resume-Matcher / Apache-2.0 | `ff5b370372d39b6cb6b56fd0dad88a2fe5c3abce`；[`compute_ats_score`](https://github.com/srbhr/Resume-Matcher/blob/ff5b370372d39b6cb6b56fd0dad88a2fe5c3abce/apps/backend/app/services/ats.py)、[`keywordInText`](https://github.com/srbhr/Resume-Matcher/blob/ff5b370372d39b6cb6b56fd0dad88a2fe5c3abce/apps/frontend/lib/utils/keyword-matcher.ts) | 关键词边界处理、逐项展示，以及不可评分维度保留空值。 | ATS 分含关键词、职位字面命中、简历结构和日期格式，不能当候选人胜任度；技能覆盖将必备与优先技能合并计算；自动关键词提取跳过 CJK，不能直接用来筛中文简历。 |
| JevMatch / MIT | `0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce`；[`RequirementExtractor`](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/core/requirements.py)、[`SKILL_LEVELS`](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/core/jev.py)、[`evidence`](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/core/jev.py) | JD 要求原子化、必备与加分分开、技能提及与实际经历分层；先检索原句，再独立核对支持关系，从本地原文映射取回证据。 | must-have 阈值和封顶分不作本项目初筛排除门槛；`passed=None` 应明确留给后续核实；模型概率及分层得分不解释为胜任概率。 |
| SkillNER / MIT | `e8cdbb6f591211bf5d0fe2c8a61ddb95526a78b3`；[`matcher_class.py`](https://github.com/AnasAito/SkillNER/blob/e8cdbb6f591211bf5d0fe2c8a61ddb95526a78b3/skillNer/matcher_class.py) 的 `get_full_matcher`、`get_abv_matcher`、`get_full_match_skills` | 用统一 `skill_id` 归并技能全文与缩写；记录命中词位，使初筛尽量搜全相关内容，并解释命中来源。 | `score=1` 是词项匹配信号，不代表具备能力；清理后文本的 `doc_node_id` 不是原始简历字符偏移，不能直接用于原文引文定位。 |

适合本项目后续改进的方向是“条件拆项 → 关键词、别名和语义搜集线索 → 保留原句及证据强弱 → AI 复筛 → 人工判断”。其中分层用于搜集与解释，不新增初筛淘汰阈值；这条完整证据链属于后续改进方向，不等同于本轮已全部实现。

### 已核查的测试与具体限制

- JevMatch 的 [`test_evidence_uses_semantic_retrieval_then_verifies_verbatim_lines`](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/tests/test_jev.py) 用 JD 的完整名称匹配简历中的 RAG 缩写，并只返回输入中的原句；测试采用模拟模型响应，证明调用和映射流程，不证明真实模型准确率。
- JevMatch 的 [`score_match` 与测试](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/tests/test_scoring.py) 把技能等级除以 4 后加权。例如 `100 × (0.9 × 3 + 3/4 × 2) / 5 = 84`；这是按其规则计算的证据分，不是 84% 胜任概率，也不是本项目初筛准入线。
- Resume-Matcher 的 [ATS 测试](https://github.com/srbhr/Resume-Matcher/blob/ff5b370372d39b6cb6b56fd0dad88a2fe5c3abce/apps/backend/tests/unit/test_ats.py) 验证不可评分维度排除后重新分配权重；[同义职位测试](https://github.com/srbhr/Resume-Matcher/blob/ff5b370372d39b6cb6b56fd0dad88a2fe5c3abce/apps/backend/tests/unit/test_ats.py) 也显示其职位匹配刻意偏字面，不能直接承担宽进相关性判断。
- 用 JevMatch [`experience_months`](https://github.com/Dipeshtripathi13/jevmatch/blob/0a52c3273ccb1be0bbfbc4fefeb0d25912f7e8ce/core/facts.py) 原函数做隔离小样：教育 `2018 - 2022` 加工作 `Jan 2024 - Dec 2024` 会算出 72 个月；中文 `2020年1月 - 2023年12月` 返回 `None`。原因是全篇日期取并集且未区分教育与工作，不能照搬为年限硬筛。

## 集成验证记录

本轮先补充宽进期望，旧代码出现 4 项断言失败；业务调整后完成以下验证。外部源码测试仅已阅读，未安装或运行其完整测试套件。

| 验证项 | 成功标准 | 本轮结果 |
| --- | --- | --- |
| `tests/selection.test.ts` 宽进回归 | `missing`、全部 `unknown` 可走两条 AI 请求路径；保留证据、不自动生成报告、不自动通过 HR 或推进阶段。 | 目标三文件合计 52/52 通过；覆盖两条请求路径、摘要和证据保留。 |
| 政策、正文与空线索回归 | 过期政策、空正文、缺失报告或空线索仍阻止复筛；当前规则与正文满足时可排队。 | 52/52 中通过；CSV 有正文排队、无正文 blocked；未知/条件差异保留。 |
| `tests/engine.test.ts` 与原流程门禁 | 自动初筛及队列衔接采用新语义；HR、经理、面试及 Offer 权限与门禁回归通过。 | 52/52 中通过；仅初筛或排队不能 HR 通过或进入面试，原经理/Offer 门禁回归通过。 |
| 类型、构建与集成 smoke | 记录实际命令与状态；真实模型未运行或发布未完成时明确标为跳过或未验证。 | 本轮最终 npm test 为 202/202 通过，npm run typecheck 通过，git diff --check 通过。构建、HTTP smoke 与发布由统一集成聊天执行；未进行真实模型效果验收。 |

## 交接边界

其他聊天负责 DeepSeek 提供商接入与统一构建发布，本轮不单独发布。已同步 README 与 AI 专项、流程、权限、测试及自动化文档中的初筛门槛；架构文档由统一集成方同步。本轮只在模型指令中补充初筛为宽进、需独立核实弱线索和矛盾，不改变提供商请求协议。最终构建与线上结果以统一集成记录为准。
