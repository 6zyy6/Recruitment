"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  Download,
  Upload,
  Check,
  ArrowRight,
  FileSpreadsheet,
} from "lucide-react";
import type { AppState, User, ImportJob } from "@/lib/domain";
import { ROLE_LABELS } from "@/lib/domain";
import CandidateIntake from "./CandidateIntake";
import {
  type Action,
  type ModalState,
  Modal,
  Field,
  ErrorMessage,
  Spinner,
  inputDate,
  toISO,
  download,
} from "./ui";

function Form({
  children,
  onSubmit,
  onClose,
  submit = "保存",
  danger = false,
}: {
  children: ReactNode;
  onSubmit: (data: FormData) => Promise<unknown>;
  onClose: () => void;
  submit?: string;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSubmit(data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send}>
      <div className="modal-body">
        <div className="form-grid">{children}</div>
        <ErrorMessage message={error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button" onClick={onClose}>
          取消
        </button>
        <button
          className={"button " + (danger ? "danger" : "primary")}
          disabled={busy}
        >
          {busy ? (
            <>
              <Spinner />
              处理中
            </>
          ) : (
            submit
          )}
        </button>
      </div>
    </form>
  );
}
const text = (data: FormData, key: string) =>
  String(data.get(key) || "").trim();
const csvList = (data: FormData, key: string) =>
  text(data, key)
    .split(/[,，;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
export default function Modals({
  modal,
  state,
  user,
  onAction,
  onClose,
}: {
  modal: ModalState;
  state: AppState;
  user: User;
  onAction: Action;
  onClose: () => void;
}) {
  const application = state.applications.find(
    (a) => a.id === modal.applicationId,
  );
  const candidate = state.candidates.find(
    (c) => c.id === (modal.candidateId || application?.candidateId),
  );
  const job = state.jobs.find(
    (j) => j.id === (modal.jobId || application?.jobId),
  );
  const interview = state.interviews.find((i) => i.id === modal.interviewId);
  const interviewApp = state.applications.find(
    (a) => a.id === interview?.applicationId,
  );
  const interviewJob = state.jobs.find((j) => j.id === interviewApp?.jobId);
  const interviewers = state.users.filter(
    (u) => u.role === "interviewer" || u.role === "manager",
  );
  if (modal.kind === "associate")
    return (
      <Modal
        title="投递其他职位"
        subtitle="关联已有候选人资料，创建一条独立的职位投递；同一职位不会重复创建。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="确认关联职位"
          onSubmit={(d) =>
            onAction("createApplication", {
              candidateId: candidate?.id,
              jobId: text(d, "jobId"),
              source: text(d, "source"),
            })
          }
        >
          <Field label="目标职位" required span>
            <select name="jobId" required defaultValue="">
              <option value="" disabled>
                选择正在招聘的职位
              </option>
              {state.jobs
                .filter(
                  (j) => j.status === "open" && j.id !== application?.jobId,
                )
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title} · {j.type === "campus" ? "校招" : "社招"}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="投递来源" span>
            <select name="source">
              <option>人才库</option>
              <option>主动寻访</option>
              <option>内部推荐</option>
              <option>其他</option>
            </select>
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "import")
    return (
      <ImportModal
        state={state}
        onAction={onAction}
        onClose={onClose}
        defaultJobId={modal.jobId}
      />
    );
  if (modal.kind === "job")
    return (
      <Modal
        title="创建招聘职位"
        subtitle="先定义用人需求，提交审批后即可接收投递。"
        onClose={onClose}
        wide
      >
        <Form
          onClose={onClose}
          submit="创建职位"
          onSubmit={(d) =>
            onAction("createJob", {
              title: text(d, "title"),
              department: text(d, "department"),
              location: text(d, "location"),
              type: text(d, "type"),
              batch: text(d, "batch"),
              graduationYears: csvList(d, "graduationYears").map(Number),
              headcount: Number(d.get("headcount")),
              managerId: text(d, "managerId"),
              ownerId: user.id,
              description: text(d, "description"),
              skills: csvList(d, "skills"),
              dimensions: csvList(d, "dimensions"),
            })
          }
        >
          <Field label="职位名称" required>
            <input
              name="title"
              required
              maxLength={80}
              placeholder="如：高级产品经理"
            />
          </Field>
          <Field label="所属部门" required>
            <input name="department" required placeholder="如：产品研发中心" />
          </Field>
          <Field label="招聘类型" required>
            <select name="type">
              <option value="social">社会招聘</option>
              <option value="campus">校园招聘</option>
            </select>
          </Field>
          <Field label="招聘人数" required>
            <input
              name="headcount"
              type="number"
              min="1"
              max="999"
              required
              defaultValue="1"
            />
          </Field>
          <Field label="工作地点" required>
            <input name="location" required placeholder="如：上海" />
          </Field>
          <Field label="用人经理" required>
            <select name="managerId" required>
              {state.users
                .filter((u) => u.role === "manager")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="招聘批次">
            <input name="batch" placeholder="如：2027 届秋季校园招聘" />
          </Field>
          <Field label="毕业年份" help="校招必填，多个年份以逗号分隔">
            <input name="graduationYears" placeholder="2027" />
          </Field>
          <Field
            label="岗位技能"
            required
            span
            help="多个技能用逗号分隔，用于透明的技能核对"
          >
            <input
              name="skills"
              required
              placeholder="用户研究，产品设计，数据分析"
            />
          </Field>
          <Field label="评价维度" required span>
            <input
              name="dimensions"
              required
              defaultValue="专业能力，沟通协作，解决问题"
            />
          </Field>
          <Field label="职位描述" required span>
            <textarea
              name="description"
              rows={4}
              required
              placeholder="职责、任职要求与工作安排"
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "candidate")
    return (
      <CandidateIntake
        state={state}
        user={user}
        onAction={onAction}
        onClose={onClose}
        defaultJobId={modal.jobId}
      />
    );
  if (modal.kind === "editCandidate")
    return (
      <Modal
        title="编辑候选人资料"
        subtitle="更新主资料；已有投递保留当时的简历快照。"
        onClose={onClose}
        wide
      >
        <Form
          onClose={onClose}
          submit="保存资料"
          onSubmit={(d) => {
            if (!text(d, "email") && !text(d, "phone"))
              throw new Error("邮箱与手机号至少填写一种，请补充可用联系方式。");
            return onAction("updateCandidate", {
              candidateId: candidate?.id,
              jobId: text(d, "jobId"),
              name: text(d, "name"),
              email: text(d, "email"),
              phone: text(d, "phone"),
              school: text(d, "school"),
              education: text(d, "education"),
              major: text(d, "major"),
              graduationYear: text(d, "graduationYear")
                ? Number(d.get("graduationYear"))
                : null,
              skills: csvList(d, "skills"),
              resume: text(d, "resume"),
              availability: text(d, "availability"),
              source: text(d, "source"),
            });
          }}
        >
          <Field label="姓名" required>
            <input
              name="name"
              required
              maxLength={30}
              defaultValue={candidate?.name}
            />
          </Field>
          <Field label="邮箱（与手机号至少填写一种）">
            <input
              name="email"
              type="email"
              defaultValue={candidate?.email}
              placeholder="name@example.com"
            />
          </Field>
          <Field label="手机号码">
            <input
              name="phone"
              pattern="[+0-9 ()-]{7,20}"
              defaultValue={candidate?.phone}
              placeholder="13800000000"
            />
          </Field>
          <Field label="来源渠道">
            <select
              name="source"
              defaultValue={application?.source || "主动寻访"}
            >
              {[
                "主动寻访",
                "招聘网站",
                "内部推荐",
                "校园宣讲",
                "校招官网",
                "人才库",
                "其他",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="毕业院校">
            <input name="school" defaultValue={candidate?.school} />
          </Field>
          <Field label="专业">
            <input name="major" defaultValue={candidate?.major} />
          </Field>
          <Field label="最高学历" help="未知资料保留待核实，不推断学历">
            <select
              name="education"
              defaultValue={candidate?.education || "unknown"}
            >
              <option value="unknown">待核实</option>
              <option value="college">大专</option>
              <option value="bachelor">本科</option>
              <option value="master">硕士</option>
              <option value="doctor">博士</option>
            </select>
          </Field>
          <Field label="毕业年份" help="未知可留空，由 HR 核实毕业年份">
            <input
              name="graduationYear"
              type="number"
              min="1970"
              max="2100"
              defaultValue={candidate?.graduationYear || ""}
            />
          </Field>
          <Field label="可到岗时间">
            <input
              name="availability"
              defaultValue={candidate?.availability}
              placeholder="如：两周内"
            />
          </Field>
          <Field label="专业技能" required span>
            <input
              name="skills"
              required
              defaultValue={candidate?.skills.join("，")}
              placeholder="多个技能用逗号分隔"
            />
          </Field>
          <Field
            label="简历文本"
            required
            span
            help="Demo 使用文本简历，不上传真实个人资料。"
          >
            <textarea
              name="resume"
              required
              rows={5}
              defaultValue={candidate?.resume}
              placeholder="工作／项目经历、教育背景与相关证据"
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "advance")
    return (
      <Modal
        title="推进招聘流程"
        subtitle="确认筛选证据后推进，操作会记录在流程历史中。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="确认推进"
          onSubmit={(d) =>
            onAction("advance", {
              applicationId: application?.id,
              note: text(d, "note"),
            })
          }
        >
          <Field label="筛选意见 / 推进依据" required span>
            <textarea
              name="note"
              required
              minLength={3}
              rows={4}
              placeholder="记录简历证据、岗位匹配情况与下一步安排"
              defaultValue={application?.screeningNote}
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "close")
    return (
      <Modal
        title="关闭本次投递"
        subtitle="保留候选人档案与完整操作记录。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="关闭投递"
          danger
          onSubmit={(d) =>
            onAction("closeApplication", {
              applicationId: application?.id,
              outcome: text(d, "outcome"),
              reason: text(d, "reason"),
            })
          }
        >
          <Field label="关闭原因类型" span>
            <select name="outcome">
              <option value="not_suitable">暂不匹配</option>
              <option value="withdrawn">候选人退出</option>
              <option value="no_show">未到岗 / 失联</option>
              <option value="job_closed">职位关闭</option>
              <option value="record_error">录入错误（排除统计）</option>
            </select>
          </Field>
          <Field label="原因说明" required span>
            <textarea
              name="reason"
              required
              rows={3}
              placeholder="至少记录一条与岗位相关的具体原因"
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "decision")
    return (
      <Modal
        title="提交录用决策"
        subtitle="请结合已提交的面试评价，由用人经理独立确认。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="确认决策"
          onSubmit={(d) =>
            onAction("decision", {
              applicationId: application?.id,
              decision: text(d, "decision"),
              note: text(d, "note"),
            })
          }
        >
          <Field label="决策结果" required span>
            <select name="decision">
              <option value="hire">建议录用</option>
              <option value="reject">不予录用</option>
            </select>
          </Field>
          <Field label="决策依据" required span>
            <textarea
              name="note"
              required
              rows={4}
              placeholder="说明录用条件、评价分歧或不匹配的岗位要求"
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "schedule" || modal.kind === "reschedule")
    return (
      <Modal
        title={modal.kind === "schedule" ? "安排面试" : "调整面试时间"}
        subtitle="时间统一使用北京时间（UTC+8），系统会检查面试官时间冲突。"
        onClose={onClose}
        wide
      >
        <Form
          onClose={onClose}
          submit={modal.kind === "schedule" ? "确认安排" : "保存新时间"}
          onSubmit={(d) =>
            onAction(
              modal.kind === "schedule"
                ? "scheduleInterview"
                : "rescheduleInterview",
              modal.kind === "schedule"
                ? {
                    applicationId: application?.id,
                    round: text(d, "round"),
                    start: toISO(text(d, "start")),
                    end: toISO(text(d, "end")),
                    interviewerIds: d.getAll("interviewerIds"),
                    location: text(d, "location"),
                    confirmed: true,
                  }
                : {
                    interviewId: interview?.id,
                    start: toISO(text(d, "start")),
                    end: toISO(text(d, "end")),
                  },
            )
          }
        >
          {modal.kind === "schedule" && (
            <>
              <Field label="面试轮次" required>
                <input name="round" required defaultValue="专业一面" />
              </Field>
              <Field label="面试地点 / 会议链接" required>
                <input
                  name="location"
                  required
                  placeholder="上海办公室 / 会议链接"
                />
              </Field>
            </>
          )}
          <Field label="开始时间（北京时间）" required>
            <input
              name="start"
              required
              type="datetime-local"
              defaultValue={inputDate(
                interview?.start ||
                  new Date(Date.now() + 86400000).toISOString(),
              )}
            />
          </Field>
          <Field label="结束时间（北京时间）" required>
            <input
              name="end"
              required
              type="datetime-local"
              defaultValue={inputDate(
                interview?.end || new Date(Date.now() + 90000000).toISOString(),
              )}
            />
          </Field>
          {modal.kind === "schedule" && (
            <Field
              label="参与面试官"
              required
              span
              help="可安排多位面试官，每人需提交独立评价。"
            >
              <div className="check-grid">
                {interviewers.map((u) => (
                  <label className="check-option" key={u.id}>
                    <input type="checkbox" name="interviewerIds" value={u.id} />
                    <span>
                      {u.name}
                      <small>{ROLE_LABELS[u.role]}</small>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          <div className="info-strip full">
            系统内安排，待人工通知。安排成功后，请通过电话或邮件向候选人确认。
          </div>
        </Form>
      </Modal>
    );
  if (modal.kind === "scorecard") {
    const existing = state.scorecards.find(
      (s) => s.interviewId === interview?.id && s.userId === user.id,
    );
    const dimensions = interviewJob?.dimensions || [
      "专业能力",
      "沟通协作",
      "解决问题",
    ];
    return (
      <Modal
        title="填写独立面试评价"
        subtitle={`${interview?.round || "面试"} · 草稿对其他面试官不可见，提交后供经理决策。`}
        onClose={onClose}
        wide
      >
        <Form
          onClose={onClose}
          submit="保存评价"
          onSubmit={(d) =>
            onAction(
              text(d, "mode") === "draft" ? "saveScorecard" : "submitScorecard",
              {
                interviewId: interview?.id,
                ratings: Object.fromEntries(
                  dimensions.map((k, i) => [
                    k,
                    text(d, "rating" + i) ? Number(d.get("rating" + i)) : null,
                  ]),
                ),
                evidence: text(d, "evidence"),
                recommendation: text(d, "recommendation"),
              },
            )
          }
        >
          {dimensions.map((dimension, index) => (
            <Field label={dimension + "（1–5 分）"} key={dimension}>
              <select
                name={"rating" + index}
                defaultValue={existing?.ratings[dimension] ?? ""}
              >
                <option value="">未评价</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} ·{" "}
                    {
                      [
                        "",
                        "明显不足",
                        "部分达到",
                        "符合要求",
                        "超出预期",
                        "表现突出",
                      ][n]
                    }
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="面试证据" span>
            <textarea
              name="evidence"
              rows={5}
              defaultValue={existing?.evidence}
              placeholder="记录具体提问、候选人回答与行为证据；正式提交时必填。"
            />
          </Field>
          <Field label="综合建议">
            <select
              name="recommendation"
              defaultValue={existing?.recommendation || "hire"}
            >
              <option value="hire">建议通过</option>
              <option value="hold">待进一步确认</option>
              <option value="reject">建议不通过</option>
            </select>
          </Field>
          <Field label="保存方式">
            <select name="mode">
              <option value="submitted">正式提交（必填全部分数与证据）</option>
              <option value="draft">保存草稿</option>
            </select>
          </Field>
        </Form>
      </Modal>
    );
  }
  if (modal.kind === "returnScorecard")
    return (
      <Modal
        title="退回面试评价"
        subtitle="请指出需要补充的事实或评价维度。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="退回补充"
          onSubmit={(d) =>
            onAction("returnScorecard", {
              scorecardId: modal.scorecardId,
              reason: text(d, "reason"),
            })
          }
        >
          <Field label="退回原因" required span>
            <textarea name="reason" required rows={3} />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "offer")
    return (
      <Modal
        title="记录 Offer 发送"
        subtitle="本操作记录线下 Offer；不会发送邮件或生成具有法律效力的文件。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="记录已发送"
          onSubmit={(d) =>
            onAction("sendOffer", {
              applicationId: application?.id,
              deadline: toISO(text(d, "deadline")),
              reference: text(d, "reference"),
            })
          }
        >
          <Field label="Offer 编号 / 文件引用" required span>
            <input name="reference" required placeholder="如：OFFER-2026-001" />
          </Field>
          <Field label="答复截止时间（北京时间）" required span>
            <input
              name="deadline"
              required
              type="datetime-local"
              defaultValue={inputDate(
                new Date(Date.now() + 7 * 86400000).toISOString(),
              )}
            />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "offerResponse")
    return (
      <Modal
        title="登记 Offer 答复"
        subtitle="请按候选人已确认的线下答复进行登记。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="保存答复"
          onSubmit={(d) =>
            onAction("offerResponse", {
              applicationId: application?.id,
              status: text(d, "status"),
              plannedJoinDate: text(d, "plannedJoinDate"),
              reason: text(d, "reason"),
            })
          }
        >
          <Field label="答复状态" required span>
            <select name="status">
              <option value="accepted">已接受</option>
              <option value="rejected">已拒绝</option>
              <option value="expired">逾期未回复</option>
              <option value="withdrawn">企业撤回</option>
            </select>
          </Field>
          <Field label="预计入职日期" span help="接受 Offer 时必填">
            <input
              name="plannedJoinDate"
              type="date"
              defaultValue={application?.plannedJoinDate?.slice(0, 10)}
            />
          </Field>
          <Field label="补充说明" span>
            <textarea name="reason" rows={3} />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "agreement")
    return (
      <Modal
        title="登记校招协议"
        subtitle="跟踪三方协议或实习协议，保留签署状态。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="保存协议记录"
          onSubmit={(d) => {
            if (text(d, "status") === "waived" && !text(d, "note"))
              throw new Error("豁免协议时请在备注中填写不适用的具体依据。");
            return onAction("agreement", {
              applicationId: application?.id,
              type: text(d, "type"),
              status: text(d, "status"),
              date: text(d, "date"),
              note: text(d, "note"),
            });
          }}
        >
          <Field label="协议类型">
            <select
              name="type"
              defaultValue={application?.agreement.type || "三方协议"}
            >
              <option>三方协议</option>
              <option>实习协议</option>
              <option>其他协议</option>
            </select>
          </Field>
          <Field label="协议状态">
            <select
              name="status"
              defaultValue={application?.agreement.status || "pending"}
            >
              <option value="pending">待签署</option>
              <option value="signed">已签署</option>
              <option value="waived">不适用 / 已豁免（须说明依据）</option>
            </select>
          </Field>
          <Field label="签署日期" span>
            <input name="date" type="date" />
          </Field>
          <Field
            label="备注 / 豁免依据"
            span
            help="选择不适用 / 已豁免时，必须填写具体依据。"
          >
            <textarea name="note" rows={3} />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "join")
    return (
      <Modal
        title="确认实际入职结果"
        subtitle="只有确认实际到岗后，才会计入招聘入职人数。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="登记入职结果"
          onSubmit={(d) =>
            onAction("join", {
              applicationId: application?.id,
              status: text(d, "status"),
              date: text(d, "date"),
              reason: text(d, "reason"),
            })
          }
        >
          <Field label="入职结果" required span>
            <select name="status">
              <option value="joined">已实际入职</option>
              <option value="no_show">未入职 / 未到岗</option>
            </select>
          </Field>
          <Field label="实际入职日期" span>
            <input
              name="date"
              type="date"
              defaultValue={new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Asia/Shanghai",
              }).format(new Date())}
            />
          </Field>
          <Field label="备注 / 未入职原因" span>
            <textarea name="reason" rows={3} />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "anonymize")
    return (
      <Modal
        title="清理候选人合成资料"
        subtitle="不可恢复：清理姓名、联系方式及简历等合成个人资料，保留统计与审计记录。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="确认清理资料"
          danger
          onSubmit={(d) => {
            if (text(d, "confirm") !== candidate?.name)
              throw new Error("输入的姓名与当前候选人不一致，请重新核对。");
            return onAction("anonymizeCandidate", {
              candidateId: candidate?.id,
              reason: text(d, "reason"),
            });
          }}
        >
          <Field label={`输入“${candidate?.name}”以确认`} required span>
            <input name="confirm" required />
          </Field>
          <Field label="清理原因" required span>
            <textarea name="reason" rows={3} required />
          </Field>
        </Form>
      </Modal>
    );
  if (modal.kind === "reset")
    return (
      <Modal
        title="重置演示数据"
        subtitle="将清空本次 Demo 的全部操作并恢复合成样本，其他演示用户也会受到影响。"
        onClose={onClose}
      >
        <Form
          onClose={onClose}
          submit="重置演示环境"
          danger
          onSubmit={(d) => {
            if (text(d, "confirm") !== "重置演示")
              throw new Error("请输入“重置演示”确认操作。");
            return onAction("reset");
          }}
        >
          <Field label="输入“重置演示”确认" required span>
            <input name="confirm" required autoComplete="off" />
          </Field>
        </Form>
      </Modal>
    );
  return null;
}
function ImportModal({
  state,
  onAction,
  onClose,
  defaultJobId,
}: {
  state: AppState;
  onAction: Action;
  onClose: () => void;
  defaultJobId?: string;
}) {
  const [csv, setCsv] = useState(""),
    [jobId, setJobId] = useState(
      defaultJobId || state.jobs.find((j) => j.status === "open")?.id || "",
    ),
    [preview, setPreview] = useState<ImportJob | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState(false),
    [done, setDone] = useState(false);
  const template =
    "name,email,phone,school,major,graduationYear,skills,resume,availability,source\n林嘉宁,linjianing.demo@example.com,13900009991,上海大学,计算机科学,2027,TypeScript;React,校园项目中负责前端研发与团队协作,2027年7月,校园宣讲";
  async function execute() {
    setBusy(true);
    setError("");
    try {
      if (!preview && new TextEncoder().encode(csv).length > 1048576)
        throw new Error("CSV 内容超过 1 MiB，请拆分名单后重试。");
      const result = await onAction(
        preview ? "importCommit" : "importPreview",
        preview
          ? { importId: preview.id, linkDuplicates: link }
          : { jobId, csv },
      );
      const item = preview
        ? result.state.imports.find((x) => x.id === preview.id)
        : result.state.imports[0];
      setPreview(item || null);
      if (preview) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="批量导入候选人"
      subtitle="先预检每一行，再确认入库；重复候选人需要明确关联。"
      onClose={onClose}
      wide
    >
      <div className="import-steps">
        <span className={!preview ? "current" : "complete"}>
          <b>{preview ? <Check size={13} /> : 1}</b>上传名单
        </span>
        <ArrowRight size={14} />
        <span className={preview && !done ? "current" : done ? "complete" : ""}>
          <b>{done ? <Check size={13} /> : 2}</b>预检与确认
        </span>
        <ArrowRight size={14} />
        <span className={done ? "complete" : ""}>
          <b>3</b>导入完成
        </span>
      </div>
      <div className="modal-body">
        {!preview ? (
          <>
            <div className="form-grid">
              <Field label="投递职位" required span>
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                >
                  {state.jobs
                    .filter((j) => j.status === "open")
                    .map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.title} · {j.type === "campus" ? "校招" : "社招"}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="选择 CSV 文件" span>
                <label className="file-drop">
                  <Upload size={25} />
                  <strong>选择 UTF-8 编码的 CSV 名单</strong>
                  <span>也可直接在下方粘贴内容</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.size > 1048576) {
                          setError("文件超过 1 MiB，请拆分名单后重试。");
                          return;
                        }
                        setCsv(await file.text());
                      }
                    }}
                  />
                </label>
              </Field>
              <Field label="CSV 内容" required span>
                <textarea
                  rows={5}
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                  placeholder={template}
                />
              </Field>
            </div>
            <button
              className="text-button"
              onClick={() => download("拾才-候选人导入模板.csv", template)}
            >
              <Download size={15} />
              下载标准模板
            </button>
            <p className="helper">
              必填：姓名，以及邮箱或手机号中的至少一项。技能以分号分隔；毕业年份未知可留空，交由
              HR 核实。单次上限 1 MiB / 1000 行，模板内容均为合成资料。
            </p>
          </>
        ) : (
          <>
            <div className="import-summary">
              <FileSpreadsheet size={25} />
              <div>
                <strong>
                  {done ? "导入结果已保存" : "预检完成，请核对逐行结果"}
                </strong>
                <p>
                  共 {preview.rows.length} 行 ·{" "}
                  {
                    preview.rows.filter(
                      (r) => r.status === "ready" || r.status === "success",
                    ).length
                  }{" "}
                  行可用 ·{" "}
                  {preview.rows.filter((r) => r.status === "duplicate").length}{" "}
                  行重复 ·{" "}
                  {preview.rows.filter((r) => r.status === "error").length}{" "}
                  行异常
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>行号</th>
                    <th>姓名</th>
                    <th>邮箱</th>
                    <th>结果</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.index}>
                      <td>{r.index}</td>
                      <td>{r.raw.name || r.raw["姓名"] || "—"}</td>
                      <td>{r.raw.email || r.raw["邮箱"] || "—"}</td>
                      <td>
                        <span
                          className={
                            "badge tone-" +
                            (r.status === "error"
                              ? "red"
                              : r.status === "duplicate"
                                ? "amber"
                                : "green")
                          }
                        >
                          {
                            {
                              ready: "可导入",
                              duplicate: "重复候选人",
                              error: "异常",
                              success: "已导入",
                              skipped: "已跳过",
                            }[r.status]
                          }
                        </span>
                      </td>
                      <td>{r.error || "校验通过"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!done && (
              <label className="check-option import-confirm">
                <input
                  type="checkbox"
                  checked={link}
                  onChange={(e) => setLink(e.target.checked)}
                />
                <span>
                  将重复候选人关联到当前职位
                  <small>
                    已投递同一职位的记录不会重复创建；不勾选时跳过重复资料。
                  </small>
                </span>
              </label>
            )}
          </>
        )}
        <ErrorMessage message={error} />
      </div>
      <div className="modal-footer">
        <button className="button" onClick={onClose}>
          {done ? "关闭" : "取消"}
        </button>
        {preview && !done && (
          <button
            className="button"
            disabled={busy}
            onClick={() => setPreview(null)}
          >
            返回修改
          </button>
        )}
        {!done && (
          <button
            className="button primary"
            disabled={busy || (!preview && (!csv.trim() || !jobId))}
            onClick={execute}
          >
            {busy ? (
              <>
                <Spinner />
                处理中
              </>
            ) : preview ? (
              "确认导入"
            ) : (
              "开始预检"
            )}
          </button>
        )}
      </div>
    </Modal>
  );
}
