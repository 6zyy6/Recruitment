import { test } from "node:test";
import assert from "node:assert/strict";
import { getMetrics } from "../lib/metrics.ts";
import { STAGES, type AppState, type Application } from "../lib/domain.ts";
import { applyAction } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";

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

const OFFER_NOW = new Date("2026-10-19T10:00:00Z");
function offerMetrics(state: AppState, applicationIds: string[], cutoff?: string) {
  const metrics = getMetrics({
    ...state,
    applications: state.applications.filter((app) => applicationIds.includes(app.id)),
  }, { cutoff });
  return {
    sent: metrics.offerSent,
    accepted: metrics.offerAccepted,
    rate: metrics.offerAcceptanceRate,
  };
}
function offerAction(state: AppState, input: Record<string, unknown>, at: string) {
  return applyAction(state, state.users.find((user) => user.id === "hr")!, {
    expectedRevision: state.revision,
    ...input,
  }, new Date(at));
}

test("a later withdrawal cannot change an accepted Offer at an earlier cutoff", () => {
  let state = createSeed(OFFER_NOW);
  const app = state.applications.find((item) => item.offer.status === "sent" && Date.parse(item.offer.deadline) > OFFER_NOW.getTime())!;
  state = offerAction(state, {
    action: "offerResponse", applicationId: app.id, status: "accepted", plannedJoinDate: "2026-10-20",
  }, OFFER_NOW.toISOString());
  const cutoff = "2026-10-19T11:00:00Z";
  const before = offerMetrics(state, [app.id], cutoff);
  const withdrawn = offerAction(state, {
    action: "offerResponse", applicationId: app.id, status: "withdrawn", reason: "企业撤回",
  }, "2026-10-19T12:00:00Z");
  const reloaded = JSON.parse(JSON.stringify(withdrawn)) as AppState;
  assert.deepEqual(before, { sent: 1, accepted: 1, rate: 1 });
  assert.deepEqual(offerMetrics(reloaded, [app.id], cutoff), before);
  assert.deepEqual(offerMetrics(reloaded, [app.id], "2026-10-19T12:00:00Z"), {
    sent: 1, accepted: 0, rate: null,
  });
});

test("closing an accepted application preserves its earlier Offer answer without reading audit notes", () => {
  let state = createSeed(OFFER_NOW);
  const app = state.applications.find((item) => item.offer.status === "sent" && Date.parse(item.offer.deadline) > OFFER_NOW.getTime())!;
  state = offerAction(state, {
    action: "offerResponse", applicationId: app.id, status: "accepted", plannedJoinDate: "2026-10-20",
  }, OFFER_NOW.toISOString());
  const closed = offerAction(state, {
    action: "closeApplication", applicationId: app.id, reason: "线下确认结束流程", outcome: "withdrawn",
  }, "2026-10-19T12:00:00Z");
  closed.events.forEach((event) => { event.note = "已清理"; });
  assert.deepEqual(offerMetrics(closed, [app.id], "2026-10-19T11:00:00Z"), {
    sent: 1, accepted: 1, rate: 1,
  });
  assert.deepEqual(offerMetrics(closed, [app.id], "2026-10-19T13:00:00Z"), {
    sent: 1, accepted: 0, rate: null,
  });
});

test("Offer rejection affects the answered denominator while expiry and withdrawal do not", () => {
  let state = createSeed(OFFER_NOW);
  const accepted = state.applications.find((app) => app.offer.status === "accepted")!;
  const pending = state.applications.filter((app) => app.offer.status === "sent").slice(0, 3);
  const ids = [accepted.id, ...pending.map((app) => app.id)];
  const answeredAt = "2026-10-26T10:00:00Z";
  for (const [index, status] of ["rejected", "expired", "withdrawn"].entries()) {
    state = offerAction(state, {
      action: "offerResponse", applicationId: pending[index].id, status, reason: "线下答复登记",
    }, answeredAt);
  }
  assert.deepEqual(offerMetrics(state, ids, "2026-10-25T10:00:00Z"), {
    sent: 4, accepted: 1, rate: 1,
  });
  assert.deepEqual(offerMetrics(state, ids, answeredAt), {
    sent: 4, accepted: 1, rate: 0.5,
  });
});

test("the default current cutoff keeps terminal Offer results out of accepted counts", () => {
  const now = Date.now();
  let state = createSeed(new Date(now - 10 * 86400000));
  const accepted = state.applications.find((app) => app.offer.status === "accepted")!;
  const pending = state.applications.filter((app) => app.offer.status === "sent").slice(0, 3);
  for (const [index, status] of ["rejected", "expired", "withdrawn"].entries()) {
    state = offerAction(state, {
      action: "offerResponse", applicationId: pending[index].id, status,
    }, new Date(now - 3600000).toISOString());
  }
  assert.deepEqual(offerMetrics(state, [accepted.id, ...pending.map((app) => app.id)]), {
    sent: 4, accepted: 1, rate: 0.5,
  });
});

test("legacy seed stage events and Offer snapshots retain their existing statistics", () => {
  const state = createSeed(OFFER_NOW);
  const app = state.applications.find((item) => item.offer.status === "accepted")!;
  assert.ok(!state.events.some((event) => event.applicationId === app.id && event.type === "offer_response"));
  const beforeAnswer = new Date(Date.parse(app.offer.answeredAt) - 1).toISOString();
  assert.deepEqual(offerMetrics(state, [app.id], beforeAnswer), {
    sent: 1, accepted: 0, rate: null,
  });
  assert.deepEqual(offerMetrics(state, [app.id], app.offer.answeredAt), {
    sent: 1, accepted: 1, rate: 1,
  });
  assert.deepEqual(offerMetrics({ ...state, events: [] }, [app.id], app.offer.answeredAt), {
    sent: 1, accepted: 1, rate: 1,
  });
  const offers = state.applications.filter((item) => item.offer.status !== "none");
  assert.deepEqual(offerMetrics(state, offers.map((item) => item.id), OFFER_NOW.toISOString()), {
    sent: offers.length,
    accepted: offers.filter((item) => item.offer.status === "accepted").length,
    rate: 1,
  });
});

test("missing legacy acceptance history does not invent an earlier accepted answer", () => {
  const state = createSeed(OFFER_NOW);
  const app = state.applications.find((item) => item.offer.status === "accepted" && item.status === "active")!;
  const withdrawn = offerAction(state, {
    action: "offerResponse", applicationId: app.id, status: "withdrawn", reason: "企业撤回",
  }, "2026-10-19T12:00:00Z");
  withdrawn.events = withdrawn.events.filter((event) => event.applicationId !== app.id || event.to !== "onboarding");
  assert.deepEqual(offerMetrics(withdrawn, [app.id], "2026-10-19T11:00:00Z"), {
    sent: 1, accepted: 0, rate: null,
  });
});
