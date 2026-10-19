"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ListFilter,
  ClipboardCheck,
  ShieldCheck,
  FileSearch,
  SlidersHorizontal,
  Search,
  Check,
  CircleHelp,
  AlertCircle,
  FilePenLine,
  ChartNoAxesCombined,
  MessagesSquare,
  Plus,
  X,
  Info,
  Sparkles,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  RefreshCw,
} from "lucide-react";
import type {
  AppState,
  Application,
  Assessment,
  AssessmentKind,
  Job,
  ScreeningPolicy,
  SelectionReport,
  User,
} from "@/lib/domain";
import { STAGE_LABELS } from "@/lib/domain";
import { Avatar, Badge, Empty, Field, Modal, Spinner, dateTime } from "./ui";

type Action = (
  name: string,
  fields: Record<string, unknown>,
) => Promise<unknown>;
type Props = {
  state: AppState;
  user: User;
  onAction: Action;
  initialApplicationId?: string;
};
type Review = "pass" | "hold" | "reject";
const educationNames: Record<string, string> = {
  any: "不限",
  unknown: "待核实",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
};
const reviewNames: Record<Review, string> = {
  pass: "通过初筛",
  hold: "待进一步核实",
  reject: "不予推进",
};
const assessmentNames: Record<AssessmentKind, string> = {
  written: "岗位基础笔试",
  preference: "工作偏好问卷",
  ai_interview: "文本模拟面试",
};
const evidenceNames = {
  matched: "符合",
  missing: "不符合",
  unknown: "待核实",
  info: "参考信息",
};
const evidenceTone = {
  matched: "green",
  missing: "red",
  unknown: "amber",
  info: "neutral",
};
const splitList = (value: FormDataEntryValue | null) =>
  String(value || "")
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
function ModelLabel({ report }: { report?: SelectionReport }) {
  return (
    <span className="sel-model-label">
      <Sparkles size={12} />
      {report?.mode === "llm" ? "大模型分析" : "规则模拟 · 未调用大模型"}
    </span>
  );
}
function Card({
  number,
  title,
  subtitle,
  action,
  children,
  footer,
}: {
  number?: number;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="sel-step-card">
      <div className="sel-card-head">
        <div className="sel-card-title">
          {number && <span className="sel-step-number">{number}</span>}
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="sel-card-body">{children}</div>
      {footer && <div className="sel-card-foot">{footer}</div>}
    </section>
  );
}
function reviewLabel(application: Application) {
  if (application.selection?.hrReview)
    return reviewNames[application.selection.hrReview.conclusion];
  if (application.selection?.resumeReview?.mode === "llm") return "待 HR 复核";
  if (application.selection?.aiReview?.status === "failed") return "AI 复筛失败";
  if (["pending", "running"].includes(application.selection?.aiReview?.status || "")) return "AI 复筛中";
  if (application.selection?.ruleReview) return "待简历复筛";
  if (!["new", "screening"].includes(application.stage)) return "沿用既有流程";
  return "未开始初筛";
}
function ReviewBadge({ application }: { application: Application }) {
  const status = application.selection?.hrReview?.conclusion;
  return (
    <Badge
      tone={
        status === "pass"
          ? "green"
          : status === "reject"
            ? "red"
            : status === "hold"
              ? "amber"
              : "neutral"
      }
    >
      {reviewLabel(application)}
    </Badge>
  );
}
function PolicySummary({ job }: { job: Job }) {
  const policy = job.screeningPolicy;
  return (
    <div className="sel-inline-note">
      <ShieldCheck size={15} />
      <span>
        最低学历：{educationNames[policy?.minimumEducation || "any"]}
        ；必需技能：
        {(policy?.requiredSkills || job.skills).join("、") || "未限定"}
        ；毕业年份：
        {(policy?.graduationYears || job.graduationYears).join("、") ||
          "未限定"}
        。未知字段保留“待核实”，不自动淘汰。
      </span>
    </div>
  );
}

export default function SelectionCenter(props: Props) {
  return (
    <SelectionWorkspace
      key={props.user.id + ":" + (props.initialApplicationId || "")}
      {...props}
    />
  );
}
function SelectionWorkspace({
  state,
  user,
  onAction,
  initialApplicationId,
}: Props) {
  const [tab, setTab] = useState<"screening" | "assessment">("screening");
  const [jobId, setJobId] = useState("");
  const [scope, setScope] = useState(initialApplicationId ? "all" : "active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialApplicationId || "");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [answerTaskId, setAnswerTaskId] = useState("");
  const [expandedTaskIds, setExpandedTaskIds] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const attemptedReviews = useRef(new Set<string>());
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const allowed = user.role === "hr" || user.role === "manager";
  const isHR = user.role === "hr";
  const applications = useMemo(
    () =>
      state.applications.filter(
        (a) =>
          (!jobId || a.jobId === jobId) &&
          (scope === "all" ||
            (scope === "active"
              ? a.status === "active"
              : scope === "unreviewed"
                ? a.status === "active" &&
                  ["new", "screening"].includes(a.stage) &&
                  !a.selection?.hrReview
                : a.selection?.hrReview?.conclusion === scope)) &&
          (!query.trim() ||
            [
              a.snapshot.name,
              a.snapshot.school,
              state.jobs.find((j) => j.id === a.jobId)?.title,
            ]
              .join(" ")
              .toLowerCase()
              .includes(query.trim().toLowerCase())),
      ),
    [state.applications, state.jobs, jobId, scope, query],
  );
  const application =
    applications.find((a) => a.id === selectedId) || applications[0];
  const job = state.jobs.find((j) => j.id === application?.jobId);
  const assessments = application?.selection?.assessments || [];
  const answerTask = assessments.find((t) => t.id === answerTaskId);
  const actionable =
    isHR &&
    application?.status === "active" &&
    ["new", "screening", "interview"].includes(application.stage);
  const ruleCurrent =
    !!job && reportIsCurrent(application?.selection?.ruleReview, job);
  const resumeCurrent =
    !!job && application?.selection?.resumeReview?.mode === "llm" && reportIsCurrent(application.selection.resumeReview, job);
  const scopeApplications = state.applications.filter(
    (a) => !jobId || a.jobId === jobId,
  );
  const summary = {
    pending: scopeApplications.filter(
      (a) =>
        a.status === "active" &&
        ["new", "screening"].includes(a.stage) &&
        !a.selection?.hrReview,
    ).length,
    reviewed: scopeApplications.filter((a) => a.selection?.hrReview).length,
    assessmentPending: scopeApplications
      .flatMap((a) => a.selection?.assessments || [])
      .filter((t) => t.status === "assigned").length,
  };
  async function execute(
    name: string,
    fields: Record<string, unknown>,
    message: string,
  ) {
    setBusy(name);
    setNotice(null);
    try {
      await onAction(name, fields);
      setNotice({ message, error: false });
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : "操作失败，请重试。",
        error: true,
      });
      throw error;
    } finally {
      setBusy("");
    }
  }
  const run = (
    name: string,
    fields: Record<string, unknown>,
    message: string,
  ) => {
    void execute(name, fields, message).catch(() => undefined);
  };
  useEffect(() => {
    if (
      !actionable ||
      !application ||
      application.snapshot.restricted ||
      application.source === "个人信息已清理" ||
      application.snapshot.resume === "个人信息已清理" ||
      (application.selection?.resumeReview?.mode === "llm" && !!job && reportIsCurrent(application.selection.resumeReview, job)) ||
      ["failed", "blocked", "running"].includes(application.selection?.aiReview?.status || "") ||
      attemptedReviews.current.has(application.id)
    ) return;
    attemptedReviews.current.add(application.id);
    async function ensureReview() {
      setBusy("ensure_resume_review");
      try {
        await onAction("ensure_resume_review", { applicationId: application.id });
      } catch (error) {
        setNotice({ message: error instanceof Error ? error.message : "自动复筛未完成，请重试。", error: true });
      } finally {
        setBusy("");
      }
    }
    void ensureReview();
  }, [application, actionable, job, onAction]);
  function toggleTask(id: string) {
    setExpandedTaskIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }
  if (!allowed)
    return (
      <div className="permission-state">
        <LockKeyhole size={30} />
        <h2>当前角色无权访问甄选中心</h2>
        <p>请切换招聘 HR 或用人经理，查看对应权限范围内的招聘资料。</p>
      </div>
    );
  return (
    <div className="sel-center">
      <div
        className="sel-tabs"
        role="tablist"
        aria-label="甄选工作区"
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "screening"
                : event.key === "End"
                  ? "assessment"
                  : tab === "screening"
                    ? "assessment"
                    : "screening";
            setTab(next);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>("button")
              [next === "screening" ? 0 : 1]?.focus();
          }
        }}
      >
        <button
          role="tab"
          tabIndex={tab === "screening" ? 0 : -1}
          aria-selected={tab === "screening"}
          aria-controls="selection-screening"
          className={tab === "screening" ? "active" : ""}
          onClick={() => setTab("screening")}
        >
          <ListFilter size={17} />
          分层筛选
        </button>
        <button
          role="tab"
          tabIndex={tab === "assessment" ? 0 : -1}
          aria-selected={tab === "assessment"}
          aria-controls="selection-assessment"
          className={tab === "assessment" ? "active" : ""}
          onClick={() => setTab("assessment")}
        >
          <ClipboardCheck size={17} />
          测评与评估
        </button>
      </div>
      <div className="sel-summary">
        <div>
          <span className="sel-summary-icon">
            <FileSearch size={19} />
          </span>
          <span>
            <strong>{summary.pending}</strong>
            <small>份投递等待 HR 复核</small>
          </span>
        </div>
        <div>
          <span className="sel-summary-icon">
            <ShieldCheck size={19} />
          </span>
          <span>
            <strong>{summary.reviewed}</strong>
            <small>份投递已记录初筛意见</small>
          </span>
        </div>
        <div>
          <span className="sel-summary-icon">
            <ClipboardCheck size={19} />
          </span>
          <span>
            <strong>{summary.assessmentPending}</strong>
            <small>项测评等待作答</small>
          </span>
        </div>
      </div>
      <div className="sel-toolbar">
        <select
          aria-label="选择招聘职位"
          value={jobId}
          onChange={(e) => {
            setJobId(e.target.value);
            setSelectedId("");
          }}
        >
          <option value="">全部可见职位</option>
          {state.jobs.map((j) => (
            <option value={j.id} key={j.id}>
              {j.title} · {j.type === "campus" ? "校招" : "社招"}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选初筛状态"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setSelectedId("");
          }}
        >
          <option value="active">进行中的投递</option>
          <option value="all">全部投递</option>
          <option value="unreviewed">待 HR 复核</option>
          <option value="pass">初筛通过</option>
          <option value="hold">待进一步核实</option>
          <option value="reject">不予推进</option>
        </select>
        <label className="sel-search">
          <Search size={16} />
          <input
            aria-label="搜索候选人姓名或职位"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名、学校或职位"
          />
        </label>
        <span className="sel-spacer" />
        <small>{isHR ? "HR 操作与人工复核" : "用人经理 · 只读查看"}</small>
      </div>
      {notice && (
        <div
          className={"sel-status-banner " + (notice.error ? "error" : "")}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? (
            <AlertCircle size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}
          <span>{notice.message}</span>
          <button aria-label="关闭操作提示" onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      <div
        className="sel-layout"
        id={
          tab === "screening" ? "selection-screening" : "selection-assessment"
        }
        role="tabpanel"
      >
        <aside className="sel-roster" aria-label="待筛选投递列表">
          <div className="sel-roster-head">
            <h2>候选人投递</h2>
            <span>{applications.length} 份</span>
          </div>
          <div className="sel-roster-list">
            {applications.map((a) => (
              <button
                key={a.id}
                className={
                  "sel-person " + (application?.id === a.id ? "active" : "")
                }
                aria-pressed={application?.id === a.id}
                onClick={() => {
                  setSelectedId(a.id);
                  setNotice(null);
                }}
              >
                <Avatar name={a.snapshot.name} />
                <span>
                  <span className="sel-person-title">
                    <strong>{a.snapshot.name}</strong>
                    <ReviewBadge application={a} />
                  </span>
                  <p>{state.jobs.find((j) => j.id === a.jobId)?.title}</p>
                  <span className="sel-person-meta">
                    <span>{a.snapshot.school || "院校待补充"}</span>
                    <span>{STAGE_LABELS[a.stage]}</span>
                  </span>
                </span>
              </button>
            ))}
            {!applications.length && (
              <div className="sel-roster-empty">
                暂无符合条件的投递。
                <br />
                可调整职位与状态筛选。
              </div>
            )}
          </div>
        </aside>
        <div className="sel-main">
          {!application || !job ? (
            <div className="sel-step-card">
              <Empty text="调整筛选条件后，选择一份投递开始甄选。">
                <button
                  className="text-button"
                  onClick={() => {
                    setJobId("");
                    setScope("all");
                    setQuery("");
                  }}
                >
                  查看全部可见投递
                </button>
              </Empty>
            </div>
          ) : (
            <>
              <div className="sel-candidate-head">
                <Avatar name={application.snapshot.name} />
                <div className="sel-candidate-title">
                  <div>
                    <h2>{application.snapshot.name}</h2>
                    <Badge tone={job.type === "campus" ? "violet" : "blue"}>
                      {job.type === "campus" ? "校园招聘" : "社会招聘"}
                    </Badge>
                    <ReviewBadge application={application} />
                  </div>
                  <p>
                    {job.title} ·{" "}
                    {educationNames[
                      application.snapshot.education || "unknown"
                    ] || application.snapshot.education}{" "}
                    ·{" "}
                    {application.snapshot.graduationYear
                      ? `${application.snapshot.graduationYear} 届`
                      : "毕业年份待核实"}
                  </p>
                </div>
                <small>
                  {application.status === "active"
                    ? "进行中投递"
                    : "流程已结束 · 仅保留记录"}
                </small>
              </div>
              {application.status === "active" &&
                !["new", "screening", "interview"].includes(
                  application.stage,
                ) && (
                  <div className="sel-inline-note">
                    <LockKeyhole size={15} />
                    <span>
                      当前投递已进入{STAGE_LABELS[application.stage]}
                      ，甄选与测评记录仅供查阅，不再修改条件、指派或提交答卷。
                    </span>
                  </div>
                )}
              {tab === "screening" ? (
                <>
                  <Card
                    number={1}
                    title="硬条件核对"
                    subtitle="对照岗位规则，逐条呈现字段证据"
                    action={
                      isHR ? (
                        <div className="sel-head-actions">
                          {actionable && (
                            <button
                              className="text-button"
                              onClick={() => setVerifyOpen(true)}
                            >
                              <CheckCircle2 size={14} />
                              核实候选人条件
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() => setRulesOpen(true)}
                          >
                            <SlidersHorizontal size={14} />
                            配置岗位规则
                          </button>
                        </div>
                      ) : (
                        <Badge>经理只读</Badge>
                      )
                    }
                    footer={
                      <>
                        <small>
                          {application.selection?.ruleReview
                            ? `最近核对 ${dateTime(application.selection.ruleReview.createdAt)}`
                            : "尚未执行规则核对"}
                        </small>
                        {actionable && (
                          <button
                            className="button small"
                            disabled={!!busy}
                            onClick={() =>
                              run(
                                "run_screening",
                                { applicationId: application.id },
                                "岗位硬条件已逐项核对，缺失字段保留待核实。",
                              )
                            }
                          >
                            {busy === "run_screening" ? (
                              <Spinner />
                            ) : (
                              <RefreshCw size={14} />
                            )}
                            执行规则核对
                          </button>
                        )}
                      </>
                    }
                  >
                    <PolicySummary job={job} />
                    {job.screeningPolicy?.updatedAt &&
                      application.selection?.ruleReview &&
                      new Date(job.screeningPolicy.updatedAt) >
                        new Date(
                          application.selection.ruleReview.createdAt,
                        ) && (
                        <div
                          className="sel-inline-note"
                          style={{ marginTop: 12 }}
                        >
                          <AlertCircle size={15} />
                          <span>
                            岗位规则已更新，下方为更新前生成的报告，请重新执行规则核对后复核。
                          </span>
                        </div>
                      )}
                    {application.selection?.ruleReview ? (
                      <EvidenceTable
                        report={application.selection.ruleReview}
                      />
                    ) : (
                      <div className="sel-empty-report">
                        <ShieldCheck size={26} />
                        <h4>先核对事实，再判断是否合适</h4>
                        <p>
                          学历、必需技能与毕业届别将使用投递快照核对。没有提供的信息会标记为“待核实”，不会自动关闭投递。
                        </p>
                      </div>
                    )}
                  </Card>
                  <Card
                    number={2}
                    title="AI 简历复筛"
                    subtitle="初筛完成后自动分析岗位匹配证据，缺项与未知信息交 AI 及 HR 核实"
                    action={application.selection?.resumeReview?.mode === "llm" ? <ModelLabel report={application.selection.resumeReview} /> : undefined}
                  >
                    <ResumeReviewContent
                      application={application}
                      pending={busy === "review_resume" || busy === "ensure_resume_review" || busy === "run_screening"}
                      disabled={!!busy}
                      canReview={actionable && !application.snapshot.restricted && application.source !== "个人信息已清理" && application.snapshot.resume !== "个人信息已清理"}
                      ruleCurrent={ruleCurrent}
                      onReview={() => run("review_resume", { applicationId: application.id }, "AI 复筛请求已处理，请查看报告状态。")}
                      onScreen={() => run("run_screening", { applicationId: application.id }, "初筛已完成，自动请求 AI 复筛，缺项与未知信息交 AI 及 HR 核实。")}
                      onVerify={() => setVerifyOpen(true)}
                    />
                  </Card>
                  <Card
                    number={3}
                    title="HR 最终初筛意见"
                    subtitle="人工决定本轮甄选结论，保留备注与审计记录"
                    action={
                      application.selection?.hrReview ? (
                        <ReviewBadge application={application} />
                      ) : undefined
                    }
                  >
                    {application.selection?.hrReview && (
                      <div className="sel-review-existing">
                        <div className="sel-review-note">
                          {application.selection.hrReview.note}
                        </div>
                        <div className="sel-history-meta">
                          <span>
                            {state.users.find(
                              (u) =>
                                u.id ===
                                application.selection?.hrReview?.actorId,
                            )?.name || "招聘 HR"}{" "}
                            ·{" "}
                            {dateTime(application.selection.hrReview.createdAt)}
                          </span>
                          <span>
                            {
                              reviewNames[
                                application.selection.hrReview.conclusion
                              ]
                            }
                          </span>
                        </div>
                      </div>
                    )}
                    {actionable ? (
                      <HRReviewForm
                        key={
                          application.id +
                          ":" +
                          (application.selection?.hrReview?.createdAt || "new")
                        }
                        application={application}
                        disabled={!!busy}
                        canPass={ruleCurrent && resumeCurrent}
                        onSubmit={async (conclusion, note) =>
                          execute(
                            "confirm_screening",
                            { applicationId: application.id, conclusion, note },
                            conclusion === "reject"
                              ? "已记录不予推进的原因，并结束本次投递。"
                              : "HR 初筛意见已保存；后续流程仍由 HR 手动推进。",
                          )
                        }
                      />
                    ) : !application.selection?.hrReview ? (
                      <p className="sel-review-note">尚未记录 HR 初筛意见。</p>
                    ) : null}
                    <div className="sel-inline-note" style={{ marginTop: 16 }}>
                      <Info size={14} />
                      <span>
                        通过或待核实只保存本轮结论，不自动推进面试；不予推进将结束本次投递。岗位规则或资料变更后，请重新运行核对并复核。
                      </span>
                    </div>
                  </Card>
                </>
              ) : (
                <>
                  <Card
                    title="按岗位选择评估方式"
                    subtitle="每项任务独立保存，报告提供证据，不替代人工决策"
                    action={<Badge tone="blue">合成答卷沙盒</Badge>}
                  >
                    <div className="sel-task-types">
                      {(["written", "preference", "ai_interview"] as const).map(
                        (kind) => (
                          <button
                            key={kind}
                            className="sel-task-type"
                            disabled={!actionable || !!busy}
                            onClick={() =>
                              run(
                                "assign_assessment",
                                { applicationId: application.id, kind },
                                `${assessmentNames[kind]}已指派，可进入合成答卷沙盒作答。`,
                              )
                            }
                          >
                            {kind === "written" ? (
                              <FilePenLine size={20} />
                            ) : kind === "preference" ? (
                              <ChartNoAxesCombined size={20} />
                            ) : (
                              <MessagesSquare size={20} />
                            )}
                            <strong>{assessmentNames[kind]}</strong>
                            <p>
                              {kind === "written"
                                ? "单选题与标准答案对照，记录客观题得分。"
                                : kind === "preference"
                                  ? "理解工作偏好，不设录用阈值，不作心理诊断。"
                                  : "文本回答按公开规则演示评分，未使用真实 AI 模型。"}
                            </p>
                            <span className="sel-type-foot">
                              {isHR ? "指派任务" : "HR 指派后可查看"}
                              <Plus size={14} />
                            </span>
                          </button>
                        ),
                      )}
                    </div>
                    {!actionable && (
                      <div
                        className="sel-inline-note"
                        style={{ marginTop: 15 }}
                      >
                        <LockKeyhole size={14} />
                        <span>
                          {isHR
                            ? "当前流程阶段不再指派新任务，保留历史报告供查阅。"
                            : "用人经理可查看测评内容和报告，任务指派与合成答卷由 HR 操作。"}
                        </span>
                      </div>
                    )}
                  </Card>
                  <Card
                    title="测评任务与报告"
                    subtitle={`${assessments.length} 项任务 · ${assessments.filter((t) => t.status === "submitted").length} 项已提交`}
                  >
                    {!assessments.length ? (
                      <div className="sel-empty-report">
                        <ClipboardCheck size={29} />
                        <h4>尚未指派测评任务</h4>
                        <p>
                          从上方选择与岗位相关的评估方式。Demo 由 HR
                          代填合成答卷，不发送外部测评邀请。
                        </p>
                      </div>
                    ) : (
                      <div className="sel-task-list">
                        {assessments.map((task) => (
                          <div className="sel-task-row" key={task.id}>
                            <div className="sel-task-row-head">
                              <div>
                                <span className="sel-task-row-icon">
                                  {task.kind === "written" ? (
                                    <FilePenLine size={18} />
                                  ) : task.kind === "preference" ? (
                                    <ChartNoAxesCombined size={18} />
                                  ) : (
                                    <MessagesSquare size={18} />
                                  )}
                                </span>
                                <span>
                                  <h4>{task.title}</h4>
                                  <small>
                                    指派于 {dateTime(task.assignedAt)} ·{" "}
                                    {task.questions.length} 道题
                                  </small>
                                </span>
                              </div>
                              <div className="sel-task-row-actions">
                                <Badge
                                  tone={
                                    task.status === "submitted"
                                      ? "green"
                                      : "amber"
                                  }
                                >
                                  {task.status === "submitted"
                                    ? "已提交"
                                    : "待作答"}
                                </Badge>
                                {isHR &&
                                task.status === "assigned" &&
                                actionable ? (
                                  <button
                                    className="button small primary"
                                    disabled={!!busy}
                                    onClick={() => setAnswerTaskId(task.id)}
                                  >
                                    合成答卷沙盒
                                  </button>
                                ) : (
                                  <button
                                    className="text-button"
                                    aria-expanded={expandedTaskIds.includes(
                                      task.id,
                                    )}
                                    onClick={() => toggleTask(task.id)}
                                  >
                                    {expandedTaskIds.includes(task.id)
                                      ? "收起内容"
                                      : task.status === "submitted"
                                        ? "查看报告"
                                        : "查看题目"}
                                  </button>
                                )}
                              </div>
                            </div>
                            {expandedTaskIds.includes(task.id) && (
                              <div className="sel-task-result">
                                {task.report ? (
                                  <>
                                    <ModelLabel />
                                    <ReportContent report={task.report} />
                                  </>
                                ) : (
                                  <div className="sel-inline-note">
                                    <Clock3 size={15} />
                                    <span>
                                      答卷尚未提交，当前没有评分报告。
                                    </span>
                                  </div>
                                )}
                                <AnswerDetails task={task} />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                  <Card
                    title="面试辅助评分报告"
                    subtitle="仅基于已提交的结构化评价生成，维持面试官独立评价原则"
                  >
                    <InterviewAssists state={state} application={application} />
                    <div className="sel-inline-note" style={{ marginTop: 15 }}>
                      <CircleHelp size={15} />
                      <span>
                        辅助评分由面试官在本人评价正式提交后生成。这里仅展示当前角色可见的报告，不生成或改写人工分数。
                      </span>
                    </div>
                  </Card>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {verifyOpen && application && actionable && (
        <VerifyModal
          application={application}
          onClose={() => setVerifyOpen(false)}
          onSave={async (fields) =>
            execute(
              "verify_screening_info",
              fields,
              "当前投递资料已核实，旧筛选报告和结论已清空，请重新核对并复筛。",
            )
          }
        />
      )}
      {rulesOpen && job && isHR && (
        <RulesModal
          job={job}
          onClose={() => setRulesOpen(false)}
          onSave={async (fields) =>
            execute(
              "configure_screening",
              fields,
              "岗位筛选规则已保存；已有报告仍保留生成时的规则快照。",
            )
          }
        />
      )}
      {answerTask && application && isHR && (
        <AnswerModal
          task={answerTask}
          candidateName={application.snapshot.name}
          onClose={() => setAnswerTaskId("")}
          onSubmit={async (answers) => {
            await execute(
              "submit_assessment",
              {
                applicationId: application.id,
                assessmentId: answerTask.id,
                answers,
              },
              "合成答卷已提交，评估报告已生成并锁定。",
            );
            setExpandedTaskIds((ids) => [...new Set([...ids, answerTask.id])]);
          }}
        />
      )}
    </div>
  );
}

export function ResumeReviewContent({
  application,
  pending = false,
  disabled = false,
  canReview,
  ruleCurrent = true,
  onReview,
  onScreen,
  onVerify,
}: {
  application: Application;
  pending?: boolean;
  disabled?: boolean;
  canReview: boolean;
  ruleCurrent?: boolean;
  onReview: () => void;
  onScreen: () => void;
  onVerify: () => void;
}) {
  const selection = application.selection;
  const report = selection?.resumeReview;
  const realReport = report?.mode === "llm" && ruleCurrent ? report : undefined;
  const rule = selection?.ruleReview;
  const screeningComplete = !!rule && rule.kind === "rule" && rule.evidence.length > 0;
  const generating = pending || ["pending", "running"].includes(selection?.aiReview?.status || "");
  const failed = selection?.aiReview?.status === "failed";
  const hasResume = !!application.snapshot.resume.trim() && application.snapshot.resume !== "个人信息已清理";
  const label = generating ? "正在生成" : realReport ? "已完成" : failed ? "生成失败" : "待复筛";
  const title = failed
    ? "AI 复筛暂未完成"
    : !screeningComplete || !ruleCurrent
      ? "先完成岗位初筛"
      : !hasResume
        ? "等待上传简历"
        : "初筛已完成，等待 AI 复筛";
  const hint = selection?.aiReview?.message || (
    !screeningComplete || !ruleCurrent
      ? "完成岗位初筛后自动分析简历中的匹配证据，缺项与未知信息交 AI 及 HR 核实。"
      : !hasResume
        ? "上传或填写简历文本后，即可生成岗位匹配分析。"
        : "将根据当前岗位要求和这次投递的简历生成分析，缺项与未知信息交 AI 及 HR 核实。"
  );
  return (
    <div className="resume-review" aria-busy={generating}>
      <div className="resume-review-status">
        <span className={`resume-review-indicator ${generating ? "pending" : realReport ? "complete" : failed ? "failed" : ""}`}>
          {generating ? <Spinner /> : realReport ? <CheckCircle2 size={17} /> : failed ? <AlertCircle size={17} /> : <FileSearch size={17} />}
          <strong>{label}</strong>
        </span>
        {realReport && !generating && <small>基于当前投递简历</small>}
      </div>
      {generating ? (
        <div className="resume-review-empty" role="status">
          <h4>正在分析岗位匹配证据</h4>
          <p>完成后会在这里展示报告，通常需要几十秒。</p>
        </div>
      ) : realReport ? (
        <ResumeReport report={realReport} />
      ) : (
        <div className="resume-review-empty">
          <h4>{title}</h4>
          <p>{hint}</p>
          {canReview && (
            <button
              className="button small primary"
              disabled={disabled}
              onClick={!screeningComplete || !ruleCurrent ? onScreen : !hasResume ? onVerify : onReview}
            >
              {!screeningComplete || !ruleCurrent ? "执行岗位初筛" : !hasResume ? "核实投递资料" : failed || selection?.aiReview?.status === "blocked" ? "重试生成" : report ? "使用真实 AI 复筛" : "生成 AI 复筛"}
            </button>
          )}
        </div>
      )}
      {report?.mode === "rule_demo" && !generating && (
        <details className="resume-review-details resume-review-history">
          <summary>历史演示报告</summary>
          <p>{report.summary}</p>
          <small>由固定规则生成，未调用大模型 · {dateTime(report.createdAt)}</small>
        </details>
      )}
      {report?.mode === "llm" && !ruleCurrent && !generating && (
        <details className="resume-review-details resume-review-history">
          <summary>历史 AI 报告 · 岗位条件已更新</summary>
          <ResumeReport report={report} />
        </details>
      )}
    </div>
  );
}

function ResumeReport({ report }: { report: SelectionReport }) {
  const supported = report.evidence.filter((item) => item.status === "matched").length;
  const needsVerification = report.evidence.filter((item) => item.status === "missing" || item.status === "unknown").length;
  const informational = report.evidence.filter((item) => item.status === "info").length;
  const questions = report.questions || [];
  const labels = { matched: "有依据", missing: "证据缺口", unknown: "待核实", info: "参考" };
  return (
    <div className="resume-review-report">
      <p className="resume-review-summary">{report.summary}</p>
      <div className="resume-review-counts">
        <span><strong>{supported}</strong> 项有依据</span>
        <span><strong>{needsVerification}</strong> 项待核实</span>
        {informational > 0 && <span><strong>{informational}</strong> 项参考</span>}
      </div>
      <ul className="resume-review-evidence">
        {report.evidence.map((item, index) => (
          <li key={index}>
            <div><h4>{item.label}</h4><Badge tone={evidenceTone[item.status]}>{labels[item.status]}</Badge></div>
            {item.reason && <p>{item.reason}</p>}
            {item.quote.trim() && item.quote.trim() !== "简历未提供相关依据" ? <blockquote><span>简历原文</span>{item.quote}</blockquote> : <small>简历中未找到直接证据</small>}
          </li>
        ))}
      </ul>
      {(report.gaps.length > 0 || questions.length > 0) && (
        <details className="resume-review-details">
          <summary>缺口与建议核实问题 <span>{report.gaps.length + questions.length} 项</span></summary>
          {report.gaps.length > 0 && <><h5>需要补充的证据</h5><ul>{report.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></>}
          {questions.length > 0 && <><h5>建议核实问题</h5><ol>{questions.map((question, index) => <li key={index}>{question}</li>)}</ol></>}
        </details>
      )}
      <div className="resume-review-meta">
        <span>{report.model || "大模型分析"} · {dateTime(report.createdAt)}</span>
        <span>AI 辅助分析，最终结论由 HR 确认。</span>
      </div>
    </div>
  );
}

export function reportIsCurrent(report: SelectionReport | undefined, job: Job) {
  if (!report?.policy) return false;
  const policy = job.screeningPolicy || {
    minimumEducation: "any",
    requiredSkills: job.skills,
    graduationYears: job.type === "campus" ? job.graduationYears : [],
    updatedAt: job.createdAt,
  };
  return (
    report.policy.minimumEducation === policy.minimumEducation &&
    report.policy.updatedAt === policy.updatedAt &&
    JSON.stringify(report.policy.requiredSkills) ===
      JSON.stringify(policy.requiredSkills) &&
    JSON.stringify(report.policy.graduationYears) ===
      JSON.stringify(policy.graduationYears)
  );
}

function EvidenceTable({ report }: { report: SelectionReport }) {
  if (report.mode === "llm") return <ResumeReport report={report} />;
  return (
    <div className="table-scroll">
      <small className="sel-history-meta">
        规则版本：{report.ruleVersion || "历史记录未标注"}
        {report.policy
          ? ` · 岗位标准保存于 ${dateTime(report.policy.updatedAt)}`
          : ""}
      </small>
      <table className="sel-rule-table">
        <thead>
          <tr>
            <th>核对项目</th>
            <th>证据与依据</th>
            <th>核对结果</th>
          </tr>
        </thead>
        <tbody>
          {report.evidence.map((e, index) => (
            <tr key={index}>
              <td>{e.label}</td>
              <td>
                {e.quote || "未提供可核实信息"}
                {e.reason && <small>{e.reason}</small>}
                {e.points !== undefined && (
                  <small>
                    规则计分 {e.points} / {e.maxPoints ?? "—"}
                  </small>
                )}
              </td>
              <td>
                <Badge tone={evidenceTone[e.status]}>
                  {report.kind === "rule" && e.status === "matched" ? "命中线索" : evidenceNames[e.status]}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.gaps.length > 0 && (
        <div className="sel-inline-note" style={{ marginTop: 12 }}>
          <AlertCircle size={15} />
          <span>{report.gaps.join("；")}</span>
        </div>
      )}
    </div>
  );
}
function ReportContent({ report }: { report: SelectionReport }) {
  if (report.mode === "llm") return <ResumeReport report={report} />;
  const matched = report.evidence.filter(
    (e) => e.status === "matched" || e.status === "info",
  );
  const needs = report.evidence.filter(
    (e) => e.status === "missing" || e.status === "unknown",
  );
  return (
    <div>
      <div className="sel-report-top">
        {report.score !== null && (
          <div className="sel-score">
            <strong>{report.score}</strong>
            <span>/ {report.maxScore ?? 100}</span>
          </div>
        )}
        <div className="sel-report-heading">
          <h4>{report.title}</h4>
          <p>{report.summary}</p>
        </div>
      </div>
      {report.kind === "preference" ? (
        <EvidenceTable report={report} />
      ) : (
        <div className="sel-evidence-columns">
          <div>
            <h4>
              <CheckCircle2 size={15} />
              已发现的证据
            </h4>
            <ul>
              {matched.map((e, i) => (
                <li key={i}>
                  <span>
                    <strong>{e.label}</strong>：{e.quote}
                    {e.points !== undefined
                      ? `（${e.points}/${e.maxPoints ?? "—"} 分）`
                      : ""}
                  </span>
                </li>
              ))}
              {!matched.length && <li>尚未发现满足当前规则的充分证据。</li>}
            </ul>
          </div>
          <div>
            <h4>
              <CircleHelp size={15} />
              缺口与待核实项
            </h4>
            <ul>
              {needs.map((e, i) => (
                <li key={i}>
                  <span>
                    <strong>{e.label}</strong>：{e.quote}
                  </span>
                </li>
              ))}
              {report.gaps.map((gap, i) => (
                <li key={"gap" + i}>{gap}</li>
              ))}
              {!needs.length && !report.gaps.length && (
                <li>当前规则未发现额外缺口；仍需结合面试和人工复核。</li>
              )}
            </ul>
          </div>
        </div>
      )}
      <div className="sel-inline-note" style={{ marginTop: 16 }}>
        <Info size={14} />
        <span>
          {report.disclaimer ||
            "规则模拟结果，仅供人工核实，不作为自动录用或淘汰依据。"}
          <br />
          规则版本：{report.ruleVersion || "历史记录未标注"}
        </span>
      </div>
    </div>
  );
}
function HRReviewForm({
  application,
  disabled,
  canPass,
  onSubmit,
}: {
  application: Application;
  disabled: boolean;
  canPass: boolean;
  onSubmit: (conclusion: Review, note: string) => Promise<unknown>;
}) {
  const [conclusion, setConclusion] = useState<Review>(
    application.selection?.hrReview?.conclusion === "pass" && !canPass
      ? "hold"
      : application.selection?.hrReview?.conclusion || "hold",
  );
  const [note, setNote] = useState(application.selection?.hrReview?.note || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conclusion === "pass" && !canPass) {
      setError("请先完成当前岗位规则核对与简历复筛，再保存通过结论。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(conclusion, note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="sel-review-form"
      onSubmit={send}
      style={{ marginTop: application.selection?.hrReview ? 18 : 0 }}
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sel-review-legend">人工初筛结论</legend>
        <div className="sel-review-options">
          {(["pass", "hold", "reject"] as const).map((value) => (
            <label className="sel-review-choice" key={value}>
              <input
                type="radio"
                name="conclusion"
                value={value}
                disabled={value === "pass" && !canPass}
                checked={value === conclusion}
                onChange={() => setConclusion(value)}
              />
              {reviewNames[value]}
            </label>
          ))}
        </div>
      </fieldset>
      {!canPass && (
        <small className="sel-review-requirement">
          通过前请先完成当前规则核对与简历复筛；仍可记录待核实或不予推进。
        </small>
      )}
      <label htmlFor="sel-hr-note">复核备注与具体依据 *</label>
      <textarea
        id="sel-hr-note"
        required
        minLength={5}
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="结合岗位要求与事实证据记录判断；不符与缺失信息请分别说明。"
        aria-describedby={error ? "sel-hr-error" : undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <div id="sel-hr-error" className="sel-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="sel-review-actions">
        <button className="button primary" disabled={saving || disabled}>
          {saving ? <Spinner /> : <Check size={15} />}保存人工结论
        </button>
      </div>
    </form>
  );
}

function VerifyModal({
  application,
  onClose,
  onSave,
}: {
  application: Application;
  onClose: () => void;
  onSave: (fields: Record<string, unknown>) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSave({
        applicationId: application.id,
        education: String(data.get("education") || "unknown"),
        graduationYear: data.get("graduationYear")
          ? Number(data.get("graduationYear"))
          : null,
        skills: splitList(data.get("skills")),
        note: String(data.get("note") || "").trim(),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "核实资料未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="核实候选人条件"
      subtitle={
        application.snapshot.name +
        " · 仅更正本次投递资料，主档及其他投递不变。"
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body sel-rules-form">
          <Field label="已核实学历">
            <select
              name="education"
              defaultValue={application.snapshot.education || "unknown"}
            >
              {["unknown", "college", "bachelor", "master", "doctor"].map(
                (level) => (
                  <option key={level} value={level}>
                    {educationNames[level]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field
            label="毕业年份"
            help="未知可留空；请依据候选人提供的明确证据核实。"
          >
            <input
              type="number"
              name="graduationYear"
              min="1960"
              max="2100"
              defaultValue={application.snapshot.graduationYear || ""}
            />
          </Field>
          <Field
            label="已核实技能"
            help="多项以逗号分隔，避免将推测当成已确认技能。"
          >
            <textarea
              name="skills"
              rows={3}
              maxLength={1000}
              defaultValue={application.snapshot.skills.join("，")}
            />
          </Field>
          <Field label="核实依据与更正说明" required>
            <textarea
              name="note"
              rows={3}
              required
              minLength={5}
              maxLength={2000}
              placeholder="例如：经候选人补充的合成学历证明核实为本科。"
            />
          </Field>
          <div className="sel-inline-note">
            <Info size={14} />
            <span>
              保存后将清空旧硬条件、简历复筛与 HR
              初筛结论，需重新核对。已提交的测评答卷和操作历史仍会保留。
            </span>
          </div>
          {error && (
            <div className="sel-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <CheckCircle2 size={15} />}保存核实资料
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RulesModal({
  job,
  onClose,
  onSave,
}: {
  job: Job;
  onClose: () => void;
  onSave: (fields: Record<string, unknown>) => Promise<unknown>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const policy: ScreeningPolicy = job.screeningPolicy || {
    minimumEducation: "any",
    requiredSkills: job.skills,
    graduationYears: job.graduationYears,
    updatedAt: "",
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const years = splitList(data.get("graduationYears"));
    if (
      years.some(
        (y) => !/^\d{4}$/.test(y) || Number(y) < 1970 || Number(y) > 2100,
      )
    ) {
      setError("毕业年份须为 1970–2100 之间的四位年份，多个年份以逗号分隔。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        jobId: job.id,
        minimumEducation: String(data.get("minimumEducation")),
        requiredSkills: splitList(data.get("requiredSkills")),
        graduationYears: years.map(Number),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "规则保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="配置岗位筛选规则"
      subtitle={job.title + " · 仅对新生成的核对报告生效，保留历史证据。"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body sel-rules-form">
          <Field label="最低学历">
            <select
              name="minimumEducation"
              defaultValue={policy.minimumEducation}
            >
              {["any", "college", "bachelor", "master", "doctor"].map((k) => (
                <option key={k} value={k}>
                  {educationNames[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="必需技能"
            help="多项以逗号分隔；只用于技能字段与简历证据核对，不自动淘汰。"
          >
            <textarea
              name="requiredSkills"
              rows={3}
              defaultValue={policy.requiredSkills.join("，")}
              maxLength={1000}
            />
          </Field>
          <Field
            label="可接受毕业年份"
            help="可留空表示不限；例如 2026，2027。未知信息交由 HR 核实。"
          >
            <input
              name="graduationYears"
              defaultValue={policy.graduationYears.join("，")}
            />
          </Field>
          <div className="sel-inline-note">
            <Info size={14} />
            <span>
              规则应与岗位直接相关，学历和技能缺失保持待核实。Demo
              不使用年龄、性别等无关信息筛选。
            </span>
          </div>
          {error && (
            <div className="sel-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Check size={15} />}保存岗位规则
          </button>
        </div>
      </form>
    </Modal>
  );
}
function AnswerDetails({ task }: { task: Assessment }) {
  return (
    <div className="sel-answer-list">
      {task.questions.map((question, index) => {
        const answer = task.answers[question.id];
        const label =
          question.options?.find((o) => o.value === answer)?.label || answer;
        return (
          <div className="sel-answer-item" key={question.id}>
            <h5>
              {index + 1}. {question.prompt}
            </h5>
            <p>{label || "尚未作答"}</p>
          </div>
        );
      })}
    </div>
  );
}
function AnswerModal({
  task,
  candidateName,
  onClose,
  onSubmit,
}: {
  task: Assessment;
  candidateName: string;
  onClose: () => void;
  onSubmit: (answers: Record<string, string>) => Promise<unknown>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(task.answers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function fillDemo() {
    const examples: Record<string, string> = {
      priority: "b",
      evidence: "c",
      plan: "合成答卷：先记录处理时长与转化率作为基线，再约定成功指标。通过小范围对照实验验证效果，结束后复盘异常与后续行动。",
      case: "合成项目的背景是审批等待过长，目标是缩短处理时长。我负责用户访谈，行动包括梳理流程和制作原型。结果是职责更清楚；复盘发现异常场景还需要补充验证。",
      collaboration:
        "合成情境中，团队对交付优先级存在分歧。我通过沟通整理用户证据，围绕共同目标形成共识；后续每周回看数据并调整排期。",
    };
    setAnswers(
      Object.fromEntries(
        task.questions.map((q) => [
          q.id,
          examples[q.id] ||
            (q.type === "likert" ? "3" : q.options?.[0]?.value || ""),
        ]),
      ),
    );
    setError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(answers);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "答卷未提交，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={task.title + " · 合成答卷沙盒"}
      subtitle={`${candidateName} · 由 HR 代填演示，不发送外部邀请，不代表真实候选人作答。`}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="sel-inline-note blue sel-dialog-note">
            <Info size={15} />
            <span>
              {task.kind === "preference"
                ? "工作偏好仅作沟通参考，不设录用分数线，不作心理诊断。"
                : task.kind === "ai_interview"
                  ? "文本回答按公开的演示规则评价结构与信息覆盖；未调用大模型，也未处理音视频。"
                  : "按题目标准答案自动判分，提交后显示题目、答卷与评分依据。"}
              提交后答卷锁定，不能重复覆盖。
            </span>
          </div>
          <div className="sel-review-actions" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={fillDemo}
            >
              <FilePenLine size={14} />
              填入合成示例答案
            </button>
          </div>
          <div className="sel-questions">
            {task.questions.map((question, index) => (
              <div className="sel-question" key={question.id}>
                {question.type === "text" ? (
                  <>
                    <label htmlFor={"answer-" + question.id}>
                      {index + 1}. {question.prompt}
                      {question.required ? " *" : ""}
                    </label>
                    <textarea
                      id={"answer-" + question.id}
                      required={question.required}
                      minLength={question.minLength}
                      maxLength={question.maxLength}
                      value={answers[question.id] || ""}
                      onChange={(e) =>
                        setAnswers((a) => ({
                          ...a,
                          [question.id]: e.target.value,
                        }))
                      }
                    />
                    <small>
                      {question.minLength
                        ? `至少 ${question.minLength} 字；`
                        : ""}
                      已填写 {(answers[question.id] || "").length} 字
                      {question.maxLength
                        ? `，上限 ${question.maxLength} 字`
                        : ""}
                    </small>
                  </>
                ) : (
                  <fieldset>
                    <legend>
                      {index + 1}. {question.prompt}
                      {question.required ? " *" : ""}
                    </legend>
                    {(
                      question.options ||
                      [1, 2, 3, 4, 5].map((v) => ({
                        value: String(v),
                        label: String(v),
                      }))
                    ).map((option) => (
                      <label className="sel-answer-option" key={option.value}>
                        <input
                          type="radio"
                          name={question.id}
                          required={question.required}
                          value={option.value}
                          checked={answers[question.id] === option.value}
                          onChange={(e) =>
                            setAnswers((a) => ({
                              ...a,
                              [question.id]: e.target.value,
                            }))
                          }
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            ))}
          </div>
          {error && (
            <div className="sel-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <CheckCircle2 size={15} />}
            提交合成答卷并生成报告
          </button>
        </div>
      </form>
    </Modal>
  );
}
function InterviewAssists({
  state,
  application,
}: {
  state: AppState;
  application: Application;
}) {
  const interviewIds = new Set(
    state.interviews
      .filter((i) => i.applicationId === application.id)
      .map((i) => i.id),
  );
  const cards = state.scorecards.filter(
    (c) =>
      interviewIds.has(c.interviewId) &&
      c.status === "submitted" &&
      c.assistReport,
  );
  if (!cards.length)
    return (
      <div className="sel-empty-report">
        <MessagesSquare size={27} />
        <h4>暂无可见的面试辅助报告</h4>
        <p>
          面试官先独立提交评价，再在本人评价处生成辅助报告。缺少报告时不会补造分数。
        </p>
      </div>
    );
  return (
    <div className="sel-task-list">
      {cards.map((card) => (
        <div className="sel-task-row" key={card.id}>
          <div className="sel-task-row-head">
            <div>
              <span className="sel-task-row-icon">
                <MessagesSquare size={18} />
              </span>
              <span>
                <h4>
                  {state.users.find((u) => u.id === card.userId)?.name ||
                    "面试官"}{" "}
                  ·{" "}
                  {
                    state.interviews.find((i) => i.id === card.interviewId)
                      ?.round
                  }
                </h4>
                <small>原始评价已提交 · {dateTime(card.submittedAt)}</small>
              </span>
            </div>
            <ModelLabel />
          </div>
          <div className="sel-task-result">
            <ReportContent report={card.assistReport!} />
          </div>
        </div>
      ))}
    </div>
  );
}
