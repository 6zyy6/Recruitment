import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState, Interview } from "../lib/domain.ts";
import { createSeed } from "../lib/seed.ts";
import { applyAction } from "../lib/engine.ts";
import { runResumeReview, runRuleReview } from "../lib/selection.ts";
import {
  InterviewInvitationError,
  createInterviewInvitation,
  interviewScheduleKey,
  previewInterviewInvitation,
  readInterviewInvitation,
  recordInterviewInvitationDelivery,
  revokeInterviewInvitation,
  submitInterviewInvitation,
} from "../lib/interview-invitation.ts";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const HASH = "a".repeat(64), OTHER_HASH = "b".repeat(64);
const REQUEST_ID = "invite_1e89f8b9-45bb-4d09-b889-70b40a01ab9f";
const SECOND_ID = "889f7123-2029-4845-919f-d8c604fd9311";
function seed() {
  const state = createSeed(NOW), app = state.applications[0];
  app.stage = "interview";
  app.status = "active";
  app.screeningNote = "HR 已核对岗位要求与候选人材料，筛选通过。";
  delete app.selection;
  state.interviews = [{
    id: "invitation_interview",
    applicationId: app.id,
    round: "专业一面",
    start: "2026-10-21T09:00:00.000Z",
    end: "2026-10-21T10:00:00.000Z",
    location: "腾讯会议",
    meetingUrl: "https://meeting.tencent.com/dm/demo",
    meetingId: "123 456 789",
    meetingPassword: "2468",
    interviewerIds: ["interviewer", "interviewer2"],
    status: "scheduled",
    notified: false,
  }];
  return state;
}
const hr = (state: AppState) => state.users.find(item => item.id === "hr")!;
const input = (state: AppState) => ({ interviewId: state.interviews[0].id, expectedRevision: state.revision, requestId: REQUEST_ID });
const invite = (state = seed(), hash = HASH, id = REQUEST_ID) => createInterviewInvitation(state, hr(state), { ...input(state), requestId: id }, hash, NOW);
function rejects(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, (error: unknown) => error instanceof InterviewInvitationError && error.code === code && (status === undefined || error.status === status));
}
function completedSelection(state: AppState) {
  const app = state.applications[0], job = state.jobs.find(item => item.id === app.jobId)!;
  app.selection = {
    assessments: [],
    ruleReview: runRuleReview(job, app.snapshot, NOW.toISOString()),
    resumeReview: runResumeReview(job, app.snapshot, NOW.toISOString()),
    hrReview: { createdAt: NOW.toISOString(), actorId: "hr", conclusion: "pass", note: "人工核实岗位要求及简历证据后通过。" },
  };
}

test("preview includes the actual schedule and only a response URL placeholder without mutation", () => {
  const state = seed(), before = JSON.stringify(state);
  const preview = previewInterviewInvitation(state, hr(state), input(state), NOW);
  assert.equal(preview.to, state.applications[0].snapshot.email);
  assert.match(preview.subject, /面试邀请.*专业一面/);
  for (const value of ["北京时间", "17:00", "腾讯会议", "123 456 789", "2468", "https://meeting.tencent.com/dm/demo", "{{RESPONSE_URL}}", "发送时生成专属答复链接"])
    assert.ok(preview.text.includes(value), value);
  assert.ok(!preview.text.includes(HASH));
  assert.equal(JSON.stringify(state), before);
});

test("creating an invitation stores only a hash, expires at interview start, and records an audit", () => {
  const state = seed(), before = JSON.stringify(state), created = invite(state);
  assert.equal(created.state.interviewInvitations![0].tokenHash, HASH);
  assert.equal(created.invitation.id, REQUEST_ID);
  assert.equal(created.invitation.delivery, "pending");
  assert.equal(created.invitation.response, "pending");
  assert.equal(created.invitation.expiresAt, state.interviews[0].start);
  assert.equal(created.state.interviews[0].notified, false);
  assert.deepEqual(created.state.interviews[0].invitation, created.invitation);
  assert.equal(created.state.revision, state.revision + 1);
  assert.equal(created.state.events.at(-1)!.type, "interview_invitation_created");
  assert.ok(!JSON.stringify(created.invitation).includes(HASH));
  assert.equal(JSON.stringify(state), before);
  const later = seed();
  later.interviews[0].start = "2026-11-10T08:00:00.000Z";
  later.interviews[0].end = "2026-11-10T09:00:00.000Z";
  assert.equal(Date.parse(invite(later).invitation.expiresAt) - NOW.getTime(), 7 * 86400000);
});

test("HR permission, expected revision and interview lookup are enforced", () => {
  const state = seed();
  for (const user of state.users.filter(item => item.role !== "hr"))
    rejects(() => createInterviewInvitation(state, user, input(state), HASH, NOW), "FORBIDDEN", 403);
  rejects(() => createInterviewInvitation(state, { ...hr(state), id: "forged" }, input(state), HASH, NOW), "FORBIDDEN", 403);
  for (const expectedRevision of [undefined, state.revision - 1, String(state.revision)])
    rejects(() => createInterviewInvitation(state, hr(state), { ...input(state), expectedRevision }, HASH, NOW), "REVISION_CONFLICT", 409);
  rejects(() => createInterviewInvitation(state, hr(state), { ...input(state), interviewId: "missing" }, HASH, NOW), "NOT_FOUND", 404);
});

test("invalid ids, weak hashes and token reuse fail atomically", () => {
  const state = seed(), before = JSON.stringify(state);
  for (const requestId of ["", "arbitrary", "../request", 123, "x".repeat(121)])
    rejects(() => createInterviewInvitation(state, hr(state), { ...input(state), requestId }, HASH, NOW), "INVALID_REQUEST_ID");
  for (const hash of ["", "token", "a".repeat(63), "g".repeat(64)])
    rejects(() => createInterviewInvitation(state, hr(state), input(state), hash, NOW), "INVALID_INVITATION_TOKEN");
  assert.equal(JSON.stringify(state), before);
  const created = invite(state);
  rejects(() => createInterviewInvitation(created.state, hr(created.state), { ...input(created.state), requestId: SECOND_ID }, HASH, NOW), "INVALID_INVITATION_TOKEN");
});

test("only active interview-stage applications with scheduled interviews can be invited", () => {
  for (const status of ["closed", "joined"] as const) {
    const state = seed(); state.applications[0].status = status;
    rejects(() => invite(state), "INVALID_STAGE");
  }
  for (const stage of ["new", "screening", "offer", "onboarding", "joined"] as const) {
    const state = seed(); state.applications[0].stage = stage;
    rejects(() => invite(state), "INVALID_STAGE");
  }
  for (const status of ["completed", "cancelled", "no_show"] as const) {
    const state = seed(); state.interviews[0].status = status;
    rejects(() => invite(state), "INVALID_STAGE");
  }
});

test("new selection reports require current policy plus explicit HR pass; legacy records require a screening note", () => {
  const state = seed();
  state.applications[0].screeningNote = "";
  rejects(() => invite(state), "SCREENING_REQUIRED");
  completedSelection(state);
  assert.equal(invite(state).invitation.delivery, "pending");
  for (const conclusion of ["hold", "reject"] as const) {
    const changed = structuredClone(state); changed.applications[0].selection!.hrReview!.conclusion = conclusion;
    rejects(() => invite(changed), "SCREENING_REQUIRED");
  }
  for (const field of ["ruleReview", "resumeReview", "hrReview"] as const) {
    const changed = structuredClone(state); delete changed.applications[0].selection![field];
    rejects(() => invite(changed), "SCREENING_REQUIRED");
  }
  const changed = structuredClone(state), job = changed.jobs.find(item => item.id === changed.applications[0].jobId)!;
  job.screeningPolicy!.updatedAt = "2026-10-20T08:00:01.000Z";
  rejects(() => invite(changed), "SCREENING_REQUIRED");
});

test("historical interview approvals survive demo reports, assessments and automatic resume requests", () => {
  for (const applicationId of ["application_17", "application_18"]) {
    let state = createSeed(NOW);
    const interview = state.interviews.find(item => item.applicationId === applicationId && item.status === "scheduled")!;
    Object.assign(interview, { start: "2026-10-21T09:00:00.000Z", end: "2026-10-21T10:00:00.000Z" });
    state.interviews = [interview];
    const before = JSON.stringify(state);
    assert.match(previewInterviewInvitation(state, hr(state), input(state), NOW).subject, /面试邀请/);
    assert.equal(invite(state).invitation.delivery, "pending");
    assert.equal(JSON.stringify(state), before);

    const selection = structuredClone(state.applications.find(item => item.id === applicationId)!.selection);
    state = applyAction(state, hr(state), { action: "ensure_resume_review", applicationId, expectedRevision: state.revision }, NOW);
    assert.deepEqual(state.applications.find(item => item.id === applicationId)!.selection, selection);
    assert.equal(invite(state).invitation.delivery, "pending");

    state = applyAction(state, hr(state), { action: "run_screening", applicationId, expectedRevision: state.revision }, NOW);
    rejects(() => invite(state), "SCREENING_REQUIRED");
  }
});

test("historical screening compatibility still rejects past interview schedules", () => {
  const state = createSeed(NOW);
  state.interviews = [state.interviews.find(item => item.applicationId === "application_17" && item.status === "scheduled")!];
  rejects(() => invite(state), "INVALID_SCHEDULE");
});

test("email, future schedule, duration, location and valid interviewers are required", () => {
  for (const email of ["", "broken", "candidate@example.com\nBcc:other@example.com", "a".repeat(250) + "@ex.com"]) {
    const state = seed(); state.candidates.find(item => item.id === state.applications[0].candidateId)!.email = email;
    rejects(() => invite(state), "INVITATION_EMAIL_REQUIRED");
  }
  for (const patch of [
    { start: "invalid" }, { end: "invalid" }, { start: NOW.toISOString() },
    { start: "2026-10-19T08:00:00.000Z" }, { end: "2026-10-21T08:00:00.000Z" },
    { end: "2026-10-21T18:00:00.000Z" }, { location: " " }, { round: "" },
  ]) {
    const state = seed(); Object.assign(state.interviews[0], patch);
    rejects(() => invite(state), "INVALID_SCHEDULE");
  }
  for (const interviewerIds of [[], ["hr"], ["missing"]]) {
    const state = seed(); state.interviews[0].interviewerIds = interviewerIds;
    rejects(() => invite(state), "INVALID_INTERVIEWER");
  }
});

test("overlapping interviewer or candidate appointments prevent invitation; adjacent appointments pass", () => {
  const state = seed(), current = state.interviews[0];
  state.interviews.push({ ...current, id: "other", applicationId: state.applications[1].id });
  rejects(() => invite(state), "INTERVIEW_CONFLICT", 409);
  state.interviews[1].interviewerIds = ["manager"];
  state.interviews[1].applicationId = current.applicationId;
  rejects(() => invite(state), "INTERVIEW_CONFLICT", 409);
  state.interviews[1].start = current.end;
  state.interviews[1].end = "2026-10-21T11:00:00.000Z";
  assert.equal(invite(state).invitation.delivery, "pending");
});

test("duplicate requests and pending, sent or uncertain current invitations cannot create a second send", () => {
  const first = invite();
  rejects(() => invite(first.state, OTHER_HASH), "DUPLICATE_REQUEST", 409);
  for (const status of ["sending", "sent", "unknown"] as const) {
    const state = recordInterviewInvitationDelivery(first.state, REQUEST_ID, { status, reason: status }, NOW);
    rejects(() => invite(state, OTHER_HASH, SECOND_ID), "INVITATION_EXISTS", 409);
  }
  const before = JSON.stringify(first.state);
  rejects(() => invite(first.state, OTHER_HASH, SECOND_ID), "INVITATION_EXISTS", 409);
  assert.equal(JSON.stringify(first.state), before);
});

test("failed invitation can be retried and every prior link is revoked", () => {
  const first = invite();
  const failed = recordInterviewInvitationDelivery(first.state, REQUEST_ID, { status: "failed", reason: "邮箱服务拒绝" }, NOW);
  assert.equal(failed.interviews[0].notified, false);
  rejects(() => readInterviewInvitation(failed, HASH, NOW), "INVITATION_GONE", 410);
  const second = invite(failed, OTHER_HASH, SECOND_ID);
  assert.equal(second.state.interviewInvitations!.length, 2);
  assert.equal(second.state.interviewInvitations![0].revokedAt, NOW.toISOString());
  assert.equal(second.state.interviews[0].invitation!.id, SECOND_ID);
  rejects(() => readInterviewInvitation(second.state, HASH, NOW), "INVITATION_GONE", 410);
  assert.equal(readInterviewInvitation(second.state, OTHER_HASH, NOW).invitation.id, SECOND_ID);
});

test("candidate view exposes only the minimal invitation and appointment fields", () => {
  const issued = invite();
  issued.state.applications[0].screeningNote = "HR_PRIVATE_EVIDENCE";
  issued.state.applications[0].snapshot.resume = "RAW_RESUME_PRIVATE";
  const view = readInterviewInvitation(issued.state, HASH, NOW);
  assert.deepEqual(Object.keys(view).sort(), ["candidateName", "interview", "invitation", "jobTitle"]);
  assert.deepEqual(Object.keys(view.invitation).sort(), ["expiresAt", "id", "respondedAt", "response", "responseNote", "version"]);
  assert.deepEqual(Object.keys(view.interview).sort(), ["end", "location", "meetingId", "meetingPassword", "meetingUrl", "round", "start"]);
  for (const secret of [HASH, "HR_PRIVATE_EVIDENCE", "RAW_RESUME_PRIVATE", "interviewerIds", "createdBy", "tokenHash", "candidateId", "scorecards", "decision"])
    assert.ok(!JSON.stringify(view).includes(secret), secret);
});

test("expired, revoked, altered schedule, closed application or invalid token links return Gone", () => {
  const issued = invite();
  rejects(() => readInterviewInvitation(issued.state, OTHER_HASH, NOW), "INVITATION_GONE", 410);
  rejects(() => readInterviewInvitation(issued.state, HASH, new Date(issued.invitation.expiresAt)), "INVITATION_GONE", 410);
  const cases: Array<(state: AppState) => void> = [
    state => { state.interviewInvitations![0].revokedAt = NOW.toISOString(); },
    state => { state.interviews[0].round = "第二轮"; },
    state => { state.interviews[0].location = "办公室"; },
    state => { state.interviews[0].meetingUrl = "https://meeting.example.com/new"; },
    state => { state.interviews[0].meetingId = "987"; },
    state => { state.interviews[0].meetingPassword = "987"; },
    state => { state.interviews[0].interviewerIds = ["interviewer"]; },
    state => { state.interviews[0].status = "cancelled"; },
    state => { state.applications[0].status = "closed"; },
    state => { state.applications[0].stage = "offer"; },
    state => { state.interviews = []; },
    state => { state.jobs = []; },
  ];
  for (const change of cases) {
    const state = structuredClone(issued.state); change(state);
    rejects(() => readInterviewInvitation(state, HASH, NOW), "INVITATION_GONE", 410);
    rejects(() => submitInterviewInvitation(state, HASH, { expectedVersion: 0, response: "confirmed" }, NOW), "INVITATION_GONE", 410);
  }
});

test("schedule keys include all meeting details and ignore interviewer order", () => {
  const interview = seed().interviews[0];
  assert.equal(interviewScheduleKey(interview), interviewScheduleKey({ ...interview, interviewerIds: [...interview.interviewerIds].reverse() }));
  for (const field of ["start", "end", "round", "location", "meetingUrl", "meetingId", "meetingPassword"] as const)
    assert.notEqual(interviewScheduleKey(interview), interviewScheduleKey({ ...interview, [field]: "changed" } as Interview));
});

test("candidate response validates version and input atomically", () => {
  const issued = invite(), before = JSON.stringify(issued.state);
  for (const expectedVersion of [undefined, "0", -1, 1])
    rejects(() => submitInterviewInvitation(issued.state, HASH, { expectedVersion, response: "confirmed" }, NOW), "VERSION_CONFLICT", 409);
  for (const response of ["pending", "rejected", "", null])
    rejects(() => submitInterviewInvitation(issued.state, HASH, { expectedVersion: 0, response }, NOW), "INVALID_RESPONSE");
  for (const responseNote of ["", "1234", "a".repeat(1001)])
    rejects(() => submitInterviewInvitation(issued.state, HASH, { expectedVersion: 0, response: "reschedule_requested", responseNote }, NOW), "INVALID_RESPONSE_NOTE");
  assert.equal(JSON.stringify(issued.state), before);
});

test("confirmation and reschedule requests lock the response without changing the actual schedule or hiring stage", () => {
  for (const response of ["confirmed", "reschedule_requested"] as const) {
    const issued = invite(), original = issued.state.interviews[0];
    const next = submitInterviewInvitation(issued.state, HASH, { expectedVersion: 0, response, responseNote: response === "reschedule_requested" ? "当天考试冲突，申请改期。" : "" }, NOW);
    assert.equal(next.interviews[0].invitation!.response, response);
    assert.equal(next.interviews[0].invitation!.version, 1);
    assert.equal(next.interviews[0].start, original.start);
    assert.equal(next.interviews[0].end, original.end);
    assert.equal(next.interviews[0].status, "scheduled");
    assert.equal(next.applications[0].stage, "interview");
    assert.equal(next.events.at(-1)!.actorId, "candidate");
    assert.equal(next.revision, issued.state.revision + 1);
    assert.equal(readInterviewInvitation(next, HASH, NOW).invitation.response, response);
    rejects(() => submitInterviewInvitation(next, HASH, { expectedVersion: 1, response: "confirmed" }, NOW), "INVITATION_LOCKED", 409);
  }
});

test("delivery results update the summary; only sent marks notified and later timeouts cannot downgrade sent", () => {
  const issued = invite();
  for (const status of ["sending", "unknown", "failed"] as const) {
    const state = recordInterviewInvitationDelivery(issued.state, REQUEST_ID, { status, reason: "邮箱服务结果" }, NOW);
    assert.equal(state.interviews[0].notified, false);
    assert.equal(state.interviews[0].invitation!.delivery, status === "sending" ? "pending" : status);
    assert.equal(state.revision, issued.state.revision + 1);
  }
  const sent = recordInterviewInvitationDelivery(issued.state, REQUEST_ID, { status: "sent", reason: "发送成功", messageId: "mail_1", sentAt: NOW.toISOString() }, NOW);
  assert.equal(sent.interviews[0].notified, true);
  assert.equal(sent.interviews[0].invitation!.providerMessageId, "mail_1");
  assert.equal(sent.interviews[0].invitation!.sentAt, NOW.toISOString());
  const late = recordInterviewInvitationDelivery(sent, REQUEST_ID, { status: "unknown", reason: "超时" }, NOW);
  assert.deepEqual(late, sent);
  rejects(() => recordInterviewInvitationDelivery(sent, "missing", { status: "sent", reason: "" }, NOW), "NOT_FOUND", 404);
  rejects(() => recordInterviewInvitationDelivery(issued.state, REQUEST_ID, { status: "sent", reason: "", sentAt: "bad" }, NOW), "INVALID_DELIVERY");
});

test("old delivery callbacks cannot replace a newer invitation summary or mark a changed schedule notified", () => {
  const first = invite();
  first.state.interviews[0].start = "2026-10-22T09:00:00.000Z";
  first.state.interviews[0].end = "2026-10-22T10:00:00.000Z";
  const staleResult = recordInterviewInvitationDelivery(first.state, REQUEST_ID, { status: "sent", reason: "旧邮件已发送" }, NOW);
  assert.equal(staleResult.interviews[0].notified, false);
  const second = invite(first.state, OTHER_HASH, SECOND_ID);
  const late = recordInterviewInvitationDelivery(second.state, REQUEST_ID, { status: "sent", reason: "旧邮件回调" }, NOW);
  assert.equal(late.interviews[0].invitation!.id, SECOND_ID);
  assert.equal(late.interviews[0].invitation!.delivery, "pending");
  assert.equal(late.interviews[0].notified, false);
});

test("HR can revoke pending, sent or uncertain invitations and explicitly recover by sending a new invitation", () => {
  for (const status of ["sending", "sent", "unknown"] as const) {
    const issued = invite();
    const state = recordInterviewInvitationDelivery(issued.state, REQUEST_ID, { status, reason: status }, NOW);
    const before = JSON.stringify(state);
    for (const user of state.users.filter(item => item.role !== "hr"))
      rejects(() => revokeInterviewInvitation(state, user, input(state), NOW), "FORBIDDEN", 403);
    rejects(() => revokeInterviewInvitation(state, hr(state), { ...input(state), expectedRevision: -1 }, NOW), "REVISION_CONFLICT", 409);
    const next = revokeInterviewInvitation(state, hr(state), input(state), NOW);
    assert.equal(next.interviews[0].notified, false);
    assert.equal(next.interviews[0].invitation!.revokedAt, NOW.toISOString());
    assert.equal(next.interviews[0].invitation!.version, 1);
    assert.match(next.events.at(-1)!.note, /先核查 Gmail/);
    assert.equal(next.revision, state.revision + 1);
    rejects(() => readInterviewInvitation(next, HASH, NOW), "INVITATION_GONE", 410);
    assert.equal(invite(next, OTHER_HASH, SECOND_ID).invitation.id, SECOND_ID);
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(revokeInterviewInvitation(next, hr(next), input(next), NOW), next);
  }
});

test("a changed main-record contact email is used for preview and resend while the old invitation becomes invalid", () => {
  const issued = invite(), state = issued.state;
  const candidate = state.candidates.find(item => item.id === state.applications[0].candidateId)!;
  const oldEmail = state.applications[0].snapshot.email;
  candidate.email = "updated-contact@example.com";
  assert.equal(previewInterviewInvitation(state, hr(state), input(state), NOW).to, candidate.email);
  assert.equal(state.applications[0].snapshot.email, oldEmail);
  assert.equal(state.interviews[0].invitation!.to, oldEmail);
  rejects(() => readInterviewInvitation(state, HASH, NOW), "INVITATION_GONE", 410);
  rejects(() => submitInterviewInvitation(state, HASH, { expectedVersion: 0, response: "confirmed" }, NOW), "INVITATION_GONE", 410);
  const next = invite(state, OTHER_HASH, SECOND_ID);
  assert.equal(next.invitation.to, candidate.email);
  assert.equal(next.state.interviewInvitations![0].revokedAt, NOW.toISOString());
  assert.equal(next.state.applications[0].snapshot.email, oldEmail);
  assert.equal(readInterviewInvitation(next.state, OTHER_HASH, NOW).invitation.id, SECOND_ID);
  const missing = seed(); missing.applications[0].snapshot.email = "";
  assert.equal(invite(missing).invitation.to, missing.candidates.find(item => item.id === missing.applications[0].candidateId)!.email);
});

test("repeated unknown, failed and sent receipts are idempotent after normalization", () => {
  for (const status of ["unknown", "failed", "sent"] as const) {
    const issued = invite();
    const receipt = { status, reason: " 固定发送结果 ", messageId: " provider_1 " };
    const first = recordInterviewInvitationDelivery(issued.state, REQUEST_ID, receipt, NOW);
    const later = new Date(NOW.getTime() + 60000);
    assert.equal(recordInterviewInvitationDelivery(first, REQUEST_ID, receipt, later), first);
    assert.equal(recordInterviewInvitationDelivery(first, REQUEST_ID, { status, reason: "固定发送结果" }, later), first);
    assert.equal(first.events.length, issued.state.events.length + 1);
  }
  const issued = invite();
  const receipt = { status: "unknown" as const, reason: "很".repeat(1100), messageId: "m".repeat(300) };
  const first = recordInterviewInvitationDelivery(issued.state, REQUEST_ID, receipt, NOW);
  assert.equal(first.interviews[0].invitation!.deliveryReason.length, 1000);
  assert.equal(first.interviews[0].invitation!.providerMessageId!.length, 254);
  assert.equal(recordInterviewInvitationDelivery(first, REQUEST_ID, receipt, NOW), first);
});
