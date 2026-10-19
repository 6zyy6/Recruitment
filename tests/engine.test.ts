import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState, User } from "../lib/domain.ts";
import { applyAction, BusinessError, projectState } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { parseCsv } from "../lib/csv.ts";

const NOW = new Date("2026-10-19T02:00:00.000Z");
const seed = () => createSeed(NOW);
const account = (state: AppState, userId = "hr") =>
  state.users.find((user) => user.id === userId)!;
function act(state: AppState, input: Record<string, unknown>, userId = "hr") {
  return applyAction(
    state,
    account(state, userId),
    { expectedRevision: state.revision, ...input },
    NOW,
  );
}
function rejectsCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof BusinessError && error.code === code,
  );
}
const candidate = {
  name: "测试候选人",
  email: "new-person@example.com",
  phone: "19988880001",
  school: "同济大学",
  major: "信息管理",
  graduationYear: 2027,
  skills: ["产品规划"],
  resume: "具备需求分析与产品规划实践经验",
  availability: "两周",
};
function newApplication(state: AppState, jobId = "job_1") {
  const next = act(state, { action: "createCandidate", jobId, ...candidate });
  return { state: next, appId: next.applications.at(-1)!.id };
}

// These checks exercise business boundaries, rather than re-stating individual implementation lines.
test("seed has social + campus jobs, 36 people and 42 distinct applications", () => {
  const state = seed();
  assert.equal(state.jobs.length, 8);
  assert.equal(state.candidates.length, 36);
  assert.equal(state.applications.length, 42);
  assert.equal(
    new Set(state.applications.map((app) => `${app.candidateId}:${app.jobId}`))
      .size,
    42,
  );
  assert.ok(state.jobs.some((job) => job.type === "campus"));
  assert.ok(state.jobs.some((job) => job.type === "social"));
  for (const app of state.applications)
    assert.ok(
      state.events.some(
        (event) => event.applicationId === app.id && event.to === "new",
      ),
    );
});

test("optimistic version checks prevent a stale action and errors leave source intact", () => {
  const state = seed(),
    before = JSON.stringify(state);
  rejectsCode(
    () =>
      applyAction(
        state,
        account(state),
        {
          action: "advance",
          applicationId: state.applications[0].id,
          expectedRevision: 0,
        },
        NOW,
      ),
    "REVISION_CONFLICT",
  );
  assert.equal(JSON.stringify(state), before);
});

test("HR cannot publish without manager approval; manager cannot approve another owner", () => {
  let state = act(seed(), {
    action: "createJob",
    title: "新岗位",
    department: "产品",
    location: "上海",
    type: "social",
    headcount: 1,
  });
  const jobId = state.jobs[0].id;
  state = act(state, { action: "jobStatus", jobId, status: "pending" });
  rejectsCode(
    () => act(state, { action: "jobStatus", jobId, status: "open" }),
    "FORBIDDEN",
  );
  const stranger: User = {
    id: "otherManager",
    name: "另一经理",
    role: "manager",
    email: "other@example.com",
  };
  state.users.push(stranger);
  rejectsCode(
    () =>
      act(state, { action: "jobStatus", jobId, status: "open" }, stranger.id),
    "FORBIDDEN",
  );
  state = act(state, { action: "jobStatus", jobId, status: "open" }, "manager");
  assert.equal(state.jobs[0].status, "open");
  rejectsCode(
    () =>
      act(state, { action: "createCandidate", jobId, ...candidate }, "manager"),
    "FORBIDDEN",
  );
});

test("screening requires a human note and stages cannot be skipped", () => {
  const created = newApplication(seed());
  let state = created.state;
  const appId = created.appId;
  state = act(state, { action: "advance", applicationId: appId });
  rejectsCode(
    () => act(state, { action: "advance", applicationId: appId }),
    "REQUIRED",
  );
  state = act(state, {
    action: "advance",
    applicationId: appId,
    note: "相关经历匹配，电话沟通通过",
  });
  assert.equal(state.applications.at(-1)!.stage, "interview");
  rejectsCode(
    () => act(state, { action: "advance", applicationId: appId }),
    "INVALID_TRANSITION",
  );
});

test("duplicate contacts cannot silently merge; explicit CSV linking creates an independent application", () => {
  let state = seed();
  const original = state.candidates[0];
  rejectsCode(
    () =>
      act(state, { action: "createCandidate", jobId: "job_3", ...original }),
    "DUPLICATE_CANDIDATE",
  );
  const csv = `name,email,phone\n${original.name},${original.email},${original.phone}`;
  state = act(state, { action: "importPreview", jobId: "job_3", csv });
  const taskId = state.imports[0].id;
  assert.equal(state.imports[0].rows[0].status, "duplicate");
  state = act(state, {
    action: "importCommit",
    importId: taskId,
    linkDuplicates: true,
  });
  assert.equal(state.candidates.length, 36);
  const created = state.applications.at(-1)!;
  assert.equal(created.candidateId, original.id);
  assert.equal(created.jobId, "job_3");
  const originalApp = state.applications.find(
    (app) => app.candidateId === original.id && app.jobId === "job_1",
  )!;
  state = act(state, { action: "advance", applicationId: created.id });
  assert.equal(
    state.applications.find((app) => app.id === originalApp.id)!.stage,
    "new",
  );
  const count = state.applications.length;
  state = act(state, {
    action: "importCommit",
    importId: taskId,
    linkDuplicates: true,
  });
  assert.equal(state.applications.length, count);
  state = act(state, { action: "importPreview", jobId: "job_3", csv });
  assert.equal(state.imports[0].rows[0].status, "duplicate");
  state = act(state, {
    action: "importCommit",
    importId: state.imports[0].id,
    linkDuplicates: true,
  });
  assert.equal(state.applications.length, count);
});

test("interviewer scope removes other positions, contacts and peer scores before own submission", () => {
  const state = seed(),
    interviewer = account(state, "interviewer");
  state.candidates[0].resume = "联系 new@example.com 或 13812345678";
  state.applications[0].snapshot.resume = state.candidates[0].resume;
  const view = projectState(state, interviewer);
  const allowedAppIds = new Set(
    state.interviews
      .filter((interview) => interview.interviewerIds.includes(interviewer.id))
      .map((i) => i.applicationId),
  );
  assert.ok(view.applications.every((app) => allowedAppIds.has(app.id)));
  assert.ok(view.applications.length < state.applications.length);
  assert.ok(
    view.candidates.every(
      (c) => c.email === "" && c.phone === "" && c.restricted,
    ),
  );
  assert.ok(
    view.applications.every(
      (app) => app.snapshot.email === "" && app.snapshot.phone === "",
    ),
  );
  const pending = state.interviews.find(
    (i) =>
      i.status === "completed" &&
      i.interviewerIds.length === 2 &&
      state.scorecards.some(
        (c) =>
          c.interviewId === i.id &&
          c.userId === interviewer.id &&
          c.status === "draft",
      ),
  )!;
  assert.ok(pending);
  assert.equal(
    view.scorecards.filter(
      (c) => c.interviewId === pending.id && c.userId !== interviewer.id,
    ).length,
    0,
  );
  const ratings = Object.fromEntries(
    state.jobs
      .find(
        (job) =>
          job.id ===
          state.applications.find((a) => a.id === pending.applicationId)!.jobId,
      )!
      .dimensions.map((d) => [d, 4]),
  );
  const next = act(
    state,
    {
      action: "submitScorecard",
      interviewId: pending.id,
      ratings,
      evidence: "提供了清晰的项目证据，独立负责交付",
      recommendation: "建议录用",
    },
    "interviewer",
  );
  assert.equal(
    projectState(next, interviewer).scorecards.filter(
      (c) => c.interviewId === pending.id && c.userId !== interviewer.id,
    ).length,
    1,
  );
});

test("manager sees own jobs; admin has accounts but zero recruitment records and no mutation rights", () => {
  const state = seed();
  state.jobs[0].managerId = "other";
  const managerView = projectState(state, account(state, "manager"));
  assert.ok(!managerView.jobs.some((j) => j.id === "job_1"));
  assert.ok(!managerView.applications.some((a) => a.jobId === "job_1"));
  const view = projectState(state, account(state, "admin"));
  assert.equal(view.users.length, 5);
  for (const key of [
    "jobs",
    "candidates",
    "applications",
    "interviews",
    "scorecards",
    "events",
    "imports",
  ] as const)
    assert.equal(view[key].length, 0);
  rejectsCode(() => act(state, { action: "reset" }, "admin"), "FORBIDDEN");
});

test("submitted scorecards lock, incomplete input fails, and a reasoned return invalidates hiring decision", () => {
  let state = seed();
  const interview = state.interviews.find((i) => i.status === "completed")!;
  const existing = state.scorecards.find(
    (c) => c.interviewId === interview.id && c.userId === "interviewer",
  )!;
  if (existing.status === "submitted")
    state = act(state, {
      action: "returnScorecard",
      scorecardId: existing.id,
      reason: "补充可验证的项目证据",
    });
  rejectsCode(
    () =>
      act(
        state,
        {
          action: "submitScorecard",
          interviewId: interview.id,
          ratings: {},
          evidence: "不全",
          recommendation: "",
        },
        "interviewer",
      ),
    "INCOMPLETE_SCORECARD",
  );
  const dimensions = state.jobs.find(
    (j) =>
      j.id ===
      state.applications.find((a) => a.id === interview.applicationId)!.jobId,
  )!.dimensions;
  state = act(
    state,
    {
      action: "submitScorecard",
      interviewId: interview.id,
      ratings: Object.fromEntries(dimensions.map((d) => [d, 4])),
      evidence: "案例与数据解释清晰，具备必要能力",
      recommendation: "建议录用",
    },
    "interviewer",
  );
  rejectsCode(
    () =>
      act(
        state,
        {
          action: "saveScorecard",
          interviewId: interview.id,
          evidence: "修改提交后的评价",
        },
        "interviewer",
      ),
    "SCORECARD_LOCKED",
  );
  rejectsCode(
    () => act(state, { action: "returnScorecard", scorecardId: existing.id }),
    "REQUIRED",
  );
  state = act(state, {
    action: "returnScorecard",
    scorecardId: existing.id,
    reason: "重新核实证据",
  });
  assert.equal(
    state.scorecards.find((c) => c.id === existing.id)!.status,
    "draft",
  );
});

test("scheduling detects interviewer and cross-job candidate overlaps; cancellation frees the slot", () => {
  const created = newApplication(seed());
  let state = created.state;
  const appId = created.appId;
  state = act(state, { action: "advance", applicationId: appId });
  state = act(state, {
    action: "advance",
    applicationId: appId,
    note: "匹配岗位",
  });
  const fields = {
    round: "专业面试",
    start: "2026-10-26T02:00:00Z",
    end: "2026-10-26T03:00:00Z",
    interviewerIds: ["interviewer"],
    location: "会议室 C",
  };
  state = act(state, {
    action: "scheduleInterview",
    applicationId: appId,
    ...fields,
  });
  const interviewId = state.interviews.at(-1)!.id;
  rejectsCode(
    () =>
      act(state, {
        action: "scheduleInterview",
        applicationId: appId,
        ...fields,
        interviewerIds: ["interviewer2"],
      }),
    "INTERVIEW_CONFLICT",
  );
  const other = state.applications.find(
    (a) => a.stage === "interview" && a.id !== appId,
  )!;
  rejectsCode(
    () =>
      act(state, {
        action: "scheduleInterview",
        applicationId: other.id,
        ...fields,
      }),
    "INTERVIEW_CONFLICT",
  );
  state = act(state, { action: "notifyInterview", interviewId });
  assert.equal(state.interviews.at(-1)!.notified, true);
  state = act(state, {
    action: "rescheduleInterview",
    interviewId,
    start: "2026-10-27T02:00:00Z",
    end: "2026-10-27T03:00:00Z",
  });
  assert.equal(state.interviews.at(-1)!.notified, false);
  state = act(state, {
    action: "interviewStatus",
    interviewId,
    status: "cancelled",
  });
  state = act(state, {
    action: "scheduleInterview",
    applicationId: appId,
    ...fields,
  });
  assert.equal(state.interviews.at(-1)!.status, "scheduled");
});

test("HR and manager can complete a real candidate-to-join workflow with decision/evaluation/contract gates", () => {
  const created = newApplication(seed(), "job_5");
  let state = created.state;
  const appId = created.appId;
  state = act(state, { action: "advance", applicationId: appId });
  state = act(state, {
    action: "advance",
    applicationId: appId,
    note: "电话筛选通过，案例匹配岗位",
  });
  rejectsCode(
    () =>
      act(state, {
        action: "sendOffer",
        applicationId: appId,
        deadline: "2026-10-22T10:00:00Z",
      }),
    "DECISION_REQUIRED",
  );
  state = act(state, {
    action: "scheduleInterview",
    applicationId: appId,
    round: "专业面试",
    start: "2026-10-26T02:00:00Z",
    end: "2026-10-26T03:00:00Z",
    interviewerIds: ["interviewer", "interviewer2"],
    location: "会议室 C",
  });
  const interview = state.interviews.at(-1)!;
  rejectsCode(
    () =>
      act(
        state,
        {
          action: "decision",
          applicationId: appId,
          decision: "hire",
          note: "建议录用",
        },
        "manager",
      ),
    "NO_COMPLETED_INTERVIEW",
  );
  state = act(state, {
    action: "interviewStatus",
    interviewId: interview.id,
    status: "completed",
  });
  rejectsCode(
    () =>
      act(
        state,
        {
          action: "decision",
          applicationId: appId,
          decision: "hire",
          note: "建议录用",
        },
        "manager",
      ),
    "SCORECARDS_PENDING",
  );
  for (const userId of interview.interviewerIds)
    state = act(
      state,
      {
        action: "submitScorecard",
        interviewId: interview.id,
        ratings: { 专业能力: 4, 问题解决: 4, 沟通协作: 5, 岗位匹配: 4 },
        evidence: "讲解了项目成果和本人贡献，可以独立处理复杂问题",
        recommendation: "建议录用",
      },
      userId,
    );
  rejectsCode(
    () =>
      act(state, {
        action: "decision",
        applicationId: appId,
        decision: "hire",
        note: "建议录用",
      }),
    "FORBIDDEN",
  );
  state = act(
    state,
    {
      action: "decision",
      applicationId: appId,
      decision: "hire",
      note: "证据充分，能力匹配",
    },
    "manager",
  );
  state = act(state, {
    action: "sendOffer",
    applicationId: appId,
    deadline: "2026-10-22T10:00:00Z",
    reference: "TEST-001",
  });
  rejectsCode(
    () =>
      act(state, {
        action: "offerResponse",
        applicationId: appId,
        status: "accepted",
      }),
    "REQUIRED",
  );
  state = act(state, {
    action: "offerResponse",
    applicationId: appId,
    status: "accepted",
    plannedJoinDate: "2026-10-19",
  });
  rejectsCode(
    () => act(state, { action: "join", applicationId: appId }),
    "AGREEMENT_REQUIRED",
  );
  state = act(state, {
    action: "agreement",
    applicationId: appId,
    type: "劳动合同",
    status: "signed",
    date: "2026-10-19",
    note: "合同已核验",
  });
  state = act(state, {
    action: "join",
    applicationId: appId,
    status: "joined",
    date: "2026-10-19",
  });
  const app = state.applications.find((a) => a.id === appId)!;
  assert.equal(app.stage, "joined");
  assert.equal(app.status, "joined");
  assert.ok(app.joinedAt);
  assert.ok(
    state.events.some((e) => e.applicationId === appId && e.type === "joined"),
  );
});

test("Offer expiry requires explicit confirmation; future deadline cannot be marked expired", () => {
  let state = seed();
  const expired = state.applications.find(
    (a) =>
      a.offer.status === "sent" && Date.parse(a.offer.deadline) < NOW.getTime(),
  )!;
  assert.equal(expired.status, "active");
  rejectsCode(
    () =>
      act(state, {
        action: "offerResponse",
        applicationId: expired.id,
        status: "accepted",
        plannedJoinDate: "2026-10-20",
      }),
    "OFFER_EXPIRED",
  );
  state = act(state, {
    action: "offerResponse",
    applicationId: expired.id,
    status: "expired",
  });
  assert.equal(
    state.applications.find((a) => a.id === expired.id)!.status,
    "closed",
  );
  const pending = state.applications.find((a) => a.offer.status === "sent")!;
  rejectsCode(
    () =>
      act(state, {
        action: "offerResponse",
        applicationId: pending.id,
        status: "expired",
      }),
    "OFFER_NOT_EXPIRED",
  );
});

test("CSV supports BOM, quoting, embedded line breaks, row validation and idempotent partial import", () => {
  const csv =
    '\uFEFF姓名,邮箱,手机,简历,技能\r\n"甲,乙",fresh@example.com,19999990001,"第一行\n第二行",SQL;Python\r\n无邮箱,bad-email,19999990002,简历,SQL';
  const rows = parseCsv(csv);
  assert.equal(rows[0].name, "甲,乙");
  assert.equal(rows[0].resume, "第一行\n第二行");
  let state = act(seed(), { action: "importPreview", jobId: "job_1", csv });
  const task = state.imports[0];
  assert.equal(task.rows[0].status, "ready");
  assert.equal(task.rows[1].status, "error");
  state = act(state, {
    action: "importCommit",
    importId: task.id,
    linkDuplicates: false,
  });
  assert.equal(state.imports[0].rows[0].status, "success");
  assert.equal(state.imports[0].rows[1].status, "error");
  const count = state.applications.length;
  state = act(state, {
    action: "importCommit",
    importId: task.id,
    linkDuplicates: false,
  });
  assert.equal(state.applications.length, count);
  const imported = state.candidates.find(
    (c) => c.email === "fresh@example.com",
  )!;
  assert.deepEqual(imported.skills, ["SQL", "Python"]);
  assert.throws(() => parseCsv('name,email\n"oops,a@example.com'), /未闭合/);
  assert.equal(
    parseCsv(
      "name,email\n" +
        Array(1000)
          .fill("批次候选人,long-import-address@example.com")
          .join("\n"),
    ).length,
    1000,
  );
  assert.throws(
    () =>
      parseCsv(
        "name,email\n" + Array(1001).fill("甲,a@example.com").join("\n"),
      ),
    /1,000/,
  );
  assert.throws(() => parseCsv("x".repeat(5 * 1024 * 1024 + 1)), /5 MiB/);
});

test("conflicting email and phone identities cannot be merged by an import", () => {
  let state = seed();
  const a = state.candidates[0],
    b = state.candidates[1];
  state = act(state, {
    action: "importPreview",
    jobId: "job_3",
    csv: `name,email,phone\n甲,${a.email},${b.phone}`,
  });
  assert.equal(state.imports[0].rows[0].status, "error");
  assert.match(state.imports[0].rows[0].error, /不同档案/);
});

test("closing cancels pending interviews and anonymous cleanup reaches snapshots, notes and imports", () => {
  let state = seed();
  const app = state.applications.find((a) =>
    state.interviews.some(
      (i) => i.applicationId === a.id && i.status === "scheduled",
    ),
  )!;
  state = act(state, {
    action: "closeApplication",
    applicationId: app.id,
    reason: "候选人主动退出",
  });
  assert.equal(
    state.applications.find((a) => a.id === app.id)!.status,
    "closed",
  );
  assert.ok(
    !state.interviews.some(
      (i) => i.applicationId === app.id && i.status === "scheduled",
    ),
  );
  const person = state.candidates.find((c) => c.id === app.candidateId)!;
  const personal = [person.name, person.email, person.phone];
  state.applications
    .filter((a) => a.candidateId === person.id)
    .forEach((a) => {
      a.screeningNote = personal.join(" ");
      a.decisionNote = personal.join(" ");
    });
  state = act(state, {
    action: "importPreview",
    jobId: "job_2",
    csv: `name,email,phone\n${person.name},${person.email},${person.phone}`,
  });
  state = act(state, { action: "anonymizeCandidate", candidateId: person.id });
  const json = JSON.stringify(state);
  for (const text of personal)
    assert.ok(!json.includes(text), `Personal data remained: ${text}`);
});

test("campus records allow unknown and mismatched graduation years for human verification", () => {
  let state = act(seed(), {
    action: "createCandidate",
    jobId: "job_5",
    ...candidate,
    graduationYear: null,
  });
  assert.equal(state.candidates.at(-1)!.graduationYear, null);
  state = act(state, {
    action: "createCandidate",
    jobId: "job_5",
    ...candidate,
    email: "other-year@example.com",
    phone: "19988880002",
    graduationYear: 2024,
  });
  assert.equal(state.candidates.at(-1)!.graduationYear, 2024);
  const app = state.applications.at(-1)!;
  state = act(state, { action: "advance", applicationId: app.id });
  rejectsCode(
    () => act(state, { action: "advance", applicationId: app.id }),
    "REQUIRED",
  );
  state = act(state, {
    action: "advance",
    applicationId: app.id,
    note: "已人工核实毕业年份，破格进入专业面试",
  });
  assert.equal(state.applications.at(-1)!.stage, "interview");
});

test("explicit candidate association creates independent jobs and is idempotent for the same active application", () => {
  let state = seed();
  const person = state.candidates[0];
  const count = state.candidates.length;
  state = act(state, {
    action: "createCandidate",
    candidateId: person.id,
    jobId: "job_3",
    source: "内推",
  });
  const appId = state.applications.at(-1)!.id;
  assert.equal(state.candidates.length, count);
  assert.equal(state.applications.at(-1)!.candidateId, person.id);
  const appCount = state.applications.length;
  state = act(state, {
    action: "createApplication",
    candidateId: person.id,
    jobId: "job_3",
    source: "内推",
  });
  assert.equal(state.applications.length, appCount);
  assert.equal(state.applications.at(-1)!.id, appId);
});

test("jobs with active applications cannot close until the active pipeline is resolved", () => {
  let state = seed();
  const before = JSON.stringify(state);
  rejectsCode(
    () => act(state, { action: "jobStatus", jobId: "job_1", status: "closed" }),
    "JOB_HAS_ACTIVE_APPLICATIONS",
  );
  assert.equal(JSON.stringify(state), before);
  for (const app of state.applications.filter(
    (a) => a.jobId === "job_1" && a.status === "active",
  ))
    state = act(state, {
      action: "closeApplication",
      applicationId: app.id,
      outcome: "job_closed",
      reason: "招聘需求撤销",
    });
  state = act(state, { action: "jobStatus", jobId: "job_1", status: "closed" });
  assert.equal(state.jobs.find((j) => j.id === "job_1")!.status, "closed");
});

test("social hiring can join without the campus agreement gate; campus hiring still needs its ledger", () => {
  let state = seed();
  const social = state.applications.find(
    (a) =>
      a.stage === "onboarding" &&
      a.agreement.status === "pending" &&
      state.jobs.find((j) => j.id === a.jobId)!.type === "social",
  )!;
  state = act(state, {
    action: "join",
    applicationId: social.id,
    date: "2026-10-19",
  });
  assert.equal(
    state.applications.find((a) => a.id === social.id)!.status,
    "joined",
  );
  const campus = state.applications.find(
    (a) =>
      a.stage === "onboarding" &&
      a.agreement.status === "pending" &&
      state.jobs.find((j) => j.id === a.jobId)!.type === "campus",
  )!;
  rejectsCode(
    () =>
      act(state, {
        action: "join",
        applicationId: campus.id,
        date: "2026-10-19",
      }),
    "AGREEMENT_REQUIRED",
  );
});

test("closed applications keep outcome classification and preserve exact record-error exclusion marker", () => {
  let state = seed();
  const first = state.applications[0],
    second = state.applications[1];
  state = act(state, {
    action: "closeApplication",
    applicationId: first.id,
    outcome: "withdrawn",
    reason: "已接受其他机会",
  });
  assert.equal(state.applications[0].outcome, "候选人退出 · 已接受其他机会");
  state = act(state, {
    action: "closeApplication",
    applicationId: second.id,
    outcome: "录入错误",
    reason: "重复录入用于测试",
  });
  assert.equal(state.applications[1].outcome, "录入错误");
  assert.ok(
    state.events.some(
      (e) =>
        e.applicationId === second.id &&
        e.note === "录入错误 · 重复录入用于测试",
    ),
  );
});
