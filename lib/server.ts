import { env } from "cloudflare:workers";
import type { AppState, User } from "./domain.ts";
import { applyAction, BusinessError, projectState } from "./engine.ts";
import { createSeed, DEMO_USERS } from "./seed.ts";
import { publicJobs, submitCareerApplication } from "./careers.ts";
import {
  CandidateReviewError,
  candidateReviewSummary,
  CANDIDATE_REVIEW_DEMO_NOTICE,
  createCandidateReview,
  hashReviewToken,
  newReviewToken,
  readCandidateReview,
  recordCandidateReviewDelivery,
  submitCandidateReview,
  type ReviewMailResult,
} from "./candidate-review.ts";
import {
  OperatorError,
  requireMailOperator,
  requireRecruitmentOperator,
} from "./operator.ts";
import {
  gmailStatus,
  sendReviewEmail,
  readReviewEmailDelivery,
} from "./gmail-server.ts";
import { GmailError } from "./gmail.ts";
import { generateResumeReview, ResumeAIError } from "./resume-ai.ts";
import {
  attachResumeReview,
  queueResumeReview,
  resumeReviewInput,
} from "./resume-workflow.ts";
import { hasLegacyScreeningApproval, screeningPolicy } from "./selection.ts";
import {
  InterviewInvitationError,
  previewInterviewInvitation,
  createInterviewInvitation,
  readInterviewInvitation,
  submitInterviewInvitation,
  recordInterviewInvitationDelivery,
  revokeInterviewInvitation,
} from "./interview-invitation.ts";

const mailEnvironment = env as unknown as {
  MAIL_MODE?: string;
  MAIL_OPERATOR_EMAIL?: string;
  MAIL_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
};
const LIVE_REVIEW_NOTICE =
  "核对链接仅开放本次投递的资料，有效期七天，请勿转发。请核对并提交真实准确的信息。";

const COOKIE = "recruitment_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
// Public demo password is verified by a digest; neither sessions nor the state store hold plaintext passwords.
const DEMO_PASSWORD_HASH =
  "9aa06636a970197980fd91eb654ce6a7362be5a3ca6968c309702a9a04afb2b1";
function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding)
    throw new BusinessError(
      "DATABASE_UNAVAILABLE",
      "数据库尚未连接，请检查 D1 绑定",
      503,
    );
  return binding;
}
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function tokenFrom(request: Request): string {
  const cookies = request.headers.get("cookie") || "";
  return (
    cookies
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || ""
  );
}
function cookieHeader(request: Request, token: string, clear = false): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new BusinessError(
      "INVALID_ORIGIN",
      "请求来源不匹配，请从系统页面重新操作",
      403,
    );
}
export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let bytes = 0;
  const bounded = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 6 * 1024 * 1024)
          throw new BusinessError(
            "REQUEST_TOO_LARGE",
            "请求内容超过 6 MiB，请缩小后重试",
            413,
          );
        controller.enqueue(chunk);
      },
    }),
  );
  const text = await new Response(bounded).text();
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new BusinessError(
      "INVALID_JSON",
      "请求内容必须为有效 JSON 对象",
      400,
    );
  }
}
export async function loadState(): Promise<AppState> {
  const db = database();
  const get = () =>
    db
      .prepare("SELECT revision, payload FROM recruitment_state WHERE id = ?")
      .bind("main")
      .first<{ revision: number; payload: string }>();
  let row = await get();
  if (!row) {
    const initial = createSeed();
    await db
      .prepare(
        "INSERT OR IGNORE INTO recruitment_state (id, revision, payload) VALUES (?, ?, ?)",
      )
      .bind("main", initial.revision, JSON.stringify(initial))
      .run();
    row = await get();
  }
  if (!row)
    throw new BusinessError(
      "DATABASE_UNAVAILABLE",
      "初始化演示数据失败，请刷新后重试",
      503,
    );
  const state = JSON.parse(row.payload) as AppState;
  state.revision = row.revision;
  return state;
}
export async function getUser(
  request: Request,
  required = false,
): Promise<User | null> {
  requireRecruitmentOperator(request, mailEnvironment);
  const token = tokenFrom(request);
  let user: User | null = null;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const session = await database()
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .bind(await hash(token))
      .first<{ user_id: string; expires_at: number }>();
    if (session && session.expires_at > Date.now())
      user =
        DEMO_USERS.find((account) => account.id === session.user_id) || null;
  }
  if (required && !user)
    throw new BusinessError("UNAUTHORIZED", "请先登录演示账号", 401);
  return user;
}
export async function login(request: Request, body: Record<string, unknown>) {
  checkOrigin(request);
  requireRecruitmentOperator(request, mailEnvironment);
  const user = DEMO_USERS.find((account) => account.id === body.userId);
  const password = typeof body.password === "string" ? body.password : "";
  if (
    !user ||
    (await hash(`recruitment-demo-v1:${password}`)) !== DEMO_PASSWORD_HASH
  )
    throw new BusinessError("INVALID_CREDENTIALS", "账号或演示密码不正确", 401);
  const db = database(),
    oldToken = tokenFrom(request);
  if (oldToken)
    await db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hash(oldToken))
      .run();
  await db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .bind(Date.now())
    .run();
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(await hash(token), user.id, Date.now() + SESSION_MS)
    .run();
  return Response.json(
    { user, users: DEMO_USERS },
    {
      headers: {
        "set-cookie": cookieHeader(request, token),
        "cache-control": "no-store",
      },
    },
  );
}
export async function logout(request: Request) {
  checkOrigin(request);
  const token = tokenFrom(request);
  if (token)
    await database()
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hash(token))
      .run();
  return Response.json(
    { user: null, users: DEMO_USERS },
    {
      headers: {
        "set-cookie": cookieHeader(request, "", true),
        "cache-control": "no-store",
      },
    },
  );
}
export async function recruitmentSnapshot(request: Request) {
  const user = (await getUser(request, true))!;
  const state = await reconcileInterviewDeliveries(
    await reconcileReviewDeliveries(await loadState()),
  );
  return Response.json(
    { user, state: projectState(state, user) },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function recruitmentAction(
  request: Request,
  input: Record<string, unknown>,
) {
  checkOrigin(request);
  const user = (await getUser(request, true))!,
    current = await loadState();
  const next = applyAction(current, user, input);
  const reviewIds = next.applications
    .filter((app) => {
      if (
        app.status !== "active" ||
        !["new", "screening", "interview"].includes(app.stage) ||
        app.source === "个人信息已清理" ||
        app.snapshot.resume === "个人信息已清理"
      )
        return false;
      const created = !current.applications.some(
        (previous) => previous.id === app.id,
      );
      const requested =
        [
          "run_screening",
          "review_resume",
          "verify_screening_info",
          "ensure_resume_review",
        ].includes(String(input.action)) && app.id === input.applicationId;
      if (!created && !requested) return false;
      const job = next.jobs.find((item) => item.id === app.jobId)!;
      if (
        input.action === "ensure_resume_review" &&
        (hasLegacyScreeningApproval(next, app) ||
          (app.selection?.resumeReview?.mode === "llm" &&
            JSON.stringify(app.selection.resumeReview.policy) ===
              JSON.stringify(screeningPolicy(job))))
      )
        return false;
      queueResumeReview(app, job, new Date().toISOString());
      return app.selection?.aiReview?.status === "pending";
    })
    .map((app) => app.id);
  await saveState(current, next);
  // A single upload returns its completed report; batch imports stay queued and
  // generate the selected application when HR opens its details.
  const finalState =
    reviewIds.length === 1
      ? await finishResumeReview(next, reviewIds[0], user.id)
      : next;
  return Response.json(
    { user, state: projectState(finalState, user) },
    { headers: { "cache-control": "no-store" } },
  );
}
async function finishResumeReview(
  state: AppState,
  applicationId: string,
  actorId: string,
): Promise<AppState> {
  const app = state.applications.find((item) => item.id === applicationId)!;
  const job = state.jobs.find((item) => item.id === app.jobId)!;
  const fingerprint = resumeReviewInput(app, job);
  const requestedAt = app.selection!.aiReview!.updatedAt;
  let result;
  try {
    result = await generateResumeReview(
      job,
      app.snapshot,
      env as unknown as { DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL?: string },
      new Date().toISOString(),
    );
  } catch (error) {
    result = {
      message:
        error instanceof ResumeAIError
          ? error.message
          : "AI 复筛暂未完成，请稍后重试。",
    };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadState();
    const next = attachResumeReview(
      current,
      applicationId,
      fingerprint,
      requestedAt,
      result,
      actorId,
      new Date().toISOString(),
    );
    if (!next) return current;
    try {
      await saveState(current, next);
      return next;
    } catch (error) {
      if (
        !(error instanceof BusinessError && error.code === "REVISION_CONFLICT")
      )
        throw error;
    }
  }
  return loadState();
}
async function saveState(current: AppState, next: AppState) {
  const payload = JSON.stringify(next);
  if (new TextEncoder().encode(payload).length > 1900000)
    throw new BusinessError(
      "DEMO_STORAGE_LIMIT",
      "演示库数据已接近容量限制，请缩小导入内容或恢复演示数据",
      413,
    );
  // Compare-and-swap ensures two requests with the same revision cannot both write.
  const result = await database()
    .prepare(
      "UPDATE recruitment_state SET revision = ?, payload = ? WHERE id = ? AND revision = ?",
    )
    .bind(next.revision, payload, "main", current.revision)
    .run();
  if (result.meta.changes !== 1)
    throw new BusinessError(
      "REVISION_CONFLICT",
      "数据已被其他操作更新，请刷新后重试",
      409,
    );
}
const careersHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
export async function careersSnapshot() {
  return Response.json({ jobs: publicJobs(await loadState()) }, { headers: careersHeaders });
}
export async function careersAction(request: Request, input: Record<string, unknown>) {
  checkOrigin(request);
  // Recompute after a competing write so duplicates and job availability use the winning state.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadState();
    const result = await submitCareerApplication(current, input);
    try {
      if (!result.replayed) await saveState(current, result.state);
      return Response.json({ receipt: result.receipt }, { headers: careersHeaders });
    } catch (error) {
      if (!(error instanceof BusinessError) || error.code !== "REVISION_CONFLICT" || attempt === 2) throw error;
    }
  }
  throw new BusinessError("REVISION_CONFLICT", "提交较多，请稍后重试", 409);
}
const reviewHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
async function saveReviewDelivery(
  reviewId: string,
  result: ReviewMailResult,
): Promise<AppState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadState();
    if (!current.reviews?.some((item) => item.id === reviewId)) return current;
    const next = recordCandidateReviewDelivery(current, reviewId, result);
    if (next === current) return current;
    try {
      await saveState(current, next);
      return next;
    } catch (error) {
      if (
        !(error instanceof BusinessError && error.code === "REVISION_CONFLICT")
      )
        throw error;
    }
  }
  return loadState();
}
async function reconcileReviewDeliveries(state: AppState): Promise<AppState> {
  if (mailEnvironment.MAIL_MODE !== "live") return state;
  let current = state;
  for (const review of state.reviews?.filter(
    (item) => item.delivery === "pending" || item.delivery === "unknown",
  ) ?? []) {
    const result = await readReviewEmailDelivery(review.id);
    if (
      !result &&
      review.delivery === "pending" &&
      Date.parse(review.createdAt) <= Date.now() - 120_000
    )
      current = await saveReviewDelivery(review.id, {
        status: "unknown",
        reason:
          "发送过程已中断且尚无可确认的回执，请先核查 Gmail 已发送邮件，不要重复发送。",
      });
    else if (result && result.status !== "sending")
      current = await saveReviewDelivery(review.id, result);
  }
  return current;
}
function reviewToken(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new CandidateReviewError(
      "REVIEW_GONE",
      "资料核对链接无效或已关闭，请联系招聘人员",
      410,
    );
  return value;
}
export async function candidateReviewSnapshot(request: Request) {
  const token = reviewToken(new URL(request.url).searchParams.get("token"));
  const view = readCandidateReview(
    await loadState(),
    await hashReviewToken(token),
  );
  return Response.json(
    {
      ...view,
      demoNotice:
        mailEnvironment.MAIL_MODE === "live"
          ? LIVE_REVIEW_NOTICE
          : view.demoNotice,
    },
    { headers: reviewHeaders },
  );
}
export async function candidateReviewAction(
  request: Request,
  input: Record<string, unknown>,
) {
  checkOrigin(request);
  if (
    input.action === "createCandidateReview" ||
    input.action === "revokeCandidateReview"
  ) {
    const user = (await getUser(request, true))!,
      current = await loadState();
    if (input.action === "revokeCandidateReview") {
      const next = applyAction(current, user, input);
      await saveState(current, next);
      return Response.json(
        { snapshot: { user, state: projectState(next, user) } },
        { headers: reviewHeaders },
      );
    }
    if (input.sendEmail === true) {
      requireMailOperator(request, mailEnvironment);
      if (mailEnvironment.MAIL_MODE !== "live")
        throw new BusinessError(
          "GMAIL_NOT_CONFIGURED",
          "真实发信尚未启用，请先完成 Gmail 配置与授权。",
          503,
        );
      const status = await gmailStatus(request);
      if (!status.configured || !status.connected)
        throw new BusinessError(
          "GMAIL_NOT_CONNECTED",
          "尚未连接 Gmail，请先完成发信邮箱授权。",
          503,
        );
    }
    const base = mailEnvironment.MAIL_BASE_URL || request.url;
    const reviewUrl = new URL("/candidate-review", base);
    if (
      input.sendEmail === true &&
      (!mailEnvironment.MAIL_BASE_URL || reviewUrl.protocol !== "https:")
    )
      throw new BusinessError(
        "GMAIL_NOT_CONFIGURED",
        "尚未配置公开核对地址，请先完成发信配置。",
        503,
      );
    const { token, tokenHash } = await newReviewToken();
    const created = createCandidateReview(current, user, input, tokenHash);
    await saveState(current, created.state);
    const app = created.state.applications.find(
      (item) => item.id === input.applicationId,
    )!;
    const title = created.state.jobs.find(
      (item) => item.id === app.jobId,
    )!.title;
    reviewUrl.searchParams.set("token", token);
    const expiresLabel = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "long",
      timeStyle: "short",
    }).format(new Date(created.review.expiresAt));
    const mailPreview = {
      to: app.snapshot.email,
      subject: `请核对您的招聘资料：${title}`,
      text: `${app.snapshot.name}，您好：\n我们已根据您的简历整理了“${title}”岗位的应聘资料，请核对并补充需要更正的内容：\n${reviewUrl.href}\n有效期至 ${expiresLabel}（北京时间）。\n提交后招聘人员会继续核实和跟进，本次资料确认不会自动改变招聘结果。\n${input.sendEmail === true ? LIVE_REVIEW_NOTICE : CANDIDATE_REVIEW_DEMO_NOTICE}\n请勿转发此链接。`,
      status: "preview",
      reason: `${CANDIDATE_REVIEW_DEMO_NOTICE}系统仅生成邮件预览，未发送邮件。`,
    };
    let finalState = created.state;
    let mailDelivery: ReviewMailResult | { status: "preview"; reason: string } =
      { status: "preview", reason: mailPreview.reason };
    if (input.sendEmail === true) {
      try {
        mailDelivery = await sendReviewEmail(request, {
          id: created.review.reviewId,
          to: mailPreview.to,
          subject: mailPreview.subject,
          text: mailPreview.text,
        });
      } catch {
        mailDelivery = {
          status: "unknown",
          reason:
            "发送结果暂无法确认，请先核查 Gmail 已发送邮件，不要重复发送。",
        };
      }
      // Gmail receipt is durable in mail_jobs even if this JSON-state CAS conflicts.
      try {
        finalState = await saveReviewDelivery(
          created.review.reviewId,
          mailDelivery,
        );
      } catch {
        finalState = await loadState();
      }
    }
    const deliveryReview = finalState.reviews?.find(
      (item) => item.id === created.review.reviewId,
    );
    const finalReview = deliveryReview
      ? candidateReviewSummary(deliveryReview)
      : created.review;
    return Response.json(
      {
        reviewUrl: reviewUrl.href,
        review: { ...finalReview, id: created.review.reviewId },
        mailPreview,
        mailDelivery,
        snapshot: { user, state: projectState(finalState, user) },
      },
      { headers: reviewHeaders },
    );
  }
  const token = reviewToken(input.token),
    current = await loadState(),
    tokenHash = await hashReviewToken(token);
  const next = submitCandidateReview(current, tokenHash, input);
  await saveState(current, next);
  const review = next.reviews!.find((item) => item.tokenHash === tokenHash)!;
  return Response.json(
    {
      review: {
        id: review.id,
        status: review.status,
        version: review.version,
        submittedAt: review.submittedAt,
      },
      message:
        "资料已确认提交并锁定，招聘 HR 将继续人工复核；本操作不会自动推进招聘阶段。",
    },
    { headers: reviewHeaders },
  );
}
async function saveInterviewDelivery(
  invitationId: string,
  result: Parameters<typeof recordInterviewInvitationDelivery>[2],
): Promise<AppState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadState();
    const next = recordInterviewInvitationDelivery(
      current,
      invitationId,
      result,
    );
    if (next === current) return current;
    try {
      await saveState(current, next);
      return next;
    } catch (error) {
      if (
        !(error instanceof BusinessError && error.code === "REVISION_CONFLICT")
      )
        throw error;
    }
  }
  throw new BusinessError(
    "REVISION_CONFLICT",
    "发送记录正在同步，请刷新核实",
    409,
  );
}
async function reconcileInterviewDeliveries(
  state: AppState,
): Promise<AppState> {
  if (mailEnvironment.MAIL_MODE !== "live") return state;
  let current = state;
  for (const invitation of state.interviewInvitations?.filter(
    (item) => item.delivery === "pending" || item.delivery === "unknown",
  ) ?? []) {
    const result = await readReviewEmailDelivery(invitation.id);
    if (result && result.status !== "sending")
      current = await saveInterviewDelivery(invitation.id, result);
  }
  return current;
}
export async function interviewInvitationAction(
  request: Request,
  input: Record<string, unknown>,
) {
  checkOrigin(request);
  const user = (await getUser(request, true))!;
  const current = await loadState();
  if (input.action === "revokeInterviewInvitation") {
    const next = revokeInterviewInvitation(current, user, input);
    await saveState(current, next);
    return Response.json(
      { snapshot: { user, state: projectState(next, user) } },
      { headers: reviewHeaders },
    );
  }
  if (
    !["previewInterviewInvitation", "sendInterviewInvitation"].includes(
      String(input.action),
    )
  )
    throw new BusinessError("INVALID_ACTION", "无效的面试邀请操作", 400);
  const mailPreview = previewInterviewInvitation(current, user, input);
  if (input.action === "previewInterviewInvitation") {
    const status =
      mailEnvironment.MAIL_MODE === "live" ? await gmailStatus(request) : null;
    return Response.json(
      {
        mailPreview,
        mailReady: Boolean(status?.configured && status.connected),
        connectUrl: "/mail-connect",
      },
      { headers: reviewHeaders },
    );
  }
  if (mailEnvironment.MAIL_MODE !== "live")
    throw new BusinessError(
      "GMAIL_NOT_CONFIGURED",
      "真实发信尚未启用，请先完成招聘邮箱配置与授权。",
      503,
    );
  requireMailOperator(request, mailEnvironment);
  const status = await gmailStatus(request);
  if (!status.configured || !status.connected)
    throw new BusinessError(
      "GMAIL_NOT_CONNECTED",
      "尚未连接 Gmail，请先完成发信邮箱授权。",
      503,
    );
  if (!mailEnvironment.MAIL_BASE_URL)
    throw new BusinessError(
      "GMAIL_NOT_CONFIGURED",
      "尚未配置候选人公开答复地址",
      503,
    );
  const responseUrl = new URL(
    "/interview-response",
    mailEnvironment.MAIL_BASE_URL,
  );
  if (
    responseUrl.protocol !== "https:" ||
    responseUrl.origin !== new URL(request.url).origin
  )
    throw new BusinessError(
      "GMAIL_NOT_CONFIGURED",
      "候选人答复地址须为本站公开 HTTPS 地址",
      503,
    );
  const { token, tokenHash } = await newReviewToken();
  const created = createInterviewInvitation(current, user, input, tokenHash);
  await saveState(current, created.state);
  responseUrl.hash = `token=${token}`;
  let mailDelivery: Parameters<typeof recordInterviewInvitationDelivery>[2];
  try {
    mailDelivery = await sendReviewEmail(request, {
      id: created.invitation.id,
      to: mailPreview.to,
      subject: mailPreview.subject,
      text: mailPreview.text
        .replace("{{RESPONSE_URL}}", responseUrl.href)
        .replace("（发送时生成专属答复链接）", ""),
    });
  } catch {
    mailDelivery = {
      status: "unknown",
      reason: "发送结果暂无法确认，请先核查 Gmail 已发送邮件，不要重复发送。",
    };
  }
  let finalState: AppState;
  try {
    finalState = await saveInterviewDelivery(
      created.invitation.id,
      mailDelivery,
    );
  } catch {
    // The provider receipt remains durable in mail_jobs for snapshot reconciliation.
    finalState = await loadState();
  }
  return Response.json(
    {
      mailDelivery,
      snapshot: { user, state: projectState(finalState, user) },
    },
    { headers: reviewHeaders },
  );
}
function interviewResponseToken(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new InterviewInvitationError(
      "INVITATION_GONE",
      "邀请链接无效或已失效，请联系招聘 HR",
      410,
    );
  return value;
}
export async function interviewResponseSnapshot(request: Request) {
  const token = interviewResponseToken(
    new URL(request.url).searchParams.get("token"),
  );
  const view = readInterviewInvitation(
    await loadState(),
    await hashReviewToken(token),
  );
  return Response.json(view, { headers: reviewHeaders });
}
export async function interviewResponseAction(
  request: Request,
  input: Record<string, unknown>,
) {
  checkOrigin(request);
  const token = interviewResponseToken(input.token);
  const tokenHash = await hashReviewToken(token);
  const current = await loadState();
  const next = submitInterviewInvitation(current, tokenHash, input);
  await saveState(current, next);
  return Response.json(
    {
      view: readInterviewInvitation(next, tokenHash),
      message:
        input.response === "confirmed"
          ? "已确认参加，招聘 HR 已可查看您的答复。"
          : "改期申请已记录，HR 将联系您确认新的面试时间。",
    },
    { headers: reviewHeaders },
  );
}
export function errorResponse(error: unknown) {
  if (
    error instanceof BusinessError ||
    error instanceof CandidateReviewError ||
    error instanceof InterviewInvitationError ||
    error instanceof OperatorError ||
    error instanceof GmailError
  )
    return Response.json(
      {
        error: error.code,
        message: error.message,
        ...(error instanceof OperatorError && error.signInUrl
          ? { signInUrl: error.signInUrl }
          : {}),
        ...(error.code.startsWith("GMAIL_") ||
        error.code === "MAIL_OPERATOR_NOT_CONFIGURED"
          ? { connectUrl: "/mail-connect" }
          : {}),
      },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  console.error(
    "Recruitment API error",
    error instanceof Error ? error.message : "Unknown error",
  );
  return Response.json(
    { error: "SERVER_ERROR", message: "服务暂时不可用，请稍后重试" },
    { status: 500 },
  );
}
