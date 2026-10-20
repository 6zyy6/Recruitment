import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState, Application } from "../lib/domain.ts";
import { createSeed } from "../lib/seed.ts";
import { candidateReviewFields } from "../lib/candidate-review.ts";
import { handleSelectionAction, hasLegacyScreeningApproval } from "../lib/selection.ts";

const NOW = new Date("2026-10-20T02:00:00.000Z");
function fixture(id = "application_17") {
  const state = createSeed(NOW);
  return { state, app: state.applications.find((item) => item.id === id)! };
}
function event(state: AppState, app: Application, type: string) {
  state.events.push({ id: `test_${type}`, applicationId: app.id, actorId: "hr", at: NOW.toISOString(), type, from: app.stage, to: app.stage, note: "测试操作" });
}
function submittedReview(state: AppState, app: Application) {
  const fields = candidateReviewFields(app.snapshot);
  const review = {
    id: "review_test", reviewId: "review_test", applicationId: app.id,
    candidateId: app.candidateId, createdBy: "hr", tokenHash: "a".repeat(64),
    status: "submitted" as const, version: 1, createdAt: NOW.toISOString(),
    expiresAt: NOW.toISOString(), submittedAt: NOW.toISOString(), revokedAt: "",
    delivery: "preview" as const, deliveryReason: "测试记录", fields,
    candidateAtIssue: structuredClone(fields), submittedFields: structuredClone(fields),
  };
  state.reviews = [review];
  return review;
}

test("seed interview records retain historical screening despite demo reports or assessment-only selection", () => {
  for (const id of ["application_17", "application_18", "application_19"]) {
    const { state, app } = fixture(id), before = JSON.stringify(state);
    assert.equal(hasLegacyScreeningApproval(state, app), true, id);
    assert.equal(JSON.stringify(state), before);
  }
});

test("historical approval requires a note and an actual screening-to-interview advancement", () => {
  for (const note of ["", "  "]) {
    const { state, app } = fixture(); app.screeningNote = note;
    assert.equal(hasLegacyScreeningApproval(state, app), false);
  }
  for (const change of ["missing", "wrong_type", "wrong_from", "wrong_to"]) {
    const { state, app } = fixture();
    const advanced = state.events.find((item) => item.applicationId === app.id && item.from === "screening" && item.to === "interview")!;
    if (change === "missing") state.events = state.events.filter((item) => item !== advanced);
    if (change === "wrong_type") advanced.type = "selection";
    if (change === "wrong_from") advanced.from = "new";
    if (change === "wrong_to") advanced.to = "screening";
    assert.equal(app.stage, "interview");
    assert.equal(hasLegacyScreeningApproval(state, app), false, change);
  }
});

test("V1 records without a selection container keep their note-based approval unless later invalidated", () => {
  const { state, app } = fixture();
  delete app.selection;
  state.events = state.events.filter((item) => item.applicationId !== app.id);
  assert.equal(hasLegacyScreeningApproval(state, app), true);
  event(state, app, "configure_screening");
  assert.equal(hasLegacyScreeningApproval(state, app), false);
  state.events = [];
  submittedReview(state, app).submittedFields.name = "更正后的姓名";
  assert.equal(hasLegacyScreeningApproval(state, app), false);
});

test("explicit screening work invalidates the historical path even when an old note remains", () => {
  for (const type of ["run_screening", "review_resume", "verify_screening_info", "confirm_screening", "configure_screening"]) {
    const { state, app } = fixture(); event(state, app, type);
    assert.ok(app.screeningNote);
    assert.equal(hasLegacyScreeningApproval(state, app), false, type);
  }
});

test("automatic review requests and results retain existing human screening evidence", () => {
  for (const status of ["pending", "running", "failed", "blocked", "completed"] as const) {
    const { state, app } = fixture();
    event(state, app, "ensure_resume_review"); event(state, app, "selection");
    if (status === "completed") app.selection!.resumeReview!.mode = "llm";
    else app.selection!.aiReview = { status, message: "自动复筛", updatedAt: NOW.toISOString() };
    assert.equal(hasLegacyScreeningApproval(state, app), true, status);
  }
});

test("automatic ensure requests leave historical screening reports and assessments unchanged", () => {
  for (const id of ["application_17", "application_18"]) {
    const { state, app } = fixture(id), before = JSON.stringify(state);
    const handled = handleSelectionAction(state, state.users.find((item) => item.id === "hr")!, { action: "ensure_resume_review", applicationId: app.id }, NOW.toISOString());
    assert.equal(handled, true);
    assert.equal(JSON.stringify(state), before);
  }
});

test("explicit HR conclusions and stale report policies cannot use historical approval", () => {
  for (const conclusion of ["pass", "hold", "reject"] as const) {
    const { state, app } = fixture();
    app.selection!.hrReview = { actorId: "hr", createdAt: NOW.toISOString(), conclusion, note: "人工复核结论" };
    assert.equal(hasLegacyScreeningApproval(state, app), false, conclusion);
  }
  for (const key of ["ruleReview", "resumeReview"] as const) {
    const { state, app } = fixture();
    app.selection![key]!.policy!.updatedAt = "2026-10-01T00:00:00.000Z";
    assert.equal(hasLegacyScreeningApproval(state, app), false, key);
    const missing = fixture();
    delete missing.app.selection![key]!.policy;
    assert.equal(hasLegacyScreeningApproval(missing.state, missing.app), false, `${key} without policy`);
  }
  const { state, app } = fixture();
  state.jobs = state.jobs.filter((item) => item.id !== app.jobId);
  assert.equal(hasLegacyScreeningApproval(state, app), false);
});

test("candidate changes invalidate historical approval while unchanged confirmation preserves it", () => {
  for (const field of ["name", "skills"] as const) {
    const { state, app } = fixture("application_18");
    const review = submittedReview(state, app);
    if (field === "name") review.submittedFields.name = "更正后的姓名";
    else review.submittedFields.skills = [...review.fields.skills, "新技能"];
    assert.equal(hasLegacyScreeningApproval(state, app), false, field);
  }
  const { state, app } = fixture("application_18"), review = submittedReview(state, app);
  review.submittedFields = Object.fromEntries(Object.entries(review.fields).reverse()) as typeof review.fields;
  event(state, app, "candidate_review_submitted");
  assert.equal(hasLegacyScreeningApproval(state, app), true);
});

test("screening work and candidate changes affect only their own application", () => {
  const { state, app } = fixture(), other = state.applications.find((item) => item.id === "application_18")!;
  event(state, other, "run_screening");
  submittedReview(state, other).submittedFields.name = "另一投递的更正";
  assert.equal(hasLegacyScreeningApproval(state, app), true);
  assert.equal(hasLegacyScreeningApproval(state, other), false);
  event(state, app, "assign_assessment"); event(state, app, "submit_assessment");
  assert.equal(hasLegacyScreeningApproval(state, app), true);
});
