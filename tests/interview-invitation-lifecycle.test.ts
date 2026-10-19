import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, projectState } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { createInterviewInvitation, readInterviewInvitation, recordInterviewInvitationDelivery, submitInterviewInvitation, InterviewInvitationError } from "../lib/interview-invitation.ts";
import { candidateReviewFields, createCandidateReview, submitCandidateReview } from "../lib/candidate-review.ts";
import type { AppState } from "../lib/domain.ts";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const HASH = "a".repeat(64);
function issued() {
  const state = createSeed(NOW);
  const app = state.applications[0];
  app.stage = "interview";
  app.screeningNote = "HR 已核实岗位匹配并同意面试。";
  delete app.selection;
  state.interviews = [{ id: "lifecycle", applicationId: app.id, round: "专业一面", start: "2026-10-21T08:00:00.000Z", end: "2026-10-21T09:00:00.000Z", interviewerIds: ["interviewer"], location: "上海办公室", status: "scheduled", notified: false }];
  return createInterviewInvitation(state, state.users.find(user => user.id === "hr")!, { interviewId: "lifecycle", expectedRevision: state.revision, requestId: "invite_1e89f8b9-45bb-4d09-b889-70b40a01ab9f" }, HASH, NOW).state;
}
function act(state: AppState, fields: Record<string, unknown>) {
  return applyAction(state, state.users.find(user => user.id === "hr")!, { expectedRevision: state.revision, ...fields }, NOW);
}
function gone(state: AppState) {
  assert.throws(() => readInterviewInvitation(state, HASH, NOW), (error: unknown) => error instanceof InterviewInvitationError && error.status === 410);
}

test("rescheduling and reverting the time never revives a previously issued invitation", () => {
  const first = issued(), previous = first.interviews[0];
  let state = act(first, { action: "rescheduleInterview", interviewId: previous.id, start: "2026-10-22T08:00:00.000Z", end: "2026-10-22T09:00:00.000Z" });
  gone(state);
  assert.ok(state.interviewInvitations![0].revokedAt);
  assert.ok(state.interviews[0].invitation!.revokedAt);
  state = act(state, { action: "rescheduleInterview", interviewId: previous.id, start: previous.start, end: previous.end });
  gone(state);
  assert.equal(state.interviews[0].notified, false);
});

test("changing and restoring a master contact email keeps the old link revoked and qualification snapshot intact", () => {
  const first = issued(), app = first.applications[0];
  const candidate = first.candidates.find(item => item.id === app.candidateId)!;
  let state = act(first, { action: "updateCandidate", candidateId: candidate.id, email: "new-interview-contact@example.com" });
  gone(state);
  assert.equal(state.applications[0].snapshot.email, app.snapshot.email);
  assert.ok(state.interviews[0].invitation!.revokedAt);
  state = act(state, { action: "updateCandidate", candidateId: candidate.id, email: candidate.email });
  gone(state);
});

test("role projections omit token stores and hide invite recipient and candidate reply from non-HR", () => {
  const state = issued();
  for (const user of state.users) {
    const projected = projectState(state, user);
    assert.equal(projected.interviewInvitations, undefined);
    if (user.role !== "hr") assert.ok(projected.interviews.every(item => item.invitation === undefined));
    assert.ok(!JSON.stringify(projected).includes(HASH));
  }
});

test("candidate anonymization clears invitation contacts, replies and token records", () => {
  let state = issued();
  const app = state.applications[0];
  state = act(state, { action: "closeApplication", applicationId: app.id, reason: "合成验收资料关闭", outcome: "withdrawn" });
  state = act(state, { action: "anonymizeCandidate", candidateId: app.candidateId });
  assert.equal(state.interviewInvitations?.length || 0, 0);
  assert.equal(state.interviews[0].invitation, undefined);
  gone(state);
});

test("candidate reschedule reasons stay in the HR summary and never enter shared audit notes", () => {
  const reason = "PRIVATE_CANDIDATE_RESCHEDULE_REASON";
  const state = submitInterviewInvitation(issued(), HASH, { expectedVersion: 0, response: "reschedule_requested", responseNote: reason }, NOW);
  const event = state.events.at(-1)!;
  assert.equal(event.type, "interview_invitation_response");
  assert.match(event.note, /候选人申请改期/);
  assert.ok(!event.note.includes(reason));
  for (const user of state.users) {
    const view = projectState(state, user);
    if (user.role === "hr") assert.equal(view.interviews[0].invitation!.responseNote, reason);
    else assert.ok(!JSON.stringify(view).includes(reason), user.role);
  }
});

test("candidate review email corrections permanently revoke all own interview links without touching another person", () => {
  let state = issued();
  const firstApp = state.applications[0], ownCandidateId = firstApp.candidateId;
  const otherApp = state.applications.find(app => app.candidateId !== ownCandidateId)!;
  const ownOtherApp = state.applications.find(app => app.candidateId === ownCandidateId && app.id !== firstApp.id)!;
  const originalEmail = state.candidates.find(candidate => candidate.id === ownCandidateId)!.email;
  for (const [index, applicationId] of [firstApp.id, ownOtherApp.id, otherApp.id].entries()) {
    const app = state.applications.find(app => app.id === applicationId)!;
    app.stage = "interview";
    app.status = "active";
    app.screeningNote = "HR 已核实并通过筛选。";
    delete app.selection;
    const interview = { ...state.interviews[0], id: `additional_${index}`, applicationId: app.id,
      start: `2026-10-${22 + index}T08:00:00.000Z`, end: `2026-10-${22 + index}T09:00:00.000Z`, invitation: undefined };
    state.interviews.push(interview);
    state = createInterviewInvitation(state, state.users.find(user => user.id === "hr")!, {
      interviewId: interview.id, expectedRevision: state.revision, requestId: `invite_${crypto.randomUUID()}`,
    }, String(index + 1).repeat(64), NOW).state;
  }
  for (const invitation of state.interviewInvitations!) {
    state = recordInterviewInvitationDelivery(state, invitation.id, { status: "sent", reason: "服务商已接受", messageId: `provider_${invitation.interviewId}` }, NOW);
  }
  const otherInterview = structuredClone(state.interviews.find(interview => interview.applicationId === otherApp.id)!);
  const otherInvitation = structuredClone(state.interviewInvitations!.find(invitation => invitation.interviewId === otherInterview.id)!);
  const ownInterviewIds = state.interviews.filter(interview => interview.id !== otherInterview.id).map(interview => interview.id);
  for (const [index, email] of ["review-corrected-contact@example.com", originalEmail].entries()) {
    const tokenHash = index ? "f".repeat(64) : "e".repeat(64);
    state = createCandidateReview(state, state.users.find(user => user.id === "hr")!, {
      applicationId: firstApp.id, expectedRevision: state.revision,
    }, tokenHash, NOW).state;
    const app = state.applications.find(app => app.id === firstApp.id)!;
    state = submitCandidateReview(state, tokenHash, { expectedVersion: 0, confirmed: true,
      fields: { ...candidateReviewFields(app.snapshot), email } }, NOW);
    gone(state);
    assert.ok(state.interviewInvitations!.filter(invitation => ownInterviewIds.includes(invitation.interviewId)).every(invitation => invitation.revokedAt));
    assert.ok(state.interviews.filter(interview => ownInterviewIds.includes(interview.id)).every(interview => interview.invitation!.revokedAt && !interview.notified));
    assert.deepEqual(state.interviews.find(interview => interview.id === otherInterview.id), otherInterview);
    assert.deepEqual(state.interviewInvitations!.find(invitation => invitation.id === otherInvitation.id), otherInvitation);
  }
});

test("candidate review changes that retain the contact email preserve interview invitations", () => {
  let state = issued();
  const interview = structuredClone(state.interviews[0]), invitation = structuredClone(state.interviewInvitations![0]);
  const tokenHash = "e".repeat(64), app = state.applications[0];
  state = createCandidateReview(state, state.users.find(user => user.id === "hr")!, {
    applicationId: app.id, expectedRevision: state.revision,
  }, tokenHash, NOW).state;
  state = submitCandidateReview(state, tokenHash, { expectedVersion: 0, confirmed: true,
    fields: { ...candidateReviewFields(app.snapshot), school: "核对后的院校" } }, NOW);
  assert.deepEqual(state.interviews[0], interview);
  assert.deepEqual(state.interviewInvitations![0], invitation);
  assert.equal(readInterviewInvitation(state, HASH, NOW).invitation.id, invitation.id);
});
