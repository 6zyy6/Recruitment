import type {
  AppState,
  Application,
  Candidate,
  CandidateReview,
  CandidateReviewFields,
  CandidateReviewSummary,
  User,
} from "./domain.ts";

const TTL = 7 * 24 * 60 * 60 * 1000;
export const CANDIDATE_REVIEW_DEMO_NOTICE =
  "当前为私有 Demo 的资料核对预览，仅站点所有者可访问。真实外部候选人需要独立开放的核对入口。";
export class CandidateReviewError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code: string, message: string, status = 422): never => {
  throw new CandidateReviewError(code, message, status);
};
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const phoneKey = (value: string) => value.replace(/[\s()+-]/g, "");

export async function hashReviewToken(token: string): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function newReviewToken() {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { token, tokenHash: await hashReviewToken(token) };
}
export function candidateReviewFields(
  candidate: Candidate,
): CandidateReviewFields {
  return {
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    school: candidate.school,
    education: candidate.education || "unknown",
    major: candidate.major,
    graduationYear: candidate.graduationYear,
    skills: [...candidate.skills],
    availability: candidate.availability,
  };
}
function summary(review: CandidateReview): CandidateReviewSummary {
  return {
    reviewId: review.id,
    applicationId: review.applicationId,
    status: review.status,
    version: review.version,
    createdAt: review.createdAt,
    expiresAt: review.expiresAt,
    submittedAt: review.submittedAt,
    revokedAt: review.revokedAt,
    delivery: review.delivery,
  };
}
function hrGuard(state: AppState, user: User, input: Record<string, unknown>) {
  if (
    user.role !== "hr" ||
    !state.users.some((item) => item.id === user.id && item.role === "hr")
  )
    fail("FORBIDDEN", "生成或撤销资料核对邀请需要招聘 HR 权限", 403);
  if (input.expectedRevision !== state.revision)
    fail("REVISION_CONFLICT", "数据已更新，请刷新后重试", 409);
}
function application(state: AppState, applicationId: unknown) {
  return (
    state.applications.find((item) => item.id === applicationId) ??
    fail("NOT_FOUND", "投递不存在", 404)
  );
}
function isEditable(app: Application) {
  return (
    app.status === "active" &&
    ["new", "screening", "interview"].includes(app.stage)
  );
}
function requireEditable(app: Application) {
  if (!isEditable(app))
    fail(
      "REVIEW_GONE",
      "该投递已结束或进入 Offer 环节，资料核对入口已关闭",
      410,
    );
}
function audit(
  state: AppState,
  app: Application,
  actorId: string,
  type: string,
  note: string,
  now: string,
) {
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
}
function setSummary(
  state: AppState,
  app: Application,
  review: CandidateReview,
) {
  app.snapshot.review = summary(review);
  const person = state.candidates.find(
    (item) => item.id === review.candidateId,
  );
  if (person) person.review = summary(review);
}
function pendingReview(state: AppState, tokenHash: string, clock: Date) {
  const review =
    state.reviews?.find((item) => item.tokenHash === tokenHash) ??
    fail(
      "REVIEW_GONE",
      "资料核对链接无效或已关闭，请联系招聘人员重新生成",
      410,
    );
  if (review.status === "submitted")
    fail(
      "REVIEW_GONE",
      "资料已确认提交，当前链接已锁定；如需修改请联系招聘人员",
      410,
    );
  if (review.status !== "pending")
    fail("REVIEW_GONE", "资料核对邀请已撤销或失效，请联系招聘人员", 410);
  if (Date.parse(review.expiresAt) <= clock.getTime())
    fail(
      "REVIEW_GONE",
      "资料核对邀请已超过七天有效期，请联系招聘人员重新生成",
      410,
    );
  const app = application(state, review.applicationId);
  requireEditable(app);
  const person =
    state.candidates.find((item) => item.id === review.candidateId) ??
    fail("REVIEW_GONE", "候选人档案已移除", 410);
  if (
    JSON.stringify(candidateReviewFields(app.snapshot)) !==
      JSON.stringify(review.fields) ||
    JSON.stringify(candidateReviewFields(person)) !==
      JSON.stringify(review.candidateAtIssue)
  )
    fail(
      "REVIEW_DATA_CHANGED",
      "招聘人员已更新资料，请联系招聘人员重发核对邀请",
      409,
    );
  return { review, app };
}

export function createCandidateReview(
  state: AppState,
  user: User,
  input: Record<string, unknown>,
  tokenHash: string,
  clock = new Date(),
) {
  hrGuard(state, user, input);
  if (!/^[a-f0-9]{64}$/.test(tokenHash))
    fail("INVALID_REVIEW_TOKEN", "无法生成安全核对邀请");
  const next = structuredClone(state),
    app = application(next, input.applicationId),
    now = clock.toISOString();
  requireEditable(app);
  if (
    !app.snapshot.email ||
    app.snapshot.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(app.snapshot.email)
  )
    fail(
      "REVIEW_EMAIL_REQUIRED",
      "生成资料核对邀请前，请先填写有效的候选人邮箱",
    );
  const person =
    next.candidates.find((item) => item.id === app.candidateId) ??
    fail("NOT_FOUND", "候选人不存在", 404);
  next.reviews ??= [];
  next.reviews
    .filter(
      (item) => item.applicationId === app.id && item.status === "pending",
    )
    .forEach((item) => {
      item.status = "revoked";
      item.revokedAt = now;
      item.version++;
    });
  const id = `review_${crypto.randomUUID()}`;
  const review: CandidateReview = {
    id,
    reviewId: id,
    applicationId: app.id,
    candidateId: person.id,
    createdBy: user.id,
    tokenHash,
    status: "pending",
    version: 0,
    createdAt: now,
    expiresAt: new Date(clock.getTime() + TTL).toISOString(),
    submittedAt: "",
    revokedAt: "",
    delivery: "preview",
    deliveryReason: `${CANDIDATE_REVIEW_DEMO_NOTICE}系统仅生成邮件预览，未发送邮件。`,
    fields: candidateReviewFields(app.snapshot),
    candidateAtIssue: candidateReviewFields(person),
  };
  next.reviews.push(review);
  setSummary(next, app, review);
  audit(
    next,
    app,
    user.id,
    "candidate_review_created",
    "生成七天资料核对邀请与邮件预览；未发送真实邮件。重发会撤销旧链接。",
    now,
  );
  next.revision++;
  return { state: next, review: summary(review) };
}

export function revokeCandidateReview(
  state: AppState,
  user: User,
  input: Record<string, unknown>,
  clock = new Date(),
): AppState {
  hrGuard(state, user, input);
  const next = structuredClone(state),
    app = application(next, input.applicationId),
    now = clock.toISOString();
  const pending =
    next.reviews?.filter(
      (item) => item.applicationId === app.id && item.status === "pending",
    ) ?? [];
  if (!pending.length) fail("REVIEW_NOT_PENDING", "该投递没有待核对邀请");
  pending.forEach((item) => {
    item.status = "revoked";
    item.revokedAt = now;
    item.version++;
  });
  setSummary(next, app, pending.at(-1)!);
  audit(
    next,
    app,
    user.id,
    "candidate_review_revoked",
    "HR 已撤销资料核对邀请，旧链接不可再提交。",
    now,
  );
  next.revision++;
  return next;
}

export function readCandidateReview(
  state: AppState,
  tokenHash: string,
  clock = new Date(),
) {
  const { review, app } = pendingReview(state, tokenHash, clock);
  const job =
    state.jobs.find((item) => item.id === app.jobId) ??
    fail("NOT_FOUND", "职位不存在", 404);
  return {
    review: {
      id: review.id,
      status: review.status,
      version: review.version,
      expiresAt: review.expiresAt,
    },
    job: { title: job.title, type: job.type },
    fields: structuredClone(review.fields),
    demoNotice: CANDIDATE_REVIEW_DEMO_NOTICE,
    canSubmit: true,
  };
}

function submittedFields(value: unknown): CandidateReviewFields {
  if (!value || Array.isArray(value) || typeof value !== "object")
    fail("INVALID_REVIEW_FIELDS", "请完整填写待核对资料");
  const data = value as Record<string, unknown>;
  const allowed = [
    "name",
    "email",
    "phone",
    "school",
    "education",
    "major",
    "graduationYear",
    "skills",
    "availability",
  ];
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    fail("INVALID_REVIEW_FIELDS", "只允许修改核对表单中的资料字段");
  const field = (key: string, max: number) => {
    if (typeof data[key] !== "string" || str(data[key]).length > max)
      fail("INVALID_REVIEW_FIELDS", `${key} 未填写或超过长度限制`);
    return str(data[key]);
  };
  const name = field("name", 80),
    email = field("email", 254).toLowerCase(),
    phone = field("phone", 32);
  if (!name) fail("REQUIRED", "请填写姓名");
  if (!email && !phone) fail("CONTACT_REQUIRED", "邮箱和手机至少填写一项");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail("INVALID_EMAIL", "邮箱格式不正确");
  if (phone && !/^\+?[\d\s()-]{7,22}$/.test(phone))
    fail("INVALID_PHONE", "手机格式不正确");
  const education = field("education", 20);
  if (
    !["unknown", "college", "bachelor", "master", "doctor"].includes(education)
  )
    fail("INVALID_EDUCATION", "请选择有效学历或未知");
  if (
    data.graduationYear !== null &&
    (!Number.isInteger(data.graduationYear) ||
      Number(data.graduationYear) < 1960 ||
      Number(data.graduationYear) > 2100)
  )
    fail("INVALID_YEAR", "毕业年份应为 1960–2100 的整数或未知");
  if (
    !Array.isArray(data.skills) ||
    data.skills.length > 30 ||
    data.skills.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 60,
    )
  )
    fail("INVALID_SKILLS", "技能最多 30 项，每项 1–60 字符");
  return {
    name,
    email,
    phone,
    education,
    school: field("school", 120),
    major: field("major", 120),
    graduationYear: data.graduationYear as number | null,
    skills: [...new Set((data.skills as string[]).map((item) => item.trim()))],
    availability: field("availability", 240),
  };
}

export function submitCandidateReview(
  state: AppState,
  tokenHash: string,
  input: Record<string, unknown>,
  clock = new Date(),
): AppState {
  const { review: current } = pendingReview(state, tokenHash, clock);
  if (input.expectedVersion !== current.version)
    fail("REVIEW_VERSION_CONFLICT", "核对表已更新，请刷新后重试", 409);
  if (input.confirmed !== true)
    fail("CONFIRMATION_REQUIRED", "请明确确认以上资料准确并同意提交");
  const fields = submittedFields(input.fields);
  const person =
    state.candidates.find((item) => item.id === current.candidateId) ??
    fail("REVIEW_GONE", "候选人档案已移除", 410);
  if (
    state.candidates.some(
      (item) =>
        item.id !== person.id &&
        ((fields.email && item.email.toLowerCase() === fields.email) ||
          (fields.phone && phoneKey(item.phone) === phoneKey(fields.phone))),
    )
  )
    fail("CONTACT_CONFLICT", "联系方式与已有档案冲突，请联系招聘人员核实", 409);
  const next = structuredClone(state),
    app = application(next, current.applicationId),
    review = next.reviews!.find((item) => item.id === current.id)!,
    now = clock.toISOString();
  const changed =
    JSON.stringify({ ...current.fields, ...fields }) !==
    JSON.stringify(current.fields);
  if (changed) {
    Object.assign(
      next.candidates.find((item) => item.id === current.candidateId)!,
      fields,
    );
    Object.assign(app.snapshot, fields);
    if (app.selection) {
      delete app.selection.ruleReview;
      delete app.selection.resumeReview;
      delete app.selection.hrReview;
    }
    app.decision = "pending";
    app.decisionNote = "";
  }
  review.status = "submitted";
  review.submittedAt = now;
  review.submittedFields = fields;
  review.version++;
  setSummary(next, app, review);
  audit(
    next,
    app,
    "candidate",
    "candidate_review_submitted",
    changed
      ? "候选人已明确确认并提交核对资料；更正本投递及主档，旧筛选报告及录用结论失效，待 HR 人工复核并重新录用确认；其它投递快照保持不变。"
      : "候选人已原样确认并提交核对资料；未更改资料，保留现有筛选报告、录用结论及备注。",
    now,
  );
  next.revision++;
  return next;
}
