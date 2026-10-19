import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState } from "../lib/domain.ts";
import { applyAction, BusinessError, projectState } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { submitCareerApplication } from "../lib/careers.ts";
import { CandidateReviewError, candidateReviewFields, createCandidateReview, hashReviewToken, newReviewToken, readCandidateReview, revokeCandidateReview, submitCandidateReview } from "../lib/candidate-review.ts";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const seed = () => createSeed(NOW);
const hr = (state: AppState) => state.users.find(item => item.id === "hr")!;
const app = (state: AppState, id = "application_1") => state.applications.find(item => item.id === id)!;
function rejects(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, (error: unknown) => (error instanceof CandidateReviewError || error instanceof BusinessError) && error.code === code && (status === undefined || error.status === status));
}
async function invite(state = seed(), applicationId = "application_1") {
  const secret = await newReviewToken();
  const created = createCandidateReview(state, hr(state), { applicationId, expectedRevision: state.revision }, secret.tokenHash, NOW);
  return { state: created.state, review: created.review, ...secret };
}
function form(state: AppState) {
  return { ...candidateReviewFields(app(state).snapshot), education: "master", name: "核对后合成姓名", email: "candidate-confirmed@example.com", graduationYear: 2027, skills: ["SQL", "用户研究"] };
}

test("secure invitations use 256-bit randomness, SHA-256 only, seven days and truthful email preview", async () => {
  const first = await newReviewToken(), second = await newReviewToken();
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, await hashReviewToken(first.token));
  assert.notEqual(first.tokenHash, first.token);
  const state = seed(), original = JSON.stringify(state);
  const created = createCandidateReview(state, hr(state), { applicationId: "application_1", expectedRevision: state.revision }, first.tokenHash, NOW);
  const record = created.state.reviews![0];
  assert.equal(record.tokenHash, first.tokenHash);
  assert.ok(!JSON.stringify(created.state).includes(first.token));
  assert.equal(Date.parse(record.expiresAt) - NOW.getTime(), 7 * 86400000);
  assert.equal(record.delivery, "preview");
  assert.match(record.deliveryReason, /未发送邮件/);
  assert.equal(created.state.revision, state.revision + 1);
  assert.equal(app(created.state).stage, app(state).stage);
  assert.equal(app(created.state).snapshot.review!.reviewId, record.id);
  assert.equal(JSON.stringify(state), original);
});

test("only authenticated HR can invite, revisions must match, and legacy states need no reviews field", async () => {
  const state = seed(); delete state.reviews;
  const { tokenHash } = await newReviewToken();
  for (const user of state.users.filter(item => item.role !== "hr")) rejects(() => createCandidateReview(state, user, { applicationId: "application_1", expectedRevision: state.revision }, tokenHash, NOW), "FORBIDDEN", 403);
  rejects(() => createCandidateReview(state, hr(state), { applicationId: "application_1", expectedRevision: state.revision - 1 }, tokenHash, NOW), "REVISION_CONFLICT", 409);
  rejects(() => createCandidateReview(state, hr(state), { candidateId: state.candidates[0].id, expectedRevision: state.revision }, tokenHash, NOW), "NOT_FOUND", 404);
  const created = createCandidateReview(state, hr(state), { applicationId: "application_1", expectedRevision: state.revision }, tokenHash, NOW);
  assert.equal(created.state.reviews!.length, 1);
  rejects(() => applyAction(state, hr(state), { action: "createCandidateReview", expectedRevision: state.revision, applicationId: "application_1", tokenHash }, NOW), "REVIEW_ENDPOINT_REQUIRED");
});

test("token reads only the specified applicant fields, job title and expiry, with no resume or HR data", async () => {
  const state = seed();
  app(state).screeningNote = "HR_PRIVATE_NOTE";
  app(state).snapshot.resume = "PRIVATE_RAW_RESUME";
  state.candidates[1].name = "OTHER_PERSON_SECRET";
  const issued = await invite(state);
  const view = readCandidateReview(issued.state, issued.tokenHash, NOW);
  assert.deepEqual(Object.keys(view).sort(), ["canSubmit", "demoNotice", "fields", "job", "review"]);
  assert.deepEqual(Object.keys(view.fields).sort(), ["availability", "education", "email", "graduationYear", "major", "name", "phone", "school", "skills"]);
  assert.equal(view.review.id, issued.review.reviewId);
  assert.equal(view.canSubmit, true);
  assert.match(view.demoNotice, /合成资料/);
  const json = JSON.stringify(view);
  for (const forbidden of ["HR_PRIVATE_NOTE", "PRIVATE_RAW_RESUME", "OTHER_PERSON_SECRET", issued.tokenHash, "scorecards", "decisionNote"]) assert.ok(!json.includes(forbidden));
});

test("every authenticated projection omits raw review tokens and hashes", async () => {
  const issued = await invite();
  for (const user of issued.state.users) {
    const projected = projectState(issued.state, user), json = JSON.stringify(projected);
    assert.equal(projected.reviews, undefined);
    assert.ok(!json.includes(issued.tokenHash));
    assert.ok(!json.includes(issued.token));
    if (user.role === "interviewer") assert.ok(projected.candidates.every(item => item.review === undefined));
  }
  assert.equal(app(projectState(issued.state, hr(issued.state))).snapshot.review!.status, "pending");
});

test("confirmation is explicit; invalid fields and injected state fields fail atomically", async () => {
  const issued = await invite(), before = JSON.stringify(issued.state);
  const body = { expectedVersion: 0, confirmed: true, fields: form(issued.state) };
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, confirmed: false }, NOW), "CONFIRMATION_REQUIRED");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, decision: "hire" } }, NOW), "INVALID_REVIEW_FIELDS");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, resume: "replace HR text" } }, NOW), "INVALID_REVIEW_FIELDS");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, email: "bad-email" } }, NOW), "INVALID_EMAIL");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, email: "", phone: "" } }, NOW), "CONTACT_REQUIRED");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, graduationYear: "2027" } }, NOW), "INVALID_YEAR");
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, skills: [" "] } }, NOW), "INVALID_SKILLS");
  assert.equal(JSON.stringify(issued.state), before);
});

test("phone-only contact requires 7–15 digits and still accepts international formatting", async () => {
  const issued = await invite(), before = JSON.stringify(issued.state);
  const body = { expectedVersion: 0, confirmed: true, fields: { ...form(issued.state), email: "" } };
  for (const phone of ["(((((((", "-------", "+( )-12", "123456", "1234567890123456"]) {
    rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, phone } }, NOW), "INVALID_PHONE");
    assert.equal(JSON.stringify(issued.state), before);
  }
  for (const phone of ["13912345678", "+86 139-1234-5678", "+1 (415) 555-2671", "123456789012345"]) {
    const next = submitCandidateReview(issued.state, issued.tokenHash, { ...body, fields: { ...body.fields, phone } }, NOW);
    assert.equal(app(next).snapshot.phone, phone);
    assert.equal(app(next).snapshot.email, "");
  }
});

test("candidate submission updates only its application and main record, invalidates reviews and never advances", async () => {
  const original = seed(), originalApp = app(original);
  originalApp.selection!.assessments.push({ id: "kept_assessment", kind: "written", title: "保留测评", status: "assigned", assignedAt: NOW.toISOString(), assignedBy: "hr", questions: [], answers: {}, submittedAt: "" });
  const other = original.applications.find(item => item.candidateId === originalApp.candidateId && item.id !== originalApp.id)!;
  assert.ok(other);
  const issued = await invite(original), otherBefore = structuredClone(app(issued.state, other.id)), beforeApp = app(issued.state), fields = form(issued.state);
  const next = submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields }, NOW);
  assert.equal(app(next).snapshot.name, fields.name);
  assert.equal(next.candidates.find(item => item.id === beforeApp.candidateId)!.name, fields.name);
  assert.equal(app(next).snapshot.resume, beforeApp.snapshot.resume);
  assert.deepEqual(app(next, other.id), otherBefore);
  assert.equal(app(next).selection!.ruleReview, undefined);
  assert.equal(app(next).selection!.resumeReview, undefined);
  assert.equal(app(next).selection!.hrReview, undefined);
  assert.deepEqual(app(next).selection!.assessments, beforeApp.selection!.assessments);
  assert.equal(app(next).stage, beforeApp.stage);
  assert.equal(app(next).status, beforeApp.status);
  assert.equal(app(next).decision, beforeApp.decision);
  assert.equal(app(next).snapshot.review!.status, "submitted");
  assert.equal(next.reviews![0].version, 1);
  assert.ok(next.events.some(item => item.type === "candidate_review_submitted" && item.actorId === "candidate"));
});

test("submitted links are locked and return Gone, including repeated posts", async () => {
  const issued = await invite();
  const body = { expectedVersion: 0, confirmed: true, fields: form(issued.state) };
  const next = submitCandidateReview(issued.state, issued.tokenHash, body, NOW);
  rejects(() => readCandidateReview(next, issued.tokenHash, NOW), "REVIEW_GONE", 410);
  rejects(() => submitCandidateReview(next, issued.tokenHash, body, NOW), "REVIEW_GONE", 410);
});

test("invalid, expired and revoked tokens cannot read or submit", async () => {
  const issued = await invite();
  const expiry = new Date(NOW.getTime() + 7 * 86400000);
  rejects(() => readCandidateReview(issued.state, "f".repeat(64), NOW), "REVIEW_GONE", 410);
  rejects(() => readCandidateReview(issued.state, issued.tokenHash, expiry), "REVIEW_GONE", 410);
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: form(issued.state) }, expiry), "REVIEW_GONE", 410);
  const next = revokeCandidateReview(issued.state, hr(issued.state), { expectedRevision: issued.state.revision, applicationId: "application_1" }, NOW);
  assert.equal(next.reviews![0].status, "revoked");
  rejects(() => readCandidateReview(next, issued.tokenHash, NOW), "REVIEW_GONE", 410);
  rejects(() => submitCandidateReview(next, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: form(next) }, NOW), "REVIEW_GONE", 410);
});

test("resending rotates the token and revokes the old invitation without creating another application", async () => {
  const first = await invite(), count = first.state.applications.length;
  const second = await invite(first.state);
  assert.notEqual(first.token, second.token);
  assert.equal(second.state.applications.length, count);
  assert.equal(second.state.reviews![0].status, "revoked");
  assert.equal(second.state.reviews![1].status, "pending");
  rejects(() => readCandidateReview(second.state, first.tokenHash, NOW), "REVIEW_GONE", 410);
  assert.equal(readCandidateReview(second.state, second.tokenHash, NOW).review.id, second.review.reviewId);
});

test("closed, joined and Offer-stage applications reject invites and invalidate previously issued links", async () => {
  for (const mode of ["closed", "joined", "offer", "onboarding"] as const) {
    const issued = await invite();
    if (mode === "closed" || mode === "joined") app(issued.state).status = mode;
    else app(issued.state).stage = mode;
    rejects(() => readCandidateReview(issued.state, issued.tokenHash, NOW), "REVIEW_GONE", 410);
    rejects(() => createCandidateReview(issued.state, hr(issued.state), { expectedRevision: issued.state.revision, applicationId: "application_1" }, issued.tokenHash, NOW), "REVIEW_GONE", 410);
    rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: form(issued.state) }, NOW), "REVIEW_GONE", 410);
  }
});

test("record versions reject stale submissions and HR edits require a fresh invitation", async () => {
  const issued = await invite();
  const body = { expectedVersion: 0, confirmed: true, fields: form(issued.state) };
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { ...body, expectedVersion: -1 }, NOW), "REVIEW_VERSION_CONFLICT", 409);
  const masterChanged = structuredClone(issued.state);
  masterChanged.candidates.find(item => item.id === app(masterChanged).candidateId)!.school = "HR 新核实院校";
  rejects(() => readCandidateReview(masterChanged, issued.tokenHash, NOW), "REVIEW_DATA_CHANGED", 409);
  rejects(() => submitCandidateReview(masterChanged, issued.tokenHash, body, NOW), "REVIEW_DATA_CHANGED", 409);
  const snapshotChanged = structuredClone(issued.state); app(snapshotChanged).snapshot.skills.push("HR 核实技能");
  rejects(() => submitCandidateReview(snapshotChanged, issued.tokenHash, body, NOW), "REVIEW_DATA_CHANGED", 409);
});

test("contact conflicts cannot overwrite another person, even when the applicant confirms", async () => {
  const issued = await invite(), other = issued.state.candidates.find(item => item.id !== app(issued.state).candidateId)!, before = JSON.stringify(issued.state);
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: { ...form(issued.state), email: other.email } }, NOW), "CONTACT_CONFLICT", 409);
  rejects(() => submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: { ...form(issued.state), phone: `+${other.phone.slice(0, 3)} ${other.phone.slice(3)}` } }, NOW), "CONTACT_CONFLICT", 409);
  assert.equal(JSON.stringify(issued.state), before);
});

test("independent public applications sharing contacts can confirm or edit other fields without merging profiles", async () => {
  const candidate = { name: "合成跨岗应聘者", email: "shared-public-review@example.com", phone: "+1 (650) 555-0198", resume: "仅用于验证跨岗自助投递的合成简历。" };
  const first = await submitCareerApplication(seed(), { requestId: crypto.randomUUID(), jobId: "job_1", candidate, consent: true }, NOW);
  const target = first.state.applications.at(-1)!;
  const second = await submitCareerApplication(first.state, { requestId: crypto.randomUUID(), jobId: "job_2", candidate, consent: true }, NOW);
  const otherApp = second.state.applications.at(-1)!;
  assert.notEqual(target.candidateId, otherApp.candidateId);
  const issued = await invite(second.state, target.id), before = JSON.stringify(issued.state);
  const view = readCandidateReview(issued.state, issued.tokenHash, NOW);
  assert.equal(view.canSubmit, true);
  for (const patch of [{}, { name: "核对后的合成姓名" }, { email: candidate.email.toUpperCase(), phone: "+1 650-555-0198" }]) {
    const next = submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: { ...view.fields, ...patch } }, NOW);
    assert.equal(app(next, target.id).snapshot.review!.status, "submitted");
    assert.equal(next.candidates.length, issued.state.candidates.length);
    assert.deepEqual(app(next, otherApp.id), app(issued.state, otherApp.id));
    assert.deepEqual(next.candidates.find(item => item.id === otherApp.candidateId), issued.state.candidates.find(item => item.id === otherApp.candidateId));
    assert.equal(JSON.stringify(issued.state), before);
  }
  const changed = structuredClone(issued.state);
  changed.candidates.find(item => item.id === target.candidateId)!.email = "hr-corrected-contact@example.com";
  rejects(() => submitCandidateReview(changed, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: view.fields }, NOW), "REVIEW_DATA_CHANGED", 409);
});

test("contacts already owned by the invitation snapshot or current master record are not new conflicts", async () => {
  const state = seed(), person = state.candidates.find(item => item.id === app(state).candidateId)!;
  const snapshotContact = { email: app(state).snapshot.email, phone: app(state).snapshot.phone };
  const others = state.candidates.filter(item => item.id !== person.id);
  Object.assign(others[0], snapshotContact);
  person.email = "current-master-contact@example.com";
  person.phone = "+1 202-555-0148";
  const masterContact = { email: person.email, phone: person.phone };
  Object.assign(others[1], masterContact);
  const issued = await invite(state), before = structuredClone(issued.state.candidates.filter(item => item.id !== person.id));
  const fields = readCandidateReview(issued.state, issued.tokenHash, NOW).fields;
  for (const contact of [snapshotContact, masterContact]) {
    const next = submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true,
      fields: { ...fields, ...contact, name: "仅更正合成姓名" } }, NOW);
    assert.equal(app(next).snapshot.review!.status, "submitted");
    assert.deepEqual(next.candidates.filter(item => item.id !== person.id), before);
  }
});

test("revoke action uses existing HR authorization and revision contract", async () => {
  const issued = await invite(), fields = { action: "revokeCandidateReview", applicationId: "application_1", expectedRevision: issued.state.revision };
  rejects(() => applyAction(issued.state, issued.state.users.find(item => item.id === "manager")!, fields, NOW), "FORBIDDEN", 403);
  rejects(() => applyAction(issued.state, hr(issued.state), { ...fields, expectedRevision: issued.state.revision - 1 }, NOW), "REVISION_CONFLICT", 409);
  const next = applyAction(issued.state, hr(issued.state), fields, NOW);
  assert.equal(app(next).snapshot.review!.status, "revoked");
  assert.equal(next.revision, issued.state.revision + 1);
});

test("anonymization removes review snapshots and tokens along with candidate data", async () => {
  const issued = await invite(), candidateId = app(issued.state).candidateId;
  const next = applyAction(issued.state, hr(issued.state), { action: "anonymizeCandidate", candidateId, expectedRevision: issued.state.revision }, NOW);
  assert.equal(next.reviews!.length, 0);
  assert.equal(next.candidates.find(item => item.id === candidateId)!.review, undefined);
  assert.ok(next.applications.filter(item => item.candidateId === candidateId).every(item => item.snapshot.review === undefined));
  rejects(() => readCandidateReview(next, issued.tokenHash, NOW), "REVIEW_GONE", 410);
});

test("changed applicant facts invalidate an earlier manager hiring decision only on that application", async () => {
  const original = seed();
  const target = app(original), other = original.applications.find(item => item.candidateId === target.candidateId && item.id !== target.id)!;
  target.stage = "interview";
  target.decision = "hire";
  target.decisionNote = "依据旧资料确认录用";
  const issued = await invite(original), otherBefore = structuredClone(app(issued.state, other.id));
  const next = submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields: form(issued.state) }, NOW);
  assert.equal(app(next).decision, "pending");
  assert.equal(app(next).decisionNote, "");
  assert.equal(app(next).stage, "interview");
  assert.equal(app(next).status, "active");
  assert.deepEqual(app(next, other.id), otherBefore);
  assert.ok(next.events.some(item => item.type === "candidate_review_submitted" && item.note.includes("重新录用确认")));
});

test("invitation requires a valid applicant email at the API domain boundary", async () => {
  const { tokenHash } = await newReviewToken();
  for (const email of ["", "invalid-email", "person@example.com\r\nBcc: other@example.com"]) {
    const state = seed(); app(state).snapshot.email = email;
    rejects(() => createCandidateReview(state, hr(state), { applicationId: "application_1", expectedRevision: state.revision }, tokenHash, NOW), "REVIEW_EMAIL_REQUIRED", 422);
    assert.equal(state.reviews, undefined);
  }
});

test("confirming unchanged fields preserves selection reports and an existing hiring decision", async () => {
  const original = seed(), target = app(original);
  target.stage = "interview";
  target.decision = "hire";
  target.decisionNote = "已依据现有证据确认录用";
  target.selection!.hrReview = { createdAt: NOW.toISOString(), actorId: "hr", conclusion: "pass", note: "现有资料已人工核实" };
  original.candidates.find(item => item.id === target.candidateId)!.school = "主档已单独核实的院校";
  const issued = await invite(original), before = app(issued.state);
  const masterBefore = candidateReviewFields(issued.state.candidates.find(item => item.id === before.candidateId)!);
  const fields = readCandidateReview(issued.state, issued.tokenHash, NOW).fields;
  const next = submitCandidateReview(issued.state, issued.tokenHash, { expectedVersion: 0, confirmed: true, fields }, NOW);
  assert.deepEqual(app(next).selection, before.selection);
  assert.equal(app(next).decision, "hire");
  assert.equal(app(next).decisionNote, before.decisionNote);
  assert.equal(app(next).screeningNote, before.screeningNote);
  assert.equal(app(next).stage, before.stage);
  assert.equal(app(next).status, before.status);
  assert.deepEqual(candidateReviewFields(next.candidates.find(item => item.id === before.candidateId)!), masterBefore);
  assert.equal(app(next).snapshot.review!.status, "submitted");
  assert.ok(next.events.some(item => item.type === "candidate_review_submitted" && item.note.includes("原样确认")));
});
