import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState, CandidateReview } from "../lib/domain.ts";
import { createSeed } from "../lib/seed.ts";
import {
  CandidateReviewError,
  candidateReviewSummary,
  createCandidateReview,
  newReviewToken,
  recordCandidateReviewDelivery,
  revokeCandidateReview,
} from "../lib/candidate-review.ts";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const LATER = new Date("2026-10-20T08:01:00.000Z");
const app = (state: AppState, id = "application_1") => state.applications.find(item => item.id === id)!;
const hr = (state: AppState) => state.users.find(item => item.id === "hr")!;
const review = (state: AppState, id: string) => state.reviews!.find(item => item.id === id)! as CandidateReview & { providerMessageId?: string; sentAt?: string };
const person = (state: AppState, applicationId = "application_1") => state.candidates.find(item => item.id === app(state, applicationId).candidateId)!;
async function invite(state = createSeed(NOW), applicationId = "application_1", sendEmail = true) {
  const { tokenHash } = await newReviewToken();
  return createCandidateReview(state, hr(state), { applicationId, expectedRevision: state.revision, sendEmail }, tokenHash, NOW);
}
function rejectsUncertain(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => error instanceof CandidateReviewError && error.code === "REVIEW_DELIVERY_UNCERTAIN" && error.status === 409);
}
function withoutSummary<T extends { review?: unknown }>(value: T) {
  const copy = structuredClone(value);
  delete copy.review;
  return copy;
}

test("preview invitations retain preview delivery and never claim that email was sent", async () => {
  const initial = createSeed(NOW), before = JSON.stringify(initial);
  const created = await invite(initial, "application_1", false);
  assert.equal(created.review.delivery, "preview");
  assert.equal(review(created.state, created.review.reviewId).delivery, "preview");
  assert.match(review(created.state, created.review.reviewId).deliveryReason, /未发送/);
  assert.equal(review(created.state, created.review.reviewId).providerMessageId || "", "");
  assert.equal(review(created.state, created.review.reviewId).sentAt || "", "");
  assert.equal(JSON.stringify(initial), before);
  const replacement = await invite(created.state, "application_1", false);
  assert.equal(replacement.review.delivery, "preview");
  assert.equal(review(replacement.state, created.review.reviewId).status, "revoked");
});

test("real-send invitation starts pending, with no provider acceptance or false sent audit", async () => {
  const created = await invite(), record = review(created.state, created.review.reviewId);
  assert.equal(created.review.delivery, "pending");
  assert.equal(record.delivery, "pending");
  assert.equal(app(created.state).snapshot.review!.delivery, "pending");
  assert.equal(person(created.state).review!.delivery, "pending");
  assert.equal(record.providerMessageId || "", "");
  assert.equal(record.sentAt || "", "");
  assert.doesNotMatch(record.deliveryReason, /已发送|发送成功|投递成功|Gmail 已接受/);
  const createdEvent = created.state.events.findLast(item => item.applicationId === "application_1" && item.type === "candidate_review_created")!;
  assert.ok(createdEvent);
  assert.doesNotMatch(createdEvent.note, /已发送|发送成功|投递成功|Gmail 已接受/);
});

test("sending result maps to pending summary and unknown delivery remains explicitly uncertain", async () => {
  const created = await invite(), id = created.review.reviewId;
  const sending = recordCandidateReviewDelivery(created.state, id, { status: "sending", reason: "邮件服务正在处理请求" }, LATER);
  assert.equal(review(sending, id).delivery, "pending");
  assert.equal(review(sending, id).deliveryReason, "邮件服务正在处理请求");
  assert.equal(app(sending).snapshot.review!.delivery, "pending");
  const unknown = recordCandidateReviewDelivery(sending, id, { status: "unknown", reason: "连接中断，无法确认服务商是否接收" }, LATER);
  assert.equal(review(unknown, id).delivery, "unknown");
  assert.equal(review(unknown, id).deliveryReason, "连接中断，无法确认服务商是否接收");
  assert.equal(app(unknown).snapshot.review!.delivery, "unknown");
  assert.equal(person(unknown).review!.delivery, "unknown");
  assert.equal(review(unknown, id).providerMessageId || "", "");
  assert.equal(review(unknown, id).sentAt || "", "");
});

test("sent delivery without a provider message ID fails without mutating state", async () => {
  const created = await invite(), before = JSON.stringify(created.state);
  for (const messageId of [undefined, "", "   "]) {
    assert.throws(() => recordCandidateReviewDelivery(created.state, created.review.reviewId, { status: "sent", reason: "服务商已接受", messageId, sentAt: LATER.toISOString() }, LATER));
    assert.equal(JSON.stringify(created.state), before);
  }
});

test("provider acceptance records metadata and updates only delivery summaries without changing recruitment facts", async () => {
  const original = createSeed(NOW);
  app(original).stage = "interview";
  app(original).decision = "hire";
  app(original).decisionNote = "用人经理已确认，等待 Offer 操作";
  const created = await invite(original), before = structuredClone(created.state), id = created.review.reviewId;
  const sent = recordCandidateReviewDelivery(created.state, id, { status: "sent", reason: "服务商已接受投递", messageId: "provider-message-1", sentAt: LATER.toISOString() }, LATER);
  const record = review(sent, id);
  assert.equal(record.delivery, "sent");
  assert.equal(record.providerMessageId, "provider-message-1");
  assert.equal(record.sentAt, LATER.toISOString());
  assert.equal(record.deliveryReason, "服务商已接受投递");
  assert.equal(record.status, "pending");
  assert.equal(app(sent).snapshot.review!.reviewId, id);
  assert.equal(app(sent).snapshot.review!.delivery, "sent");
  assert.equal(person(sent).review!.reviewId, id);
  assert.equal(person(sent).review!.delivery, "sent");
  assert.equal(sent.revision, before.revision + 1);
  assert.deepEqual(withoutSummary(person(sent)), withoutSummary(person(before)));
  assert.deepEqual(withoutSummary(app(sent).snapshot), withoutSummary(app(before).snapshot));
  for (const key of ["stage", "status", "outcome", "decision", "decisionNote", "selection", "screeningNote", "offer", "agreement", "joinedAt"] as const) {
    assert.deepEqual(app(sent)[key], app(before)[key], key);
  }
  assert.deepEqual(sent.applications.filter(item => item.id !== "application_1"), before.applications.filter(item => item.id !== "application_1"));
  assert.deepEqual(sent.interviews, before.interviews);
  assert.deepEqual(sent.scorecards, before.scorecards);
  assert.deepEqual(created.state, before);
});

test("failed delivery preserves its reason and does not advance the application", async () => {
  const created = await invite(), id = created.review.reviewId;
  const failed = recordCandidateReviewDelivery(created.state, id, { status: "failed", reason: "邮件服务拒绝收件地址" }, LATER);
  assert.equal(review(failed, id).delivery, "failed");
  assert.equal(review(failed, id).deliveryReason, "邮件服务拒绝收件地址");
  assert.equal(app(failed).snapshot.review!.delivery, "failed");
  assert.equal(person(failed).review!.delivery, "failed");
  assert.equal(app(failed).stage, app(created.state).stage);
  assert.equal(app(failed).status, app(created.state).status);
});

test("late failed or sending callbacks cannot downgrade an accepted delivery", async () => {
  const created = await invite(), id = created.review.reviewId;
  const sent = recordCandidateReviewDelivery(created.state, id, { status: "sent", reason: "服务商已接受", messageId: "provider-message-2", sentAt: NOW.toISOString() }, NOW);
  const before = structuredClone(sent);
  for (const status of ["failed", "sending"] as const) {
    const next = recordCandidateReviewDelivery(sent, id, { status, reason: "迟到的旧状态" }, LATER);
    assert.deepEqual(next, before);
  }
});

test("repeated identical sent and failed terminal results are idempotent across callback times", async () => {
  for (const result of [
    { status: "sent" as const, reason: "服务商已接受", messageId: "provider-message-3", sentAt: NOW.toISOString() },
    { status: "failed" as const, reason: "服务商明确拒绝请求" },
  ]) {
    const created = await invite(), id = created.review.reviewId;
    const first = recordCandidateReviewDelivery(created.state, id, result, NOW);
    const repeated = recordCandidateReviewDelivery(first, id, result, LATER);
    assert.equal(repeated.revision, first.revision);
    assert.deepEqual(repeated, first);
  }
});

test("repeated failed results stay idempotent even when a long provider reason is bounded for storage", async () => {
  const created = await invite(), id = created.review.reviewId;
  const result = { status: "failed" as const, reason: "服务商错误详情。".repeat(100) };
  const first = recordCandidateReviewDelivery(created.state, id, result, NOW);
  const repeated = recordCandidateReviewDelivery(first, id, result, LATER);
  assert.equal(repeated.revision, first.revision);
  assert.deepEqual(repeated, first);
});

test("pending and unknown deliveries block another real-send invitation on the same application", async () => {
  for (const delivery of ["pending", "unknown"] as const) {
    const created = await invite(), id = created.review.reviewId;
    const state = delivery === "pending" ? created.state : recordCandidateReviewDelivery(created.state, id, { status: "unknown", reason: "服务商接收情况待核实" }, LATER);
    const before = JSON.stringify(state), { tokenHash } = await newReviewToken();
    rejectsUncertain(() => createCandidateReview(state, hr(state), { applicationId: "application_1", expectedRevision: state.revision, sendEmail: true }, tokenHash, LATER));
    assert.equal(JSON.stringify(state), before);
  }
});

test("revoking an uncertain invitation allows a new send and late old delivery cannot replace its summaries", async () => {
  const first = await invite(), oldId = first.review.reviewId;
  const uncertain = recordCandidateReviewDelivery(first.state, oldId, { status: "unknown", reason: "投递结果不确定" }, LATER);
  const revoked = revokeCandidateReview(uncertain, hr(uncertain), { applicationId: "application_1", expectedRevision: uncertain.revision }, LATER);
  const second = await invite(revoked), newId = second.review.reviewId;
  assert.notEqual(newId, oldId);
  assert.equal(second.review.delivery, "pending");
  const appSummary = structuredClone(app(second.state).snapshot.review), personSummary = structuredClone(person(second.state).review);
  const late = recordCandidateReviewDelivery(second.state, oldId, { status: "sent", reason: "旧请求迟到的服务商接收回执", messageId: "provider-message-old", sentAt: LATER.toISOString() }, LATER);
  assert.equal(review(late, oldId).status, "revoked");
  assert.equal(review(late, oldId).delivery, "sent");
  assert.equal(review(late, newId).delivery, "pending");
  assert.deepEqual(app(late).snapshot.review, appSummary);
  assert.deepEqual(person(late).review, personSummary);
});

test("a late old receipt produces that invitation's safe response summary without mixing in its replacement", async () => {
  const first = await invite(), oldId = first.review.reviewId;
  const revoked = revokeCandidateReview(first.state, hr(first.state), { applicationId: "application_1", expectedRevision: first.state.revision }, LATER);
  const second = await invite(revoked), newId = second.review.reviewId;
  const replacement = structuredClone(review(second.state, newId));
  const appSummary = structuredClone(app(second.state).snapshot.review), personSummary = structuredClone(person(second.state).review);
  const late = recordCandidateReviewDelivery(second.state, oldId, { status: "sent", reason: "旧邀请的服务商接收回执", messageId: "provider-message-response-old", sentAt: LATER.toISOString() }, LATER);
  const oldReview = review(late, oldId);
  const responseReview = { ...candidateReviewSummary(oldReview), id: oldId };
  assert.equal(responseReview.id, oldId);
  assert.equal(responseReview.reviewId, oldId);
  assert.notEqual(responseReview.reviewId, newId);
  assert.equal(responseReview.status, "revoked");
  assert.equal(responseReview.delivery, "sent");
  assert.equal(responseReview.providerMessageId, "provider-message-response-old");
  assert.equal(responseReview.sentAt, LATER.toISOString());
  assert.deepEqual(Object.keys(responseReview).sort(), ["id", "reviewId", "applicationId", "status", "version", "createdAt", "expiresAt", "submittedAt", "revokedAt", "delivery", "deliveryReason", "providerMessageId", "sentAt"].sort());
  for (const privateField of ["tokenHash", "fields", "candidateAtIssue", "submittedFields", "candidateId", "createdBy"]) {
    assert.equal(Object.hasOwn(responseReview, privateField), false, privateField);
  }
  assert.ok(!JSON.stringify(responseReview).includes(oldReview.tokenHash));
  assert.deepEqual(review(late, newId), replacement);
  assert.equal(review(late, newId).status, "pending");
  assert.equal(review(late, newId).delivery, "pending");
  assert.deepEqual(app(late).snapshot.review, appSummary);
  assert.deepEqual(person(late).review, personSummary);
});

test("different applications may invite the same candidate and delivery cannot overwrite the other application or latest master summary", async () => {
  const first = await invite(), firstApp = app(first.state), firstId = first.review.reviewId;
  const other = first.state.applications.find(item => item.candidateId === firstApp.candidateId && item.id !== firstApp.id)!;
  assert.ok(other);
  other.stage = "screening";
  other.status = "active";
  const second = await invite(first.state, other.id), secondId = second.review.reviewId;
  const otherBefore = structuredClone(app(second.state, other.id)), personSummary = structuredClone(person(second.state).review);
  const sent = recordCandidateReviewDelivery(second.state, firstId, { status: "sent", reason: "岗位一的服务商回执", messageId: "provider-message-other-scope", sentAt: LATER.toISOString() }, LATER);
  assert.equal(app(sent).snapshot.review!.reviewId, firstId);
  assert.equal(app(sent).snapshot.review!.delivery, "sent");
  assert.deepEqual(app(sent, other.id), otherBefore);
  assert.deepEqual(person(sent).review, personSummary);
  assert.equal(person(sent).review!.reviewId, secondId);
});

test("a resolved sent or failed delivery permits an explicit new invitation and revokes the old link", async () => {
  for (const result of [
    { status: "sent" as const, reason: "服务商已接受", messageId: "provider-message-resolved", sentAt: NOW.toISOString() },
    { status: "failed" as const, reason: "服务商明确拒绝请求" },
  ]) {
    const first = await invite(), oldId = first.review.reviewId;
    const resolved = recordCandidateReviewDelivery(first.state, oldId, result, NOW);
    const second = await invite(resolved);
    assert.equal(second.review.delivery, "pending");
    assert.notEqual(second.review.reviewId, oldId);
    assert.equal(review(second.state, oldId).status, "revoked");
  }
});
