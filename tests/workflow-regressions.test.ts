import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState } from "../lib/domain.ts";
import { applyAction, BusinessError } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { submitCareerApplication } from "../lib/careers.ts";
import { hasLegacyScreeningApproval, screeningPolicy } from "../lib/selection.ts";

const NOW = new Date("2026-10-19T02:00:00.000Z");
const fields = {
  name: "流程回归合成样本", email: "workflow-regression@example.com",
  phone: "+44 20 7946 0958", school: "演示大学", major: "信息管理",
  education: "bachelor", graduationYear: null, skills: ["产品规划"],
  resume: "负责产品规划项目，整理需求并复盘交付结果。", availability: "两周内",
};
function act(state: AppState, input: Record<string, unknown>, userId = "hr") {
  return applyAction(state, state.users.find((user) => user.id === userId)!, {
    expectedRevision: state.revision, ...input,
  }, NOW);
}
function rejectsCode(state: AppState, input: Record<string, unknown>, code: string) {
  const before = JSON.stringify(state);
  assert.throws(() => act(state, input), (error: unknown) =>
    error instanceof BusinessError && error.code === code);
  assert.equal(JSON.stringify(state), before);
}
function screenedApplication() {
  let state = act(createSeed(NOW), { action: "createCandidate", jobId: "job_1", ...fields });
  const app = state.applications.at(-1)!, job = state.jobs.find((item) => item.id === app.jobId)!;
  app.selection!.resumeReview = {
    createdAt: NOW.toISOString(), kind: "resume", mode: "llm", model: "test-fixture",
    title: "合成测试报告", summary: "相关经历仍需人工核实。", score: null, maxScore: null,
    evidence: [{ label: "经历", status: "matched", quote: fields.resume }],
    gaps: [], questions: ["请说明个人职责。"], disclaimer: "内存测试样本，无模型请求。",
    policy: screeningPolicy(job),
  };
  state = act(state, { action: "confirm_screening", applicationId: app.id, conclusion: "pass", note: "已人工核实资料及岗位条件" });
  state = act(state, { action: "advance", applicationId: app.id });
  state = act(state, { action: "advance", applicationId: app.id, note: "当前报告及 HR 复核通过" });
  return { state, appId: app.id };
}
function schedule(state: AppState, appId: string, day: string) {
  return act(state, { action: "scheduleInterview", applicationId: appId, round: "专业面试",
    start: `2026-10-${day}T02:00:00.000Z`, end: `2026-10-${day}T03:00:00.000Z`,
    interviewerIds: ["interviewer"], location: "合成测试会议室" });
}
function submit(state: AppState, interviewId: string, rating: number) {
  const interview = state.interviews.find((item) => item.id === interviewId)!;
  const app = state.applications.find((item) => item.id === interview.applicationId)!;
  const job = state.jobs.find((item) => item.id === app.jobId)!;
  return act(state, { action: "submitScorecard", interviewId,
    ratings: Object.fromEntries(job.dimensions.map((dimension) => [dimension, rating])),
    evidence: "独立记录本轮面试中的项目职责及证据", recommendation: rating > 3 ? "hire" : "reject",
  }, "interviewer");
}

test("HR can correct public cross-job profiles without changing shared normalized contacts or application snapshots", async () => {
  let state = createSeed(NOW);
  for (const jobId of ["job_1", "job_2"]) {
    const result = await submitCareerApplication(state, {
      jobId, candidate: fields, consent: true, requestId: crypto.randomUUID(),
    }, NOW);
    state = result.state;
  }
  const profiles = state.candidates.filter((item) => item.email === fields.email);
  assert.equal(profiles.length, 2);
  const snapshots = JSON.stringify(state.applications.map((app) => app.snapshot));
  for (const profile of profiles) {
    state = act(state, { action: "updateCandidate", candidateId: profile.id,
      school: "更正后的演示大学", email: fields.email.toUpperCase(), phone: "+442079460958" });
    assert.equal(state.candidates.find((item) => item.id === profile.id)!.school, "更正后的演示大学");
  }
  assert.equal(JSON.stringify(state.applications.map((app) => app.snapshot)), snapshots);
  for (const contact of [{ email: state.candidates[0].email }, { phone: state.candidates[0].phone }])
    rejectsCode(state, { action: "updateCandidate", candidateId: profiles[0].id, ...contact }, "DUPLICATE_CANDIDATE");
});

test("anonymized applications cannot acquire historical screening approval by adding a new note", () => {
  let state = act(createSeed(NOW), { action: "createCandidate", jobId: "job_1", ...fields });
  const appId = state.applications.at(-1)!.id, candidateId = state.candidates.at(-1)!.id;
  state = act(state, { action: "advance", applicationId: appId });
  const advance = { action: "advance", applicationId: appId, note: "填写备注不能替代当前复核" };
  rejectsCode(state, advance, "SCREENING_APPROVAL_REQUIRED");
  state = act(state, { action: "anonymizeCandidate", candidateId });
  rejectsCode(state, advance, "SCREENING_APPROVAL_REQUIRED");
  const app = state.applications.find((item) => item.id === appId)!;
  app.screeningNote = "补填人工备注";
  assert.equal(hasLegacyScreeningApproval(state, app), false);
  assert.ok(!app.selection);
});

test("additional interviews and new submitted evidence require a fresh manager decision before Offer", () => {
  let { state, appId } = screenedApplication();
  state = schedule(state, appId, "26");
  let interviewId = state.interviews.at(-1)!.id;
  state = act(state, { action: "interviewStatus", interviewId, status: "completed" });
  state = submit(state, interviewId, 5);
  const decision = { action: "decision", applicationId: appId, decision: "hire", note: "基于已收齐的评价作出人工决定" };
  state = act(state, decision, "manager");
  const originalDecision = state.events.findLast((item) => item.applicationId === appId && item.type === "decision")!;
  state = schedule(state, appId, "27");
  assert.equal(state.applications.find((item) => item.id === appId)!.decision, "pending");
  assert.equal(state.applications.find((item) => item.id === appId)!.decisionNote, "");
  interviewId = state.interviews.at(-1)!.id;
  // Even an interim decision based on the earlier completed round must not
  // survive the later submission of new evidence.
  state = act(state, decision, "manager");
  state = act(state, { action: "interviewStatus", interviewId, status: "completed" });
  state = submit(state, interviewId, 1);
  assert.equal(state.applications.find((item) => item.id === appId)!.decision, "pending");
  assert.ok(state.events.some((item) => item.id === originalDecision.id));
  const offer = { action: "sendOffer", applicationId: appId, deadline: "2026-10-29T10:00:00Z" };
  rejectsCode(state, offer, "DECISION_REQUIRED");
  state = act(state, decision, "manager");
  state = act(state, offer);
  assert.equal(state.applications.find((item) => item.id === appId)!.offer.status, "sent");
});

for (const status of ["cancelled", "no_show"])
  test(`a supplemental interview recorded as ${status} also requires renewed manager approval`, () => {
    let { state, appId } = screenedApplication();
    state = schedule(state, appId, "26");
    let interviewId = state.interviews.at(-1)!.id;
    state = act(state, { action: "interviewStatus", interviewId, status: "completed" });
    state = submit(state, interviewId, 5);
    state = schedule(state, appId, "27");
    interviewId = state.interviews.at(-1)!.id;
    const decision = { action: "decision", applicationId: appId, decision: "hire", note: "基于当前已完成评价确认" };
    state = act(state, decision, "manager");
    state = act(state, { action: "interviewStatus", interviewId, status });
    assert.equal(state.applications.find((item) => item.id === appId)!.decision, "pending");
    const offer = { action: "sendOffer", applicationId: appId, deadline: "2026-10-29T10:00:00Z" };
    rejectsCode(state, offer, "DECISION_REQUIRED");
    state = act(state, decision, "manager");
    state = act(state, offer);
    assert.equal(state.applications.find((item) => item.id === appId)!.offer.status, "sent");
  });
