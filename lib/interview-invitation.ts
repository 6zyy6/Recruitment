import type {
  AppState,
  Application,
  Interview,
  InterviewInvitation,
  InterviewInvitationSummary,
  User,
} from "./domain.ts";
import { screeningPolicy } from "./selection.ts";

const TTL = 7 * 86400000;
type Input = Record<string, unknown>;
type Meeting = Interview & {
  meetingUrl?: string;
  meetingId?: string;
  meetingPassword?: string;
};

export class InterviewInvitationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code: string, message: string, status = 422): never => {
  throw new InterviewInvitationError(code, message, status);
};
const str = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function interviewScheduleKey(interview: Meeting): string {
  return JSON.stringify([
    interview.start,
    interview.end,
    interview.round,
    interview.location,
    interview.meetingUrl || "",
    interview.meetingId || "",
    interview.meetingPassword || "",
    [...interview.interviewerIds].sort(),
  ]);
}

function summary(invitation: InterviewInvitation): InterviewInvitationSummary {
  return {
    id: invitation.id,
    to: invitation.to,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    revokedAt: invitation.revokedAt,
    delivery: invitation.delivery,
    deliveryReason: invitation.deliveryReason,
    sentAt: invitation.sentAt,
    providerMessageId: invitation.providerMessageId,
    response: invitation.response,
    respondedAt: invitation.respondedAt,
    responseNote: invitation.responseNote,
    version: invitation.version,
  };
}

function audit(state: AppState, app: Application, actorId: string, type: string, note: string, now: string) {
  app.version++;
  app.updatedAt = now;
  state.events.push({
    id: `event_${crypto.randomUUID()}`,
    applicationId: app.id,
    actorId,
    at: now,
    type,
    from: app.stage,
    to: app.stage,
    note,
  });
  state.revision++;
}

function hrGuard(state: AppState, user: User, input: Input) {
  if (user.role !== "hr" || !state.users.some(item => item.id === user.id && item.role === "hr"))
    fail("FORBIDDEN", "发送面试邀请需要招聘 HR 权限", 403);
  if (input.expectedRevision !== state.revision)
    fail("REVISION_CONFLICT", "数据已更新，请刷新后重试", 409);
}

function invitationContext(state: AppState, user: User, input: Input, clock: Date) {
  hrGuard(state, user, input);
  const interview = state.interviews.find(item => item.id === input.interviewId)
    ?? fail("NOT_FOUND", "面试不存在", 404);
  const app = state.applications.find(item => item.id === interview.applicationId)
    ?? fail("NOT_FOUND", "投递不存在", 404);
  const job = state.jobs.find(item => item.id === app.jobId)
    ?? fail("NOT_FOUND", "职位不存在", 404);
  if (app.status !== "active" || app.stage !== "interview" || interview.status !== "scheduled")
    fail("INVALID_STAGE", "仅有效面试阶段的待进行面试可以发送邀请");
  if (app.selection) {
    const currentPolicy = JSON.stringify(screeningPolicy(job));
    if (app.selection.hrReview?.conclusion !== "pass" ||
      !app.selection.ruleReview?.policy || !app.selection.resumeReview?.policy ||
      JSON.stringify(app.selection.ruleReview.policy) !== currentPolicy ||
      JSON.stringify(app.selection.resumeReview.policy) !== currentPolicy)
      fail("SCREENING_REQUIRED", "请先完成当前岗位规则初筛、简历复筛并由 HR 确认通过");
  } else if (!str(app.screeningNote)) {
    fail("SCREENING_REQUIRED", "请先记录 HR 筛选通过依据");
  }
  const candidate = state.candidates.find(item => item.id === app.candidateId)
    ?? fail("NOT_FOUND", "候选人不存在", 404);
  const to = str(candidate.email);
  if (!to || to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
    fail("INVITATION_EMAIL_REQUIRED", "发送面试邀请前，请填写有效的候选人邮箱");
  const start = Date.parse(interview.start), end = Date.parse(interview.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= clock.getTime() || end <= start || end - start > 8 * 3600000)
    fail("INVALID_SCHEDULE", "请安排未来的有效面试时间，且时长不超过 8 小时");
  if (!str(interview.round) || !str(interview.location))
    fail("INVALID_SCHEDULE", "请补充面试轮次和地点或会议平台");
  if (!interview.interviewerIds.length || interview.interviewerIds.some(id =>
    !state.users.some(item => item.id === id && ["interviewer", "manager"].includes(item.role))))
    fail("INVALID_INTERVIEWER", "请选择有效的面试官");
  if (state.interviews.some(item => item.id !== interview.id && item.status === "scheduled" &&
    Date.parse(item.start) < end && Date.parse(item.end) > start &&
    (item.interviewerIds.some(id => interview.interviewerIds.includes(id)) ||
      state.applications.find(application => application.id === item.applicationId)?.candidateId === app.candidateId)))
    fail("INTERVIEW_CONFLICT", "面试官或候选人的时间发生冲突，请调整后发送", 409);
  return { interview, app, job, to };
}

export function previewInterviewInvitation(state: AppState, user: User, input: Input, clock = new Date()) {
  const { interview, app, job, to } = invitationContext(state, user, input, clock);
  const meeting = interview as Meeting;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "long", timeStyle: "short",
  });
  const lines = [
    `${app.snapshot.name}，您好：`,
    `邀请您参加“${job.title}”岗位的${interview.round}。`,
    `时间：${formatter.format(new Date(interview.start))} 至 ${formatter.format(new Date(interview.end))}（北京时间 UTC+8）`,
    `地点 / 会议平台：${interview.location}`,
    ...(meeting.meetingUrl ? [`会议链接：${meeting.meetingUrl}`] : []),
    ...(meeting.meetingId ? [`会议号：${meeting.meetingId}`] : []),
    ...(meeting.meetingPassword ? [`入会密码：${meeting.meetingPassword}`] : []),
    "候选人答复链接：{{RESPONSE_URL}}（发送时生成专属答复链接）",
    "准备事项：请提前十分钟到场或测试会议设备，并准备与应聘岗位相关的项目经历。",
    "如需其他协助，请回复本邮件联系招聘 HR。",
    "请通过专属链接确认参加，或填写申请改期的原因。申请改期后由 HR 联系您确认新的安排。",
    "链接最长七天有效，并于面试开始时失效。请勿转发此邮件或答复链接。",
  ];
  return {
    to,
    subject: `面试邀请：${job.title} · ${interview.round}`.replace(/[\r\n]+/g, " "),
    text: lines.join("\n"),
  };
}

export function createInterviewInvitation(state: AppState, user: User, input: Input, tokenHash: string, clock = new Date()) {
  const { interview, to } = invitationContext(state, user, input, clock);
  const requestId = str(input.requestId);
  if (requestId.length > 120 || !/^(?:invite_)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))
    fail("INVALID_REQUEST_ID", "请提供有效的邀请请求编号");
  if (state.interviewInvitations?.some(item => item.id === requestId))
    fail("DUPLICATE_REQUEST", "该邀请请求已处理，请刷新查看发送结果", 409);
  if (!/^[a-f0-9]{64}$/.test(tokenHash) || state.interviewInvitations?.some(item => item.tokenHash === tokenHash))
    fail("INVALID_INVITATION_TOKEN", "无法生成安全的面试邀请链接");
  const scheduleKey = interviewScheduleKey(interview);
  if (state.interviewInvitations?.some(item => item.interviewId === interview.id &&
    item.scheduleKey === scheduleKey && item.to.toLowerCase() === to.toLowerCase() &&
    !item.revokedAt && Date.parse(item.expiresAt) > clock.getTime() &&
    ["pending", "sent", "unknown"].includes(item.delivery)))
    fail("INVITATION_EXISTS", "当前排期已有有效邀请，请查看发送结果，避免重复发送", 409);
  const next = structuredClone(state), now = clock.toISOString();
  const current = next.interviews.find(item => item.id === interview.id)!;
  const app = next.applications.find(item => item.id === current.applicationId)!;
  next.interviewInvitations ??= [];
  for (const old of next.interviewInvitations.filter(item => item.interviewId === current.id && !item.revokedAt)) {
    old.revokedAt = now;
    old.version++;
  }
  const invitation: InterviewInvitation = {
    id: requestId,
    interviewId: current.id,
    createdBy: user.id,
    tokenHash,
    scheduleKey,
    to,
    createdAt: now,
    expiresAt: new Date(Math.min(clock.getTime() + TTL, Date.parse(current.start))).toISOString(),
    revokedAt: "",
    delivery: "pending",
    deliveryReason: "邀请已创建，等待邮件服务发送。",
    response: "pending",
    respondedAt: "",
    responseNote: "",
    version: 0,
  };
  next.interviewInvitations.push(invitation);
  current.invitation = summary(invitation);
  current.notified = false;
  audit(next, app, user.id, "interview_invitation_created", "生成面试邀请，待邮件服务确认发送结果；旧答复链接已撤销。", now);
  return { state: next, invitation: summary(invitation) };
}

export function revokeInterviewInvitation(state: AppState, user: User, input: Input, clock = new Date()): AppState {
  hrGuard(state, user, input);
  const interview = state.interviews.find(item => item.id === input.interviewId)
    ?? fail("NOT_FOUND", "面试不存在", 404);
  const invitation = state.interviewInvitations?.find(item => item.id === interview.invitation?.id && item.interviewId === interview.id)
    ?? fail("NOT_FOUND", "该面试没有可撤销的邀请", 404);
  if (invitation.revokedAt) return structuredClone(state);
  const next = structuredClone(state), now = clock.toISOString();
  const current = next.interviews.find(item => item.id === interview.id)!;
  const record = next.interviewInvitations!.find(item => item.id === invitation.id)!;
  const app = next.applications.find(item => item.id === current.applicationId)
    ?? fail("NOT_FOUND", "投递不存在", 404);
  record.revokedAt = now;
  record.version++;
  current.invitation = summary(record);
  current.notified = false;
  audit(next, app, user.id, "interview_invitation_revoked", "HR 已撤销面试邀请的答复链接。重发前请先核查 Gmail 的实际发送结果。", now);
  return next;
}

function currentInvitation(state: AppState, tokenHash: string, clock: Date) {
  const invitation = state.interviewInvitations?.find(item => item.tokenHash === tokenHash)
    ?? fail("INVITATION_GONE", "面试邀请链接已失效，请联系招聘 HR", 410);
  const interview = state.interviews.find(item => item.id === invitation.interviewId)
    ?? fail("INVITATION_GONE", "面试邀请链接已失效，请联系招聘 HR", 410);
  const app = state.applications.find(item => item.id === interview.applicationId)
    ?? fail("INVITATION_GONE", "面试邀请链接已失效，请联系招聘 HR", 410);
  const candidate = state.candidates.find(item => item.id === app.candidateId);
  if (invitation.revokedAt || invitation.delivery === "failed" ||
    !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) <= clock.getTime() ||
    Date.parse(interview.start) <= clock.getTime() || interview.status !== "scheduled" ||
    invitation.scheduleKey !== interviewScheduleKey(interview) ||
    app.status !== "active" || app.stage !== "interview" || !state.jobs.some(item => item.id === app.jobId) ||
    !candidate || str(candidate.email).toLowerCase() !== invitation.to.toLowerCase())
    fail("INVITATION_GONE", "面试邀请链接已失效，请联系招聘 HR", 410);
  return { invitation, interview, app };
}

export function readInterviewInvitation(state: AppState, tokenHash: string, clock = new Date()) {
  const { invitation, interview, app } = currentInvitation(state, tokenHash, clock);
  const job = state.jobs.find(item => item.id === app.jobId)
    ?? fail("INVITATION_GONE", "面试邀请链接已失效，请联系招聘 HR", 410);
  const meeting = interview as Meeting;
  return {
    invitation: {
      id: invitation.id,
      version: invitation.version,
      response: invitation.response,
      respondedAt: invitation.respondedAt,
      responseNote: invitation.responseNote,
      expiresAt: invitation.expiresAt,
    },
    interview: {
      round: interview.round,
      start: interview.start,
      end: interview.end,
      location: interview.location,
      ...(meeting.meetingUrl ? { meetingUrl: meeting.meetingUrl } : {}),
      ...(meeting.meetingId ? { meetingId: meeting.meetingId } : {}),
      ...(meeting.meetingPassword ? { meetingPassword: meeting.meetingPassword } : {}),
    },
    candidateName: app.snapshot.name,
    jobTitle: job.title,
  };
}

export function submitInterviewInvitation(state: AppState, tokenHash: string, input: Input, clock = new Date()): AppState {
  const { invitation } = currentInvitation(state, tokenHash, clock);
  if (invitation.response !== "pending")
    fail("INVITATION_LOCKED", "答复已提交并锁定，如需更改请联系招聘 HR", 409);
  if (input.expectedVersion !== invitation.version)
    fail("VERSION_CONFLICT", "邀请内容已更新，请刷新后重试", 409);
  if (input.response !== "confirmed" && input.response !== "reschedule_requested")
    fail("INVALID_RESPONSE", "请选择确认参加或申请改期");
  const note = str(input.responseNote ?? input.note);
  if (note.length > 1000 || (input.response === "reschedule_requested" && note.length < 5))
    fail("INVALID_RESPONSE_NOTE", "申请改期请填写 5–1000 字符的原因");
  const next = structuredClone(state), now = clock.toISOString();
  const current = currentInvitation(next, tokenHash, clock);
  Object.assign(current.invitation, {
    response: input.response,
    responseNote: note,
    respondedAt: now,
    version: current.invitation.version + 1,
  });
  current.interview.invitation = summary(current.invitation);
  audit(next, current.app, "candidate", "interview_invitation_response", input.response === "confirmed"
    ? "候选人确认参加面试。" : "候选人申请改期；排期仍待 HR 确认调整。", now);
  return next;
}

export function recordInterviewInvitationDelivery(
  state: AppState,
  id: string,
  result: { status: "sent" | "failed" | "unknown" | "sending"; reason: string; messageId?: string; sentAt?: string },
  clock = new Date(),
): AppState {
  const record = state.interviewInvitations?.find(item => item.id === id)
    ?? fail("NOT_FOUND", "面试邀请不存在", 404);
  if (!["sent", "failed", "unknown", "sending"].includes(result.status))
    fail("INVALID_DELIVERY", "邮件发送结果无效");
  if (result.sentAt && !Number.isFinite(Date.parse(result.sentAt)))
    fail("INVALID_DELIVERY", "邮件发送时间无效");
  // A delayed timeout must never turn a confirmed delivery into a failure.
  if (record.delivery === "sent") return state;
  const delivery = result.status === "sending" ? "pending" : result.status;
  const reason = str(result.reason).slice(0, 1000);
  const messageId = result.messageId ? str(result.messageId).slice(0, 254) : record.providerMessageId;
  if (record.delivery === delivery && record.deliveryReason === reason && record.providerMessageId === messageId)
    return state;
  const next = structuredClone(state), now = clock.toISOString();
  const invitation = next.interviewInvitations!.find(item => item.id === id)!;
  invitation.delivery = delivery;
  invitation.deliveryReason = reason;
  if (messageId) invitation.providerMessageId = messageId;
  if (result.status === "sent") invitation.sentAt = result.sentAt || now;
  const interview = next.interviews.find(item => item.id === invitation.interviewId);
  if (interview && interview.invitation?.id === id && !invitation.revokedAt && invitation.scheduleKey === interviewScheduleKey(interview)) {
    interview.invitation = summary(invitation);
    if (result.status === "sent") interview.notified = true;
  }
  const app = next.applications.find(item => item.id === interview?.applicationId);
  if (app) audit(next, app, "system", "interview_invitation_delivery", `面试邀请邮件发送结果：${result.status}。${invitation.deliveryReason}`, now);
  else next.revision++;
  return next;
}
