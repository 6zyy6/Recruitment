import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../lib/seed.ts";
import { runRuleReview, screeningPolicy } from "../lib/selection.ts";
import { attachResumeReview, queueResumeReview, resumeReviewInput } from "../lib/resume-workflow.ts";
import type { SelectionReport } from "../lib/domain.ts";

const NOW = "2026-10-20T02:00:00.000Z";
function queued() {
  const state = createSeed(new Date(NOW));
  const app = state.applications[0];
  const job = state.jobs.find((item) => item.id === app.jobId)!;
  app.selection = { assessments: [], ruleReview: runRuleReview(job, app.snapshot, NOW) };
  queueResumeReview(app, job, NOW);
  return { state, app, job, fingerprint: resumeReviewInput(app, job) };
}
function report(policy: ReturnType<typeof screeningPolicy>): SelectionReport {
  return { createdAt: NOW, kind: "resume", mode: "llm", model: "test-model", title: "AI 简历复筛", summary: "依据简历核实岗位技能。", score: null, maxScore: null, evidence: [], gaps: [], questions: [], disclaimer: "人工确认", policy };
}

test("current initial screening queues AI while preserving unknown and mismatched evidence", () => {
  const { app, job } = queued();
  assert.equal(app.selection!.aiReview!.status, "pending");
  job.screeningPolicy = { ...screeningPolicy(job), minimumEducation: "doctor" };
  app.selection!.ruleReview = runRuleReview(job, app.snapshot, NOW);
  assert.ok(app.selection!.ruleReview.evidence.some((item) => item.status === "missing"));
  queueResumeReview(app, job, NOW);
  assert.equal(app.selection!.aiReview!.status, "pending");
  app.snapshot.education = "unknown";
  app.snapshot.skills = [];
  app.snapshot.resume = "尚待补充的相关项目经历";
  app.selection!.ruleReview = runRuleReview(job, app.snapshot, NOW);
  const review = structuredClone(app.selection!.ruleReview);
  assert.ok(review.evidence.some((item) => item.status === "unknown"));
  assert.match(review.summary, /未知/);
  queueResumeReview(app, job, NOW);
  assert.equal(app.selection!.aiReview!.status, "pending");
  assert.deepEqual(app.selection!.ruleReview, review);
  assert.equal(app.selection!.resumeReview, undefined);
  assert.equal(app.selection!.hrReview, undefined);
  assert.equal(app.stage, "new");
  assert.equal(app.status, "active");
});

test("missing initial screening, missing resume and stale rules still block AI", () => {
  const { app, job } = queued();
  const rule = app.selection!.ruleReview;
  delete app.selection!.ruleReview;
  queueResumeReview(app, job, NOW);
  assert.equal(app.selection!.aiReview!.status, "blocked");
  assert.match(app.selection!.aiReview!.message, /初筛/);
  app.selection!.ruleReview = rule;
  app.snapshot.resume = "";
  queueResumeReview(app, job, NOW);
  assert.equal(app.selection!.aiReview!.status, "blocked");
  assert.match(app.selection!.aiReview!.message, /上传简历/);
  app.snapshot.resume = "有简历";
  job.screeningPolicy = { ...screeningPolicy(job), updatedAt: "2026-10-20T03:00:00Z" };
  queueResumeReview(app, job, NOW);
  assert.equal(app.selection!.aiReview!.status, "blocked");
  assert.match(app.selection!.aiReview!.message, /重新初筛/);
});

test("real report is attached only to its application and does not advance or approve", () => {
  const { state, app, job, fingerprint } = queued();
  const untouched = structuredClone(state.applications[1]);
  const next = attachResumeReview(state, app.id, fingerprint, NOW, report(screeningPolicy(job)), "hr", NOW)!;
  assert.equal(next.applications[0].selection!.resumeReview!.mode, "llm");
  assert.equal(next.applications[0].selection!.aiReview, undefined);
  assert.equal(next.applications[0].stage, app.stage);
  assert.equal(next.applications[0].selection!.hrReview, undefined);
  assert.deepEqual(next.applications[1], untouched);
  assert.equal(state.applications[0].selection!.resumeReview, undefined);
  assert.equal(next.revision, state.revision + 1);
});

test("late AI results are discarded after resume changes, policy changes, cancellation or a newer request", () => {
  for (const change of ["resume", "policy", "closed", "new-request"]) {
    const { state, app, job, fingerprint } = queued();
    if (change === "resume") app.snapshot.resume += "更正";
    if (change === "policy") job.description += "新要求";
    if (change === "closed") app.status = "closed";
    if (change === "new-request") app.selection!.aiReview!.updatedAt = "later";
    assert.equal(attachResumeReview(state, app.id, fingerprint, NOW, report(screeningPolicy(job)), "hr", NOW), null);
  }
});

test("model failure keeps the saved application and exposes a retryable failure without a fake report", () => {
  const { state, app, fingerprint } = queued();
  const next = attachResumeReview(state, app.id, fingerprint, NOW, { message: "模型服务暂不可用，请重试。" }, "hr", NOW)!;
  assert.equal(next.applications[0].selection!.aiReview!.status, "failed");
  assert.equal(next.applications[0].selection!.resumeReview, undefined);
  assert.equal(next.applications[0].id, app.id);
});
