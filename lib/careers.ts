import type { AppState, Application, Candidate, Job } from "./domain.ts";
import { BusinessError } from "./engine.ts";
import { runRuleReview } from "./selection.ts";
import { queueResumeReview } from "./resume-workflow.ts";

export type PublicJob = Pick<Job, "id" | "title" | "department" | "location" | "type" | "batch" | "graduationYears" | "description" | "skills" | "createdAt">;
export type PublicReceipt = NonNullable<AppState["careerSubmissions"]>[number]["receipt"];

export function publicJobs(state: AppState): PublicJob[] {
  return state.jobs.filter((job) => job.status === "open").map((job) => ({
    id: job.id,
    title: job.title,
    department: job.department,
    location: job.location,
    type: job.type,
    batch: job.batch,
    graduationYears: [...job.graduationYears],
    description: job.description,
    skills: [...job.skills],
    createdAt: job.createdAt,
  }));
}

function fail(code: string, message: string, status = 422): never {
  throw new BusinessError(code, message, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_FIELDS", "请完整填写投递表单", 400);
  return value as Record<string, unknown>;
}
function allowFields(data: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    fail("INVALID_FIELDS", "投递只能包含表单允许的字段", 400);
}
const phoneKey = (value: string) => value.replace(/[\s()+-]/g, "");

function candidateFields(value: unknown): Omit<Candidate, "id" | "createdAt"> {
  const data = object(value);
  allowFields(data, ["name", "email", "phone", "school", "major", "education", "graduationYear", "skills", "resume", "availability"]);
  const field = (key: string, max: number, required = false): string => {
    const value = data[key];
    if (value === undefined && !required) return "";
    if (typeof value !== "string" || value.trim().length > max)
      fail("INVALID_FIELDS", "资料格式不正确或超过长度限制");
    const result = value.trim();
    if (required && !result) fail("REQUIRED", "请填写姓名、邮箱和简历内容");
    return result;
  };
  const name = field("name", 80, true),
    email = field("email", 254, true).toLowerCase(),
    phone = field("phone", 32),
    resume = field("resume", 100000, true),
    education = field("education", 20) || "unknown";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail("INVALID_EMAIL", "邮箱格式不正确");
  if (phone && (!/^\+?[\d\s()-]{7,22}$/.test(phone) || !/^\d{7,15}$/.test(phoneKey(phone))))
    fail("INVALID_PHONE", "手机格式不正确");
  if (!["unknown", "college", "bachelor", "master", "doctor"].includes(education))
    fail("INVALID_EDUCATION", "请选择有效学历或待核实");
  const graduationYear = data.graduationYear === undefined ? null : data.graduationYear;
  if (graduationYear !== null && (!Number.isInteger(graduationYear) || Number(graduationYear) < 1960 || Number(graduationYear) > 2100))
    fail("INVALID_YEAR", "毕业年份应为 1960–2100 的整数或未知");
  const skills = data.skills === undefined ? [] : data.skills;
  if (!Array.isArray(skills) || skills.length > 30 || skills.some((item) => typeof item !== "string" || !item.trim() || item.length > 60))
    fail("INVALID_SKILLS", "技能最多 30 项，每项 1–60 字符");
  if (!/[\p{L}\p{N}]/u.test(resume) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(resume))
    fail("INVALID_RESUME", "请提供可识别的简历文字");
  return {
    name, email, phone, resume, education,
    school: field("school", 120),
    major: field("major", 120),
    graduationYear: graduationYear as number | null,
    skills: [...new Set((skills as string[]).map((item) => item.trim()))],
    availability: field("availability", 240),
  };
}

export async function submitCareerApplication(
  source: AppState,
  input: Record<string, unknown>,
  clock = new Date(),
): Promise<{ state: AppState; receipt: PublicReceipt; replayed: boolean }> {
  allowFields(input, ["requestId", "jobId", "candidate", "consent"]);
  if (input.consent !== true)
    fail("CONSENT_REQUIRED", "请确认同意将资料用于本次招聘");
  if (typeof input.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId))
    fail("INVALID_REQUEST_ID", "投递请求无效，请刷新后重试");
  if (typeof input.jobId !== "string" || !input.jobId || input.jobId.length > 100)
    fail("JOB_UNAVAILABLE", "该职位暂不可投递，请选择其他在招职位", 404);
  const requestId = input.requestId.toLowerCase();
  const fields = candidateFields(input.candidate);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ requestId, jobId: input.jobId, candidate: fields })));
  const inputHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const previous = source.careerSubmissions?.find((item) => item.requestId === requestId);
  if (previous) {
    if (previous.inputHash !== inputHash)
      fail("REQUEST_CONFLICT", "该请求已提交过其他资料，请重新发起投递", 409);
    return { state: source, receipt: { ...previous.receipt }, replayed: true };
  }
  const job = source.jobs.find((item) => item.id === input.jobId && item.status === "open");
  if (!job) fail("JOB_UNAVAILABLE", "该职位暂不可投递，请选择其他在招职位", 404);
  const matchesContact = (candidate: Candidate) =>
    candidate.email.trim().toLowerCase() === fields.email ||
    Boolean(fields.phone && candidate.phone && phoneKey(candidate.phone) === phoneKey(fields.phone));
  if (source.applications.some((app) => app.jobId === job.id && (
    matchesContact(app.snapshot) ||
    source.candidates.some((candidate) => candidate.id === app.candidateId && matchesContact(candidate))
  )))
    fail("ALREADY_APPLIED", "该职位已提交过，请联系招聘人员核实", 409);

  const state = structuredClone(source), now = clock.toISOString();
  // Contact details are unverified: always keep this submission separate from existing profiles.
  const candidate: Candidate = { id: `candidate_${crypto.randomUUID()}`, ...fields, createdAt: now };
  const app: Application = {
    id: `application_${crypto.randomUUID()}`,
    candidateId: candidate.id,
    jobId: job.id,
    snapshot: structuredClone(candidate),
    stage: "new",
    status: "active",
    outcome: "",
    source: "候选人自助投递",
    ownerId: job.ownerId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    screeningNote: "",
    decision: "pending",
    decisionNote: "",
    offer: { status: "none", sentAt: "", deadline: "", answeredAt: "", reference: "" },
    agreement: { type: job.type === "campus" ? "三方协议" : "劳动合同", status: "pending", date: "", note: "" },
    plannedJoinDate: "",
    joinedAt: "",
  };
  app.selection = {
    assessments: [],
    ruleReview: runRuleReview(job, app.snapshot, now),
  };
  queueResumeReview(app, job, now);
  state.candidates.push(candidate);
  state.applications.push(app);
  state.events.push({
    id: `event_${crypto.randomUUID()}`, applicationId: app.id,
    actorId: "候选人", at: now, type: "created", from: "", to: "new",
    note: "候选人同意将资料用于本次招聘，通过候选人端自助提交；联系方式及资料待招聘人员核实。",
  });
  const receipt: PublicReceipt = {
    reference: `TF-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    jobTitle: job.title,
    submittedAt: now,
  };
  (state.careerSubmissions ??= []).push({ requestId, inputHash, receipt: { ...receipt } });
  state.revision = source.revision + 1;
  return { state, receipt, replayed: false };
}
