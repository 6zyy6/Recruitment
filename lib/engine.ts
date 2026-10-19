import type {
  AppState,
  Application,
  Candidate,
  ImportRow,
  Interview,
  Job,
  User,
} from "./domain.ts";
import { createSeed } from "./seed.ts";
import { parseCsv } from "./csv.ts";
import { safeMeetingUrl } from "./interview.ts";
import { CandidateReviewError, revokeCandidateReview } from "./candidate-review.ts";
import {
  handleSelectionAction,
  SelectionError,
  SELECTION_ACTIONS,
} from "./selection.ts";

export class BusinessError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
type Input = Record<string, unknown>;
const fail = (code: string, message: string, status = 422): never => {
  throw new BusinessError(code, message, status);
};
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(str).filter(Boolean)
    : str(value)
        .split(/[,，;；\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
function required(value: unknown, label: string): string {
  const result = str(value);
  if (!result) fail("REQUIRED", `请填写${label}`);
  if (result.length > 20000) fail("TOO_LONG", `${label}过长`);
  return result;
}
function iso(value: unknown, label: string): string {
  const text = required(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}(T|$)/.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    fail("INVALID_DATE", `${label}格式不正确`);
  return new Date(text).toISOString();
}
function day(value: unknown, label: string): string {
  const text = required(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text
  )
    fail("INVALID_DATE", `${label}格式不正确`);
  return text;
}
const phoneKey = (phone: string) => phone.replace(/[\s()+-]/g, "");
function candidateFields(input: Input, now: string): Omit<Candidate, "id"> {
  const email = str(input.email).toLowerCase(),
    phone = str(input.phone);
  if (!email && !phone) fail("CONTACT_REQUIRED", "邮箱和手机至少填写一项");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail("INVALID_EMAIL", "邮箱格式不正确");
  if (phone && !/^\+?[\d\s()-]{7,22}$/.test(phone))
    fail("INVALID_PHONE", "手机格式不正确");
  const yearText =
    str(input.graduationYear) ||
    (typeof input.graduationYear === "number"
      ? String(input.graduationYear)
      : "");
  const year = yearText ? Number(yearText) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1960 || year > 2100))
    fail("INVALID_YEAR", "毕业年份应为 1960–2100 的整数");
  if (
    input.education !== undefined &&
    (typeof input.education !== "string" || input.education.trim().length > 40)
  )
    fail("INVALID_EDUCATION", "学历应为 40 字符以内的文本");
  return {
    name: required(input.name, "姓名"),
    email,
    phone,
    school: str(input.school),
    major: str(input.major),
    graduationYear: year,
    ...(str(input.education) ? { education: str(input.education) } : {}),
    skills: [...new Set(list(input.skills))],
    resume: str(input.resume),
    availability: str(input.availability),
    createdAt: now,
  };
}
function duplicateCandidate(
  state: AppState,
  candidate: Pick<Candidate, "email" | "phone">,
  exceptId = "",
) {
  const matches = state.candidates.filter(
    (c) =>
      c.id !== exceptId &&
      ((candidate.email &&
        c.email.toLowerCase() === candidate.email.toLowerCase()) ||
        (candidate.phone && phoneKey(c.phone) === phoneKey(candidate.phone))),
  );
  if (matches.length > 1)
    fail("CONTACT_CONFLICT", "邮箱与手机号命中不同档案，需人工核实后重试", 409);
  return matches[0];
}
function redactText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[联系方式已隐藏]")
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, "[联系方式已隐藏]");
}
function restrictCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    email: "",
    phone: "",
    resume: redactText(candidate.resume),
    availability: redactText(candidate.availability),
    restricted: true,
    review: undefined,
  };
}

export function projectState(source: AppState, user: User): AppState {
  const state = structuredClone(source);
  delete state.reviews;
  delete state.careerSubmissions;
  if (user.role === "admin")
    return {
      ...state,
      jobs: [],
      candidates: [],
      applications: [],
      interviews: [],
      scorecards: [],
      events: [],
      imports: [],
    };
  if (user.role === "manager")
    state.jobs = state.jobs.filter((job) => job.managerId === user.id);
  if (user.role === "interviewer") {
    state.interviews = state.interviews.filter((interview) =>
      interview.interviewerIds.includes(user.id),
    );
    const applicationIds = new Set(
      state.interviews.map((interview) => interview.applicationId),
    );
    state.applications = state.applications.filter((application) =>
      applicationIds.has(application.id),
    );
    const jobIds = new Set(
      state.applications.map((application) => application.jobId),
    );
    state.jobs = state.jobs.filter((job) => jobIds.has(job.id));
  } else {
    const jobIds = new Set(state.jobs.map((job) => job.id));
    state.applications = state.applications.filter((application) =>
      jobIds.has(application.jobId),
    );
    const applicationIds = new Set(
      state.applications.map((application) => application.id),
    );
    state.interviews = state.interviews.filter((interview) =>
      applicationIds.has(interview.applicationId),
    );
  }
  const applicationIds = new Set(
    state.applications.map((application) => application.id),
  );
  const candidateIds = new Set(
    state.applications.map((application) => application.candidateId),
  );
  const interviewIds = new Set(
    state.interviews.map((interview) => interview.id),
  );
  state.candidates = state.candidates.filter((candidate) =>
    candidateIds.has(candidate.id),
  );
  state.scorecards = state.scorecards.filter((card) => {
    if (!interviewIds.has(card.interviewId)) return false;
    if (card.userId === user.id) return true;
    const interview = state.interviews.find(
      (item) => item.id === card.interviewId,
    )!;
    if (
      interview.interviewerIds.includes(user.id) &&
      !source.scorecards.some(
        (own) =>
          own.interviewId === card.interviewId &&
          own.userId === user.id &&
          own.status === "submitted",
      )
    )
      return false;
    return card.status === "submitted";
  });
  state.events = state.events.filter((event) =>
    applicationIds.has(event.applicationId),
  );
  state.imports = user.role === "hr" ? state.imports : [];
  state.scorecards = state.scorecards.map((card) => ({
    ...card,
    assistReport:
      card.userId === user.id && card.status === "submitted"
        ? card.assistReport
        : undefined,
  }));
  if (user.role === "interviewer") {
    state.events = state.events.filter(
      (event) => !SELECTION_ACTIONS.includes(event.type),
    );
    state.candidates = state.candidates.map(restrictCandidate);
    state.applications = state.applications.map((app) => ({
      ...app,
      selection: undefined,
      outcome:
        app.selection?.hrReview?.conclusion === "reject"
          ? "本次投递已关闭"
          : app.outcome,
      snapshot: restrictCandidate(app.snapshot),
      screeningNote: redactText(app.screeningNote),
      decisionNote: redactText(app.decisionNote),
      offer: { ...app.offer, reference: "" },
      agreement: { ...app.agreement, note: "" },
    }));
    state.events = state.events.map((event) => ({
      ...event,
      note: redactText(event.note),
    }));
    state.scorecards = state.scorecards.map((card) => ({
      ...card,
      evidence: redactText(card.evidence),
      assistReport: card.assistReport
        ? {
            ...card.assistReport,
            summary: redactText(card.assistReport.summary),
            gaps: card.assistReport.gaps.map(redactText),
            evidence: card.assistReport.evidence.map((item) => ({
              ...item,
              quote: redactText(item.quote),
            })),
          }
        : undefined,
    }));
  }
  return state;
}

export function applyAction(
  source: AppState,
  user: User,
  input: Input,
  clock = new Date(),
): AppState {
  if (
    typeof input.expectedRevision !== "number" ||
    input.expectedRevision !== source.revision
  )
    fail("REVISION_CONFLICT", "数据已被其他操作更新，请刷新后重试", 409);
  if (
    !source.users.some(
      (account) => account.id === user.id && account.role === user.role,
    )
  )
    fail("UNAUTHORIZED", "登录身份无效", 401);
  const action = required(input.action, "操作");
  if (user.role === "admin")
    fail("FORBIDDEN", "系统管理员只维护账号，无权查看或操作招聘数据", 403);
  const state = structuredClone(source),
    now = clock.toISOString();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  const hr = () => {
    if (user.role !== "hr") fail("FORBIDDEN", "此操作需要招聘 HR 权限", 403);
  };
  const jobById = (jobId: unknown) =>
    state.jobs.find((job) => job.id === jobId) ??
    fail("NOT_FOUND", "职位不存在", 404);
  const appById = (appId: unknown) => {
    const app =
      state.applications.find((a) => a.id === appId) ??
      fail("NOT_FOUND", "投递不存在", 404);
    const job = jobById(app.jobId);
    if (user.role === "manager" && job.managerId !== user.id)
      fail("FORBIDDEN", "仅可操作本人负责的职位", 403);
    if (
      user.role === "interviewer" &&
      !state.interviews.some(
        (i) => i.applicationId === app.id && i.interviewerIds.includes(user.id),
      )
    )
      fail("FORBIDDEN", "仅可访问本人面试的投递", 403);
    return app;
  };
  const interviewById = (interviewId: unknown) => {
    const interview =
      state.interviews.find((i) => i.id === interviewId) ??
      fail("NOT_FOUND", "面试不存在", 404);
    appById(interview.applicationId);
    return interview;
  };
  const active = (app: Application) => {
    if (app.status !== "active")
      fail("APPLICATION_CLOSED", "该投递已结束，不能继续操作");
  };
  const event = (
    app: Application,
    type: string,
    from = "",
    to = "",
    note = "",
  ) => {
    app.version++;
    app.updatedAt = now;
    state.events.push({
      id: id("event"),
      applicationId: app.id,
      actorId: user.id,
      at: now,
      type,
      from,
      to,
      note,
    });
  };
  const candidateInput = (data: Input) => candidateFields(data, now);
  const ensureJobOpen = (job: Job) => {
    if (job.status !== "open")
      fail("JOB_NOT_OPEN", "职位尚未发布或已暂停/关闭，不能接收新投递");
  };
  const createApplication = (
    candidate: Candidate,
    job: Job,
    sourceName: unknown,
  ) => {
    ensureJobOpen(job);
    const existing = state.applications.find(
      (app) =>
        app.jobId === job.id &&
        app.candidateId === candidate.id &&
        app.status === "active",
    );
    if (existing) return existing;
    const app: Application = {
      id: id("application"),
      candidateId: candidate.id,
      jobId: job.id,
      snapshot: structuredClone(candidate),
      stage: "new",
      status: "active",
      outcome: "",
      source: str(sourceName) || "手动录入",
      ownerId: user.id,
      createdAt: now,
      updatedAt: now,
      version: 0,
      screeningNote: "",
      decision: "pending",
      decisionNote: "",
      offer: {
        status: "none",
        sentAt: "",
        deadline: "",
        answeredAt: "",
        reference: "",
      },
      agreement: {
        type: job.type === "campus" ? "三方协议" : "劳动合同",
        status: "pending",
        date: "",
        note: "",
      },
      plannedJoinDate: "",
      joinedAt: "",
    };
    delete app.snapshot.review;
    state.applications.push(app);
    event(app, "created", "", "new", `通过${app.source}创建投递`);
    return app;
  };
  const validateInterview = (app: Application, data: Input, exceptId = "") => {
    active(app);
    if (app.stage !== "interview")
      fail("INVALID_STAGE", "请先完成筛选并推进到面试阶段");
    const start = iso(data.start, "面试开始时间"),
      end = iso(data.end, "面试结束时间");
    const previous = state.interviews.find((interview) => interview.id === exceptId);
    const unchangedTime = previous &&
      Date.parse(previous.start) === Date.parse(start) &&
      Date.parse(previous.end) === Date.parse(end);
    if (Date.parse(start) < clock.getTime() && !unchangedTime)
      fail("PAST_INTERVIEW", "面试开始时间不能早于当前时间");
    if (end <= start || Date.parse(end) - Date.parse(start) > 8 * 3600000)
      fail(
        "INVALID_INTERVAL",
        "面试结束时间应晚于开始时间，且时长不超过 8 小时",
      );
    const interviewerIds = [...new Set(list(data.interviewerIds))];
    if (
      !interviewerIds.length ||
      interviewerIds.some(
        (person) =>
          !state.users.some(
            (account) =>
              account.id === person &&
              ["interviewer", "manager"].includes(account.role),
          ),
      )
    )
      fail("INVALID_INTERVIEWER", "请选择有效的面试官");
    const conflicts = state.interviews.filter(
      (interview) =>
        interview.id !== exceptId &&
        interview.status === "scheduled" &&
        interview.start < end &&
        interview.end > start &&
        (interview.interviewerIds.some((person) =>
          interviewerIds.includes(person),
        ) ||
          state.applications.find((a) => a.id === interview.applicationId)
            ?.candidateId === app.candidateId),
    );
    if (conflicts.length)
      fail(
        "INTERVIEW_CONFLICT",
        "该时段面试官或候选人已有面试，请选择其他时间",
        409,
      );
    if (data.meetingUrl !== undefined && typeof data.meetingUrl !== "string")
      fail("INVALID_MEETING_URL", "会议链接格式不正确");
    const meetingUrlInput = typeof data.meetingUrl === "string" ? data.meetingUrl : "";
    const meetingUrl = safeMeetingUrl(meetingUrlInput);
    if (meetingUrlInput && !meetingUrl)
      fail("INVALID_MEETING_URL", "请填写有效的 HTTPS 会议链接，不得包含账号、密码或空白字符");
    const meetingId = str(data.meetingId),
      meetingPassword = str(data.meetingPassword);
    if (meetingId.length > 80) fail("TOO_LONG", "会议号不能超过 80 个字符");
    if (meetingPassword.length > 100) fail("TOO_LONG", "入会密码不能超过 100 个字符");
    return {
      start,
      end,
      interviewerIds,
      location: required(data.location, "面试地点 / 会议链接"),
      meetingUrl,
      meetingId,
      meetingPassword,
    };
  };
  const reviewComplete = (app: Application) => {
    const completed = state.interviews.filter(
      (interview) =>
        interview.applicationId === app.id && interview.status === "completed",
    );
    if (!completed.length)
      fail("NO_COMPLETED_INTERVIEW", "至少完成一场面试后才可录用");
    if (
      completed.some((interview) =>
        interview.interviewerIds.some(
          (person) =>
            !state.scorecards.some(
              (card) =>
                card.interviewId === interview.id &&
                card.userId === person &&
                card.status === "submitted",
            ),
        ),
      )
    )
      fail("SCORECARDS_PENDING", "已完成面试仍有评价未提交，请先收齐评价");
  };

  switch (action) {
    case "createJob": {
      hr();
      const data = (
        input.job && typeof input.job === "object" ? input.job : input
      ) as Input;
      const type = str(data.type);
      if (!["social", "campus"].includes(type))
        fail("INVALID_TYPE", "请选择社招或校招");
      const headcount = Number(data.headcount);
      if (!Number.isInteger(headcount) || headcount < 1 || headcount > 9999)
        fail("INVALID_HEADCOUNT", "招聘人数应为 1–9999 的整数");
      const managerId = str(data.managerId) || "manager";
      if (
        !state.users.some(
          (account) => account.id === managerId && account.role === "manager",
        )
      )
        fail("INVALID_MANAGER", "请选择有效的用人经理");
      const years = (
        Array.isArray(data.graduationYears)
          ? data.graduationYears
          : list(data.graduationYears)
      ).map(Number);
      if (
        type === "campus" &&
        (!str(data.batch) ||
          !years.length ||
          years.some((y) => !Number.isInteger(y) || y < 2020 || y > 2100))
      )
        fail("CAMPUS_JOB_FIELDS", "校招职位需要招聘批次和有效毕业年份");
      state.jobs.unshift({
        id: id("job"),
        title: required(data.title, "职位名称"),
        department: required(data.department, "部门"),
        location: required(data.location, "工作地点"),
        type: type as Job["type"],
        batch: str(data.batch),
        graduationYears: years,
        headcount,
        ownerId: user.id,
        managerId,
        status: "draft",
        description: str(data.description),
        skills: [...new Set(list(data.skills))],
        dimensions: list(data.dimensions).length
          ? [...new Set(list(data.dimensions))]
          : ["专业能力", "问题解决", "沟通协作", "岗位匹配"],
        createdAt: now,
      });
      break;
    }
    case "jobStatus": {
      const job = jobById(input.jobId);
      const targets: Record<string, string> = {
        submit: "pending",
        approve: "open",
        reject: "draft",
        pause: "paused",
        resume: "open",
        close: "closed",
      };
      const target = str(input.status) || targets[str(input.operation)];
      if (job.status === "pending" && ["open", "draft"].includes(target)) {
        if (user.role !== "manager" || job.managerId !== user.id)
          fail("FORBIDDEN", "职位发布需由该职位的用人经理审批", 403);
        if (target === "draft")
          required(input.reason ?? input.note, "驳回原因");
      } else {
        hr();
        const allowed: Record<string, string[]> = {
          draft: ["pending", "closed"],
          open: ["paused", "closed"],
          paused: ["open", "closed"],
        };
        if (!(allowed[job.status] || []).includes(target))
          fail("INVALID_TRANSITION", "当前职位状态不支持此操作");
      }
      if (
        target === "closed" &&
        state.applications.some(
          (app) => app.jobId === job.id && app.status === "active",
        )
      )
        fail(
          "JOB_HAS_ACTIVE_APPLICATIONS",
          "该职位仍有进行中的投递，请先处理或关闭投递后再关闭职位",
        );
      job.status = target as Job["status"];
      break;
    }
    case "createCandidate":
    case "createApplication": {
      hr();
      const job = jobById(input.jobId);
      ensureJobOpen(job);
      const data = (
        input.candidate && typeof input.candidate === "object"
          ? input.candidate
          : input
      ) as Input;
      const candidateId = str(data.candidateId || input.candidateId);
      if (candidateId) {
        const existing =
          state.candidates.find((c) => c.id === candidateId) ??
          fail("NOT_FOUND", "候选人不存在", 404);
        createApplication(existing, job, input.source);
        break;
      }
      if (action === "createApplication") fail("REQUIRED", "请选择候选人");
      const fields = candidateInput(data);
      if (duplicateCandidate(state, fields))
        fail(
          "DUPLICATE_CANDIDATE",
          "联系方式已存在，请使用 CSV 预检后确认关联已有候选人",
          409,
        );
      const candidate = { id: id("candidate"), ...fields };
      state.candidates.push(candidate);
      createApplication(candidate, job, input.source);
      break;
    }
    case "updateCandidate": {
      hr();
      const candidate =
        state.candidates.find((c) => c.id === input.candidateId) ??
        fail("NOT_FOUND", "候选人不存在", 404);
      const data = (
        input.candidate && typeof input.candidate === "object"
          ? input.candidate
          : input
      ) as Input;
      const fields = candidateInput({ ...candidate, ...data });
      if (duplicateCandidate(state, fields, candidate.id))
        fail("DUPLICATE_CANDIDATE", "联系方式与已有候选人重复", 409);
      Object.assign(candidate, fields, { createdAt: candidate.createdAt });
      state.applications
        .filter((app) => app.candidateId === candidate.id)
        .forEach((app) =>
          event(
            app,
            "profile_updated",
            "",
            "",
            "更新候选人主档；历史投递快照保持不变",
          ),
        );
      break;
    }
    case "advance": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      const from = app.stage;
      if (from === "new") app.stage = "screening";
      else if (from === "screening") {
        app.screeningNote = required(input.note, "筛选结论");
        app.stage = "interview";
      } else
        fail(
          "INVALID_TRANSITION",
          "该阶段请通过面试、发放 Offer 或入职操作推进",
        );
      event(app, "advanced", from, app.stage, str(input.note));
      break;
    }
    case "closeApplication": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      const reason = required(input.reason, "关闭原因");
      const outcomeLabels: Record<string, string> = {
        not_suitable: "暂不匹配",
        withdrawn: "候选人退出",
        no_show: "未到岗 / 失联",
        job_closed: "职位关闭",
        record_error: "录入错误",
        data_error: "录入错误",
      };
      const category = outcomeLabels[str(input.outcome)] || str(input.outcome);
      app.status = "closed";
      app.outcome =
        category === "录入错误"
          ? category
          : category
            ? `${category} · ${reason}`
            : reason;
      state.interviews
        .filter((i) => i.applicationId === app.id && i.status === "scheduled")
        .forEach((i) => {
          i.status = "cancelled";
        });
      if (app.offer.status === "sent" || app.offer.status === "accepted") {
        app.offer.status = "withdrawn";
        app.offer.answeredAt = now;
      }
      event(
        app,
        "closed",
        app.stage,
        "closed",
        category ? `${category} · ${reason}` : reason,
      );
      break;
    }
    case "decision": {
      const app = appById(input.applicationId);
      active(app);
      if (user.role !== "manager" || jobById(app.jobId).managerId !== user.id)
        fail("FORBIDDEN", "录用结论仅由该职位用人经理决定", 403);
      if (app.stage !== "interview")
        fail("INVALID_STAGE", "请在面试阶段提交录用结论");
      const decision = str(input.decision);
      if (!["hire", "reject"].includes(decision))
        fail("INVALID_DECISION", "请选择录用或不录用");
      const note = required(input.note, "决策依据");
      if (decision === "hire") reviewComplete(app);
      app.decision = decision as Application["decision"];
      app.decisionNote = note;
      event(app, "decision", "", decision, note);
      break;
    }
    case "scheduleInterview": {
      hr();
      const app = appById(input.applicationId);
      const fields = validateInterview(app, input);
      state.interviews.push({
        id: id("interview"),
        applicationId: app.id,
        round: required(input.round, "面试轮次"),
        ...fields,
        status: "scheduled",
        notified: false,
      });
      event(
        app,
        "interview_scheduled",
        "",
        "",
        `${str(input.round)} · ${fields.start}（通知待确认）`,
      );
      break;
    }
    case "rescheduleInterview": {
      hr();
      const interview = interviewById(input.interviewId);
      if (interview.status !== "scheduled")
        fail("INTERVIEW_LOCKED", "仅可改期尚未完成的面试");
      const fields = validateInterview(
        appById(interview.applicationId),
        { ...interview, ...input },
        interview.id,
      );
      Object.assign(interview, fields, { notified: false });
      event(
        appById(interview.applicationId),
        "interview_rescheduled",
        "",
        "",
        "面试安排已更新，需重新确认通知",
      );
      break;
    }
    case "notifyInterview": {
      hr();
      const interview = interviewById(input.interviewId);
      if (interview.status !== "scheduled")
        fail("INVALID_TRANSITION", "仅待进行的面试可以确认通知");
      interview.notified = true;
      event(
        appById(interview.applicationId),
        "interview_notification",
        "",
        "",
        "模拟通知已确认：Demo 未发送真实邮件/短信",
      );
      break;
    }
    case "interviewStatus": {
      hr();
      const interview = interviewById(input.interviewId);
      const app = appById(interview.applicationId);
      active(app);
      if (interview.status !== "scheduled")
        fail("INTERVIEW_LOCKED", "面试已结束，不能重复更改结果");
      const status = str(input.status);
      if (!["completed", "cancelled", "no_show"].includes(status))
        fail("INVALID_STATUS", "无效的面试结果");
      interview.status = status as Interview["status"];
      event(app, "interview_result", "scheduled", status, str(input.note));
      break;
    }
    case "saveScorecard":
    case "submitScorecard": {
      const interview = interviewById(input.interviewId),
        app = appById(interview.applicationId);
      active(app);
      if (!interview.interviewerIds.includes(user.id))
        fail("FORBIDDEN", "仅该场面试的面试官可以填写自己的评价", 403);
      if (!["scheduled", "completed"].includes(interview.status))
        fail("INTERVIEW_LOCKED", "已取消或未到场的面试不能填写评价");
      let card = state.scorecards.find(
        (c) => c.interviewId === interview.id && c.userId === user.id,
      );
      if (card?.status === "submitted")
        fail("SCORECARD_LOCKED", "评价已提交并锁定，请联系 HR 退回修改");
      const dimensions = jobById(app.jobId).dimensions;
      const supplied =
        input.ratings && typeof input.ratings === "object"
          ? (input.ratings as Record<string, unknown>)
          : (card?.ratings ?? {});
      const ratings: Record<string, number | null> = {};
      dimensions.forEach((dimension) => {
        const value = supplied[dimension];
        if (
          value !== null &&
          value !== undefined &&
          (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5)
        )
          fail("INVALID_RATING", `${dimension}评分应为 1–5 的整数`);
        ratings[dimension] =
          value === undefined || value === null ? null : Number(value);
      });
      const evidence =
        input.evidence === undefined
          ? (card?.evidence ?? "")
          : str(input.evidence);
      const recommendation =
        input.recommendation === undefined
          ? (card?.recommendation ?? "")
          : str(input.recommendation);
      if (action === "submitScorecard") {
        if (interview.status !== "completed")
          fail("INTERVIEW_NOT_COMPLETED", "请先由 HR 确认面试已完成");
        if (
          Object.values(ratings).some((value) => value === null) ||
          evidence.length < 5 ||
          !recommendation
        )
          fail(
            "INCOMPLETE_SCORECARD",
            "请填写所有能力维度评分、至少 5 个字的事实依据和结论",
          );
      }
      if (!card) {
        card = {
          id: id("scorecard"),
          interviewId: interview.id,
          userId: user.id,
          ratings,
          evidence,
          recommendation,
          status: "draft",
          submittedAt: "",
        };
        state.scorecards.push(card);
      }
      Object.assign(card, {
        ratings,
        evidence,
        recommendation,
        status: action === "submitScorecard" ? "submitted" : "draft",
        submittedAt: action === "submitScorecard" ? now : "",
      });
      event(
        app,
        action === "submitScorecard"
          ? "scorecard_submitted"
          : "scorecard_saved",
        "",
        "",
        action === "submitScorecard"
          ? "已提交面试评价，评价已锁定"
          : "已保存个人评价草稿",
      );
      break;
    }
    case "returnScorecard": {
      const card =
        state.scorecards.find((c) => c.id === input.scorecardId) ??
        fail("NOT_FOUND", "评价不存在", 404);
      const interview = interviewById(card.interviewId),
        app = appById(interview.applicationId);
      if (
        user.role !== "hr" &&
        !(user.role === "manager" && jobById(app.jobId).managerId === user.id)
      )
        fail("FORBIDDEN", "退回评价需要 HR 或该职位用人经理权限", 403);
      active(app);
      if (app.stage !== "interview")
        fail(
          "OFFER_ALREADY_SENT",
          "进入 Offer 阶段后不可退回用于录用决策的评价",
        );
      if (card.status !== "submitted")
        fail("INVALID_TRANSITION", "仅可退回已提交的评价");
      const reason = required(input.reason, "退回原因");
      card.status = "draft";
      card.submittedAt = "";
      delete card.assistReport;
      app.decision = "pending";
      app.decisionNote = "";
      event(app, "scorecard_returned", "", "", reason);
      break;
    }
    case "sendOffer": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      if (app.stage !== "interview" || app.offer.status !== "none")
        fail("INVALID_STAGE", "仅面试中的投递可首次发放 Offer");
      if (app.decision !== "hire")
        fail("DECISION_REQUIRED", "请先由用人经理确认录用");
      reviewComplete(app);
      if (
        state.interviews.some(
          (i) => i.applicationId === app.id && i.status === "scheduled",
        )
      )
        fail("INTERVIEWS_PENDING", "仍有待进行的面试，请先完成或取消");
      const deadline = iso(input.deadline, "Offer 截止时间");
      if (Date.parse(deadline) <= clock.getTime())
        fail("INVALID_DEADLINE", "Offer 截止时间必须晚于当前时间");
      app.offer = {
        status: "sent",
        sentAt: now,
        deadline,
        answeredAt: "",
        reference:
          str(input.reference) ||
          `OFFER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      };
      const from = app.stage;
      app.stage = "offer";
      event(
        app,
        "offer_sent",
        from,
        "offer",
        `Offer ${app.offer.reference} 已登记发放（模拟）`,
      );
      break;
    }
    case "offerResponse": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      const status = str(input.status);
      if (!["accepted", "rejected", "expired", "withdrawn"].includes(status))
        fail("INVALID_STATUS", "无效的 Offer 结果");
      if (
        app.offer.status !== "sent" &&
        !(status === "withdrawn" && app.offer.status === "accepted")
      )
        fail("INVALID_TRANSITION", "当前 Offer 状态不支持该操作");
      if (
        status === "expired" &&
        Date.parse(app.offer.deadline) > clock.getTime()
      )
        fail("OFFER_NOT_EXPIRED", "Offer 尚未超过截止时间");
      if (
        status === "accepted" &&
        Date.parse(app.offer.deadline) < clock.getTime()
      )
        fail("OFFER_EXPIRED", "Offer 已过截止时间，请登记过期结果");
      if (status === "accepted") {
        app.plannedJoinDate = day(input.plannedJoinDate, "计划入职日期");
        if (app.plannedJoinDate < today)
          fail("INVALID_JOIN_DATE", "计划入职日期不能早于今天");
        app.stage = "onboarding";
      } else {
        app.status = "closed";
        app.outcome = (
          {
            rejected: "候选人拒绝 Offer",
            expired: "Offer 已过期",
            withdrawn: "Offer 已撤回",
          } as Record<string, string>
        )[status];
      }
      app.offer.status = status as Application["offer"]["status"];
      app.offer.answeredAt = now;
      event(
        app,
        "offer_response",
        "offer",
        status === "accepted" ? "onboarding" : "closed",
        str(input.reason) || status,
      );
      break;
    }
    case "agreement": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      if (app.stage !== "onboarding" || app.offer.status !== "accepted")
        fail("INVALID_STAGE", "接受 Offer 后可登记协议");
      const status = str(input.status);
      if (!["pending", "signed", "waived"].includes(status))
        fail("INVALID_STATUS", "请选择待签署、已签署或豁免");
      if (status === "waived") required(input.note, "协议豁免依据");
      app.agreement = {
        type: required(input.type, "协议类型"),
        status,
        date:
          status === "signed" ? day(input.date, "签署日期") : str(input.date),
        note: str(input.note),
      };
      event(
        app,
        "agreement",
        "",
        status,
        `${app.agreement.type} · ${str(input.note)}`,
      );
      break;
    }
    case "join": {
      hr();
      const app = appById(input.applicationId);
      active(app);
      if (app.stage !== "onboarding" || app.offer.status !== "accepted")
        fail("INVALID_STAGE", "仅待入职候选人可确认入职结果");
      const status = str(input.status) || "joined";
      if (!["joined", "no_show"].includes(status))
        fail("INVALID_STATUS", "请选择已入职或未入职");
      if (status === "joined") {
        if (
          jobById(app.jobId).type === "campus" &&
          !["signed", "waived"].includes(app.agreement.status)
        )
          fail("AGREEMENT_REQUIRED", "请先完成协议签署或登记豁免依据");
        const joinedDay = day(input.date || today, "实际入职日期");
        if (joinedDay > today)
          fail("FUTURE_JOIN_DATE", "实际入职日期不能在未来");
        app.stage = "joined";
        app.status = "joined";
        app.joinedAt = `${joinedDay}T09:00:00+08:00`;
        app.outcome = "已入职";
        event(app, "joined", "onboarding", "joined", "已确认实际入职");
      } else {
        if (app.plannedJoinDate && app.plannedJoinDate > today)
          fail("JOIN_DATE_NOT_REACHED", "尚未到计划入职日，不能确认未入职");
        app.status = "closed";
        app.outcome = required(input.reason, "未入职原因");
        event(app, "not_joined", "onboarding", "closed", app.outcome);
      }
      break;
    }
    case "importPreview": {
      hr();
      const job = jobById(input.jobId);
      ensureJobOpen(job);
      let rawRows: Record<string, string>[];
      try {
        if (typeof input.csv !== "string" || !input.csv.trim())
          fail("REQUIRED", "请填写 CSV 内容");
        rawRows = parseCsv(input.csv as string);
      } catch (error) {
        fail(
          "INVALID_CSV",
          error instanceof Error ? error.message : "CSV 格式不正确",
        );
      }
      const contacts = new Set<string>();
      const rows: ImportRow[] = rawRows!.map((raw, index) => {
        const row: ImportRow = {
          index: index + 2,
          raw,
          status: "ready",
          error: "",
          candidateId: "",
          applicationId: "",
        };
        try {
          if (raw.__parseError) fail("INVALID_CSV_ROW", raw.__parseError);
          const fields = candidateInput(raw);
          const keys = [
            fields.email && `e:${fields.email}`,
            fields.phone && `p:${phoneKey(fields.phone)}`,
          ].filter(Boolean) as string[];
          if (keys.some((key) => contacts.has(key)))
            fail(
              "BATCH_DUPLICATE",
              "本批次有重复联系方式，请保留一行后重新预检",
            );
          keys.forEach((key) => contacts.add(key));
          const existing = duplicateCandidate(state, fields);
          if (existing) {
            row.candidateId = existing.id;
            const existingApplication = state.applications.find(
              (app) =>
                app.candidateId === existing.id &&
                app.jobId === job.id &&
                app.status === "active",
            );
            row.applicationId = existingApplication?.id || "";
            row.status = "duplicate";
            row.error =
              "联系方式与已有候选人相同，提交时需明确勾选关联已有档案；不会覆盖主档";
          }
        } catch (error) {
          row.status = "error";
          row.error = error instanceof Error ? error.message : "数据不正确";
        }
        return row;
      });
      state.imports.unshift({
        id: id("import"),
        jobId: job.id,
        createdAt: now,
        rows,
      });
      break;
    }
    case "importCommit": {
      hr();
      const task =
        state.imports.find((item) => item.id === input.importId) ??
        fail("NOT_FOUND", "导入预检不存在", 404);
      const job = jobById(task.jobId);
      ensureJobOpen(job);
      task.rows.forEach((row) => {
        if (
          row.status === "success" ||
          row.status === "error" ||
          row.status === "skipped"
        )
          return;
        if (row.status === "duplicate" && input.linkDuplicates !== true) {
          row.status = "skipped";
          row.error = "未确认关联已有档案，已跳过";
          return;
        }
        try {
          const fields = candidateInput(row.raw);
          let candidate = duplicateCandidate(state, fields);
          if (candidate) {
            if (input.linkDuplicates !== true) {
              row.status = "error";
              row.error = "预检后出现重复档案，请重新预检并确认关联";
              return;
            }
          } else {
            candidate = { id: id("candidate"), ...fields };
          }
          // Use a fresh copy only for the application snapshot; never overwrite an existing profile.
          if (!state.candidates.some((c) => c.id === candidate!.id))
            state.candidates.push(candidate);
          const app = createApplication(
            candidate,
            job,
            row.raw.source || "CSV 导入",
          );
          row.status = "success";
          row.candidateId = candidate.id;
          row.applicationId = app.id;
          row.error = "";
        } catch (error) {
          row.status = "error";
          row.error = error instanceof Error ? error.message : "导入失败";
        }
      });
      break;
    }
    case "createCandidateReview":
      hr();
      fail("REVIEW_ENDPOINT_REQUIRED", "请通过资料核对邀请接口生成安全链接");
    case "revokeCandidateReview": {
      try { return revokeCandidateReview(source, user, input, clock); }
      catch (error) { if (error instanceof CandidateReviewError) throw new BusinessError(error.code, error.message, error.status); throw error; }
    }
    case "anonymizeCandidate": {
      hr();
      const candidate =
        state.candidates.find((c) => c.id === input.candidateId) ??
        fail("NOT_FOUND", "候选人不存在", 404);
      const oldEmail = candidate.email.toLowerCase(),
        oldPhone = phoneKey(candidate.phone);
      const clear = (c: Candidate) =>
        Object.assign(c, {
          name: `匿名候选人 ${c.id.slice(-4)}`,
          email: "",
          phone: "",
          school: "",
          major: "",
          graduationYear: null,
          education: "unknown",
          skills: [],
          resume: "个人信息已清理",
          availability: "",
        });
      clear(candidate);
      delete candidate.review;
      state.reviews = state.reviews?.filter(review => review.candidateId !== candidate.id);
      const appIds = new Set<string>();
      state.applications
        .filter((app) => app.candidateId === candidate.id)
        .forEach((app) => {
          appIds.add(app.id);
          clear(app.snapshot);
          delete app.snapshot.review;
          delete app.selection;
          app.screeningNote = "";
          app.decisionNote = "";
          app.offer.reference = "";
          app.agreement.note = "";
          app.source = "个人信息已清理";
          if (app.status === "closed" && app.outcome !== "录入错误")
            app.outcome = "已关闭（个人信息已清理）";
          event(app, "anonymized", "", "", "候选人个人信息已清理");
        });
      state.events
        .filter((e) => appIds.has(e.applicationId))
        .forEach((e) => {
          e.note = "候选人个人信息已清理";
        });
      const relatedInterviews = state.interviews.filter((i) =>
        appIds.has(i.applicationId),
      );
      relatedInterviews.forEach((i) => {
        i.location = "个人信息已清理";
        delete i.meetingUrl;
        delete i.meetingId;
        delete i.meetingPassword;
      });
      const interviewIds = new Set(relatedInterviews.map((i) => i.id));
      state.scorecards
        .filter((card) => interviewIds.has(card.interviewId))
        .forEach((card) => {
          card.evidence = "";
          card.recommendation = "";
          delete card.assistReport;
        });
      state.imports.forEach((task) =>
        task.rows.forEach((row) => {
          if (
            row.candidateId === candidate.id ||
            (oldEmail && str(row.raw.email).toLowerCase() === oldEmail) ||
            (oldPhone && phoneKey(str(row.raw.phone)) === oldPhone)
          ) {
            row.raw = {};
            row.error =
              row.status === "success" ? "" : "个人信息已清理，请重新导入";
            if (row.status !== "success") row.status = "skipped";
          }
        }),
      );
      break;
    }
    case "reset": {
      hr();
      const fresh = createSeed(clock);
      fresh.revision = source.revision + 1;
      return fresh;
    }
    default:
      try {
        if (!handleSelectionAction(state, user, input, now))
          fail("UNKNOWN_ACTION", "不支持的操作", 400);
      } catch (error) {
        if (error instanceof SelectionError)
          throw new BusinessError(error.code, error.message, error.status);
        throw error;
      }
  }
  state.revision = source.revision + 1;
  return state;
}
