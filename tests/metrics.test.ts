import { test } from "node:test";
import assert from "node:assert/strict";
import { getMetrics } from "../lib/metrics.ts";
import { STAGES, type AppState, type Application } from "../lib/domain.ts";

function fixture(): AppState {
  const state = {
    revision: 1,
    seededAt: "2026-10-01T00:00:00Z",
    users: [],
    jobs: [
      { id: "social", type: "social", batch: "", status: "open" },
      { id: "campus", type: "campus", batch: "2027秋招", status: "open" },
    ],
    candidates: [],
    applications: [],
    interviews: [],
    scorecards: [],
    events: [],
    imports: [],
  } as unknown as AppState;
  const counts = [10, 6, 4, 2, 1, 1];
  for (let n = 0; n < 10; n++) {
    const rank = counts.filter((count) => n < count).length - 1;
    state.applications.push({
      id: `app${n}`,
      candidateId: `person${n === 9 ? 0 : n}`,
      jobId: n < 6 ? "social" : "campus",
      createdAt: "2026-10-01T00:00:00Z",
      outcome: "",
      status: rank === 5 ? "joined" : "active",
      stage: STAGES[rank],
      source: n % 2 ? "校园网申" : "内推",
      snapshot: { name: `测试${n}`, school: "", major: "", skills: [] },
      offer: { status: "none", sentAt: "", answeredAt: "" },
    } as unknown as Application);
    for (let r = 0; r <= rank; r++)
      state.events.push({
        id: `event${n}-${r}`,
        applicationId: `app${n}`,
        actorId: "hr",
        type: "stage",
        from: r ? STAGES[r - 1] : "",
        to: STAGES[r],
        at: `2026-10-0${r + 1}T00:00:00Z`,
        note: "",
      });
  }
  return state;
}

test("same-cohort funnel matches 10/6/4/2/1/1 and nine distinct people", () => {
  const metrics = getMetrics(fixture(), { cutoff: "2026-10-10T00:00:00Z" });
  assert.deepEqual(
    metrics.funnel.map((x) => x.count),
    [10, 6, 4, 2, 1, 1],
  );
  assert.equal(metrics.total, 10);
  assert.equal(metrics.people, 9);
  assert.equal(metrics.joined, 1);
  assert.equal(metrics.funnel[2].conversion, 4 / 6);
});

test("cutoff excludes future stage events and creation date uses exclusive end", () => {
  const state = fixture();
  assert.equal(getMetrics(state, { cutoff: "2026-10-03T12:00:00Z" }).joined, 0);
  assert.deepEqual(
    getMetrics(state, { cutoff: "2026-10-03T12:00:00Z" }).funnel.map(
      (x) => x.count,
    ),
    [10, 6, 4, 0, 0, 0],
  );
  assert.equal(getMetrics(state, { to: "2026-10-01T00:00:00Z" }).total, 0);
  assert.equal(getMetrics(state, { from: "2026-10-01T00:00:00Z" }).total, 10);
});

test("recruitment type and batch filters apply before aggregation", () => {
  const state = fixture();
  assert.equal(getMetrics(state, { type: "social" }).total, 6);
  assert.equal(
    getMetrics(state, { type: "campus", batch: "2027秋招" }).total,
    4,
  );
  assert.equal(getMetrics(state, { type: "campus", batch: "不存在" }).total, 0);
  assert.equal(getMetrics(state, { query: "测试9" }).total, 1);
});

test("empty denominator remains unknown rather than invented zero", () => {
  const metrics = getMetrics(fixture(), { jobId: "missing" });
  assert.equal(metrics.offerAcceptanceRate, null);
  assert.equal(metrics.feedbackRate, null);
  assert.equal(metrics.funnel[0].conversion, null);
  assert.equal(metrics.firstResponseHours, null);
});

test("feedback denominator excludes immature, cancelled, and no-show interviews", () => {
  const state = fixture();
  for (let n = 0; n < 5; n++) {
    state.interviews.push({
      id: `iv${n}`,
      applicationId: "app0",
      round: "一面",
      start: "2026-10-01T00:00:00Z",
      end: n === 1 ? "2026-10-09T20:00:00Z" : "2026-10-01T01:00:00Z",
      interviewerIds: ["interviewer"],
      location: "",
      status: n === 2 ? "cancelled" : n === 3 ? "no_show" : "completed",
      notified: true,
    });
    if (n < 4)
      state.scorecards.push({
        id: `sc${n}`,
        interviewId: `iv${n}`,
        userId: "interviewer",
        ratings: {},
        evidence: "测试证据",
        recommendation: "通过",
        status: "submitted",
        submittedAt: n === 1 ? "2026-10-09T21:00:00Z" : "2026-10-01T02:00:00Z",
      });
  }
  const metrics = getMetrics(state, { cutoff: "2026-10-10T00:00:00Z" });
  assert.equal(metrics.feedbackDue, 2);
  assert.equal(metrics.feedbackTimely, 1);
  assert.equal(metrics.feedbackRate, 0.5);
});
