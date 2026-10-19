import type { AppState, Application, Job, SelectionReport } from "./domain.ts";
import { initialScreeningReady, screeningPolicy } from "./selection.ts";

export function queueResumeReview(app: Application, job: Job, now: string) {
  app.selection ??= { assessments: [] };
  const rule = app.selection.ruleReview;
  const current = JSON.stringify(rule?.policy) === JSON.stringify(screeningPolicy(job));
  const message = !app.snapshot.resume.trim()
    ? "请先上传简历，完成岗位初筛后将自动复筛。"
    : !rule || !current
      ? "请先按当前岗位条件重新初筛，完成后将自动复筛。"
      : !initialScreeningReady(rule)
        ? "请先完成岗位线索初筛，再生成 AI 复筛报告。"
        : "初筛已完成，正在生成 AI 复筛报告；缺项与未知信息将交由 AI 和 HR 核实。";
  app.selection.aiReview = {
    status: rule && current && initialScreeningReady(rule) && app.snapshot.resume.trim() ? "pending" : "blocked",
    message,
    updatedAt: now,
  };
}

// Bind a result to the exact application snapshot and job requirements it read.
export function resumeReviewInput(app: Application, job: Job) {
  const { name, email, phone, school, major, education, graduationYear, skills, resume } = app.snapshot;
  return JSON.stringify({ candidate: { name, email, phone, school, major, education, graduationYear, skills, resume }, policy: screeningPolicy(job), title: job.title, description: job.description });
}

export function attachResumeReview(
  state: AppState,
  applicationId: string,
  expectedInput: string,
  requestedAt: string,
  result: SelectionReport | { message: string },
  actorId: string,
  now: string,
): AppState | null {
  const app = state.applications.find((item) => item.id === applicationId);
  const job = state.jobs.find((item) => item.id === app?.jobId);
  if (!app || !job || app.status !== "active" || !["new", "screening", "interview"].includes(app.stage) ||
    app.selection?.aiReview?.status !== "pending" || app.selection.aiReview.updatedAt !== requestedAt ||
    resumeReviewInput(app, job) !== expectedInput) return null;
  const next = structuredClone(state);
  const target = next.applications.find((item) => item.id === applicationId)!;
  if ("kind" in result) {
    target.selection!.resumeReview = result;
    delete target.selection!.aiReview;
  } else {
    target.selection!.aiReview = { status: "failed", message: result.message, updatedAt: now };
  }
  target.version++;
  target.updatedAt = now;
  next.revision++;
  next.events.push({
    id: `event_${crypto.randomUUID()}`,
    applicationId,
    actorId,
    at: now,
    type: "selection",
    from: target.stage,
    to: target.stage,
    note: "kind" in result ? `AI 简历复筛已完成（${result.model}）；报告仅供 HR 人工复核，未自动推进。` : `AI 简历复筛未完成：${result.message}`,
  });
  return next;
}
