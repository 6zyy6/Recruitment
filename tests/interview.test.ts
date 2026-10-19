import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState } from "../lib/domain.ts";
import { applyAction, BusinessError } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";

const NOW = new Date("2026-10-20T02:00:00.000Z");
const fields = {
  round: "专业一面",
  start: "2026-11-26T02:00:00.000Z",
  end: "2026-11-26T03:00:00.000Z",
  interviewerIds: ["interviewer"],
  location: "腾讯会议",
};
const meeting = {
  meetingUrl: "https://meeting.example.com/join/synthetic",
  meetingId: "123 456 789",
  meetingPassword: "246810",
};
function act(state: AppState, input: Record<string, unknown>) {
  return applyAction(
    state,
    state.users.find((user) => user.id === "hr")!,
    { expectedRevision: state.revision, ...input },
    NOW,
  );
}
function schedule(extra: Record<string, unknown> = {}) {
  const state = createSeed(NOW);
  const app = state.applications.find(
    (item) => item.stage === "interview" && item.status === "active",
  )!;
  return act(state, {
    action: "scheduleInterview",
    applicationId: app.id,
    ...fields,
    ...extra,
  });
}
function rejectsCode(input: Record<string, unknown>, code: string) {
  assert.throws(
    () => schedule(input),
    (error: unknown) => error instanceof BusinessError && error.code === code,
  );
}

test("scheduled interviews persist normalized meeting details", () => {
  const state = schedule({
    ...meeting,
    meetingUrl: "https://MEETING.EXAMPLE.COM:443/join/synthetic",
  });
  const interview = state.interviews.at(-1)!;
  assert.equal(interview.meetingUrl, meeting.meetingUrl);
  assert.equal(interview.meetingId, meeting.meetingId);
  assert.equal(interview.meetingPassword, meeting.meetingPassword);
  assert.equal(interview.location, "腾讯会议");
});

test("invalid meeting links are rejected before any interview is created", () => {
  for (const meetingUrl of [
    123,
    { url: meeting.meetingUrl },
    "javascript:alert(1)",
    "http://meeting.example.com/join/123",
    "//meeting.example.com/join/123",
    "not a URL",
    " ",
    "https://",
    "https://user:password@meeting.example.com/join/123",
    "https://meeting.example.com/join/white space",
    "https://meeting.example.com/join/a\nb",
    "https://meeting.example.com/join/\u0000",
    "https://meeting.example.com/" + "a".repeat(2048),
  ]) rejectsCode({ meetingUrl }, "INVALID_MEETING_URL");
});

test("meeting numbers and passwords have bounded lengths", () => {
  rejectsCode({ meetingId: "1".repeat(81) }, "TOO_LONG");
  rejectsCode({ meetingPassword: "a".repeat(101) }, "TOO_LONG");
  const state = schedule({
    meetingId: "1".repeat(80),
    meetingPassword: "a".repeat(100),
  });
  assert.equal(state.interviews.at(-1)!.meetingId?.length, 80);
  assert.equal(state.interviews.at(-1)!.meetingPassword?.length, 100);
});

test("changing only the time preserves meeting details and resets notification", () => {
  let state = schedule(meeting);
  const interviewId = state.interviews.at(-1)!.id;
  state = act(state, { action: "notifyInterview", interviewId });
  state = act(state, {
    action: "rescheduleInterview",
    interviewId,
    start: "2026-11-27T02:00:00.000Z",
    end: "2026-11-27T03:00:00.000Z",
  });
  const interview = state.interviews.at(-1)!;
  assert.equal(interview.meetingUrl, meeting.meetingUrl);
  assert.equal(interview.meetingId, meeting.meetingId);
  assert.equal(interview.meetingPassword, meeting.meetingPassword);
  assert.equal(interview.notified, false);
});

test("meeting details can be changed or explicitly cleared and require renewed notification", () => {
  let state = schedule(meeting);
  const interviewId = state.interviews.at(-1)!.id;
  state = act(state, { action: "notifyInterview", interviewId });
  state = act(state, {
    action: "rescheduleInterview",
    interviewId,
    meetingUrl: "https://meeting.example.com/join/replacement",
    meetingId: "987654321",
    meetingPassword: "",
  });
  let interview = state.interviews.at(-1)!;
  assert.equal(interview.meetingUrl, "https://meeting.example.com/join/replacement");
  assert.equal(interview.meetingId, "987654321");
  assert.equal(interview.meetingPassword, "");
  assert.equal(interview.notified, false);
  state = act(state, {
    action: "rescheduleInterview",
    interviewId,
    meetingUrl: "",
    meetingId: "",
  });
  interview = state.interviews.at(-1)!;
  assert.equal(interview.meetingUrl, "");
  assert.equal(interview.meetingId, "");
});

test("legacy interviews without meeting fields remain editable", () => {
  let state = schedule({ location: meeting.meetingUrl });
  const interview = state.interviews.at(-1)!;
  delete interview.meetingUrl;
  delete interview.meetingId;
  delete interview.meetingPassword;
  state = act(state, {
    action: "rescheduleInterview",
    interviewId: interview.id,
    start: "2026-11-27T02:00:00.000Z",
    end: "2026-11-27T03:00:00.000Z",
  });
  const updated = state.interviews.at(-1)!;
  assert.equal(updated.location, meeting.meetingUrl);
  assert.equal(updated.status, "scheduled");
  assert.equal(updated.meetingUrl || "", "");
});

test("candidate anonymization removes all meeting access details", () => {
  let state = schedule(meeting);
  const interview = state.interviews.at(-1)!;
  Object.assign(interview, meeting);
  const candidateId = state.applications.find(
    (app) => app.id === interview.applicationId,
  )!.candidateId;
  state = act(state, { action: "anonymizeCandidate", candidateId });
  const updated = state.interviews.find((item) => item.id === interview.id)!;
  assert.equal(updated.location, "个人信息已清理");
  assert.ok(!updated.meetingUrl);
  assert.ok(!updated.meetingId);
  assert.ok(!updated.meetingPassword);
});

test("meeting details can be completed on a legacy interview whose unchanged time has passed", () => {
  let state = schedule();
  const interview = state.interviews.at(-1)!;
  Object.assign(interview, {
    start: "2026-10-19T02:00:00.000Z",
    end: "2026-10-19T03:00:00.000Z",
  });
  state = act(state, {
    action: "rescheduleInterview",
    interviewId: interview.id,
    ...meeting,
  });
  const updated = state.interviews.at(-1)!;
  assert.equal(updated.start, "2026-10-19T02:00:00.000Z");
  assert.equal(updated.end, "2026-10-19T03:00:00.000Z");
  assert.equal(updated.meetingUrl, meeting.meetingUrl);
});

test("new interviews and changed interview times cannot be placed in the past", () => {
  const past = {
    start: "2026-10-18T02:00:00.000Z",
    end: "2026-10-18T03:00:00.000Z",
  };
  rejectsCode(past, "PAST_INTERVIEW");
  const state = schedule();
  const interview = state.interviews.at(-1)!;
  Object.assign(interview, {
    start: "2026-10-19T02:00:00.000Z",
    end: "2026-10-19T03:00:00.000Z",
  });
  assert.throws(
    () => act(state, {
      action: "rescheduleInterview",
      interviewId: interview.id,
      ...past,
    }),
    (error: unknown) => error instanceof BusinessError && error.code === "PAST_INTERVIEW",
  );
});

test("safe meeting links normalize HTTPS URLs and reject unsafe or oversized inputs", async () => {
  const { safeMeetingUrl } = await import("../lib/interview.ts");
  assert.equal(
    safeMeetingUrl("https://MEETING.EXAMPLE.COM:443/join/123?invite=1#details"),
    "https://meeting.example.com/join/123?invite=1#details",
  );
  const prefix = "https://meeting.example.com/";
  const maximum = prefix + "a".repeat(2048 - prefix.length);
  assert.equal(safeMeetingUrl(maximum), maximum);
  for (const value of [
    "",
    "http://meeting.example.com/",
    "javascript:alert(1)",
    "https://user@meeting.example.com/",
    "https://:password@meeting.example.com/",
    "https://meeting.example.com/ white-space",
    " https://meeting.example.com/",
    "https://meeting.example.com/\t",
    "https://meeting.example.com/\u007f",
    "https://meeting.example.com/\u0085",
    "https://",
    "//meeting.example.com/",
    maximum + "a",
  ]) assert.equal(safeMeetingUrl(value), "", value);
});
