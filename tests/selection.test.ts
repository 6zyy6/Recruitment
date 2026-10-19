import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState, AssessmentKind, SelectionReport } from "../lib/domain.ts";
import { applyAction, BusinessError, projectState } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { parseCsv } from "../lib/csv.ts";
import {
  initialScreeningReady,
  runResumeReview,
  runRuleReview,
  screeningPolicy,
} from "../lib/selection.ts";

const NOW = new Date("2026-10-20T02:00:00.000Z");
const seed = () => createSeed(NOW);
function act(
  state: AppState,
  action: string,
  fields: Record<string, unknown> = {},
  userId = "hr",
) {
  return applyAction(
    state,
    state.users.find((user) => user.id === userId)!,
    { action, expectedRevision: state.revision, ...fields },
    NOW,
  );
}
function rejectsCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof BusinessError && error.code === code,
  );
}
const appOf = (state: AppState, appId = "application_1") =>
  state.applications.find((app) => app.id === appId)!;
const policy = {
  jobId: "job_1",
  minimumEducation: "bachelor",
  requiredSkills: ["SQL", "用户研究"],
  graduationYears: [2027],
};
function fresh(): AppState {
  const state = seed();
  state.applications.forEach((app) => {
    delete app.selection;
  });
  return state;
}
function reviewed(state: AppState, applicationId = "application_1") {
  const next = act(state, "run_screening", { applicationId }),
    app = appOf(next, applicationId);
  // Unit fixtures supply a completed report; production completion happens asynchronously.
  app.selection!.resumeReview = completedModelReport(next, applicationId);
  return next;
}
function completedModelReport(state: AppState, applicationId: string): SelectionReport {
  const app = appOf(state, applicationId),
    job = state.jobs.find((item) => item.id === app.jobId)!;
  return {
    createdAt: NOW.toISOString(), kind: "resume", mode: "llm", model: "test-fixture",
    title: "简历复筛测试响应", summary: "简历提供了项目经历，个人职责和结果仍需人工核实。",
    score: null, maxScore: null,
    evidence: [{ label: "项目经历", status: "matched", quote: app.snapshot.resume.slice(0, 100) }],
    gaps: ["个人贡献仍需面试核实"], questions: ["请说明个人承担的职责及可核实的结果。"],
    disclaimer: "此为单元测试的结构化模型响应样本，未发起网络请求。",
    policy: screeningPolicy(job),
  };
}
function assign(
  state: AppState,
  kind: AssessmentKind,
  applicationId = "application_1",
) {
  const next = act(state, "assign_assessment", { applicationId, kind });
  return {
    state: next,
    task: appOf(next, applicationId).selection!.assessments.at(-1)!,
  };
}
const writtenAnswers = {
  priority: "b",
  evidence: "c",
  plan: "先记录当前业务的基线与约束，约定可观测指标，设计小规模对照进行验证，并在完成后复盘结果。",
};

test("V1 persisted objects without new fields remain usable and are not reset", () => {
  let state = fresh();
  state.jobs.forEach((job) => {
    delete job.screeningPolicy;
  });
  state.candidates.forEach((person) => {
    delete person.education;
  });
  state.applications.forEach((app) => {
    delete app.snapshot.education;
  });
  const ids = state.applications.map((app) => app.id),
    initial = state.revision;
  state = act(state, "run_screening", { applicationId: "application_1" });
  assert.deepEqual(
    state.applications.map((app) => app.id),
    ids,
  );
  assert.equal(state.revision, initial + 1);
  assert.equal(appOf(state).status, "active");
  assert.equal(appOf(state).selection!.ruleReview!.mode, "rule_demo");
  state = act(state, "advance", { applicationId: "application_1" });
  assert.equal(appOf(state).stage, "screening");
});

test("new intake automatically screens the application snapshot against its own job without fabricating AI results", () => {
  let state = act(seed(), "createCandidate", {
    jobId: "job_1",
    name: "自动初筛测试",
    email: "automatic-screening@example.com",
    education: "bachelor",
    skills: ["产品规划", "用户研究"],
    resume: "负责产品规划与用户研究，推动团队项目交付。",
  });
  const first = state.applications.at(-1)!,
    original = structuredClone(first);
  assert.deepEqual(first.selection!.ruleReview!.policy, screeningPolicy(state.jobs[0]));
  assert.equal(initialScreeningReady(first.selection!.ruleReview), true);
  assert.equal(first.selection!.resumeReview, undefined);
  assert.equal(first.selection!.hrReview, undefined);
  assert.equal(first.stage, "new");
  rejectsCode(() => act(state, "confirm_screening", {
    applicationId: first.id, conclusion: "pass", note: "不能跳过真实 AI 报告直接通过",
  }), "SELECTION_REVIEW_REQUIRED");

  state = act(state, "updateCandidate", {
    candidateId: first.candidateId,
    skills: ["React", "TypeScript"],
    resume: "负责 React 和 TypeScript 项目开发。",
  });
  state = act(state, "createApplication", { candidateId: first.candidateId, jobId: "job_2" });
  const second = state.applications.at(-1)!;
  assert.deepEqual(second.selection!.ruleReview!.policy, screeningPolicy(state.jobs[1]));
  assert.equal(initialScreeningReady(second.selection!.ruleReview), true);
  assert.match(second.snapshot.resume, /React/);
  assert.deepEqual(appOf(state, first.id).snapshot, original.snapshot);
  assert.deepEqual(appOf(state, first.id).selection, original.selection);

  state = act(state, "importPreview", {
    jobId: "job_1", csv: "name,email,education,skills\n导入初筛测试,automatic-import@example.com,bachelor,产品规划",
  });
  state = act(state, "importCommit", { importId: state.imports[0].id, linkDuplicates: false });
  const imported = state.applications.at(-1)!;
  assert.ok(imported.selection!.ruleReview);
  assert.equal(initialScreeningReady(imported.selection!.ruleReview), true);
  assert.equal(imported.snapshot.resume, "");
  assert.equal(imported.selection!.resumeReview, undefined);
  assert.equal(imported.status, "active");
});

test("CSV intake without listed skills queues only applications with resume text and preserves initial findings", () => {
  let state = act(fresh(), "configure_screening", policy);
  state = act(state, "importPreview", {
    jobId: "job_1",
    csv: "name,email,education,resume\n有正文待复筛,with-resume@example.com,unknown,参与过相关项目，详细职责待核实\n无正文待补充,without-resume@example.com,unknown,",
  });
  state = act(state, "importCommit", { importId: state.imports[0].id, linkDuplicates: false });
  const imported = state.applications.filter((app) => ["with-resume@example.com", "without-resume@example.com"].includes(app.snapshot.email));
  assert.equal(imported.length, 2);
  for (const app of imported) {
    const initial = structuredClone(app.selection!.ruleReview);
    assert.deepEqual(app.snapshot.skills, []);
    assert.ok(initial!.evidence.some((item) => item.label.includes("必备技能") && item.status === "unknown"));
    assert.match(initial!.summary, /未知/);
    const requested = act(state, "ensure_resume_review", { applicationId: app.id });
    const after = appOf(requested, app.id);
    assert.equal(after.selection!.aiReview!.status, app.snapshot.resume ? "pending" : "blocked");
    if (!app.snapshot.resume) assert.match(after.selection!.aiReview!.message, /上传或填写简历文本/);
    assert.deepEqual(after.selection!.ruleReview, initial);
    assert.equal(after.selection!.resumeReview, undefined);
    assert.equal(after.selection!.hrReview, undefined);
    assert.equal(after.stage, "new");
    assert.equal(after.status, "active");
    rejectsCode(() => act(requested, "confirm_screening", {
      applicationId: app.id, conclusion: "pass", note: "仍需真实复筛报告与人工判断",
    }), "SELECTION_REVIEW_REQUIRED");
  }
});

test("screening configuration validates input and role, without rewriting historical reports", () => {
  let state = seed();
  const oldReport = structuredClone(appOf(state).selection!.ruleReview);
  for (const userId of ["manager", "interviewer", "admin"])
    rejectsCode(
      () => act(state, "configure_screening", policy, userId),
      "FORBIDDEN",
    );
  rejectsCode(
    () =>
      act(state, "configure_screening", {
        ...policy,
        minimumEducation: "famous_school",
      }),
    "INVALID_EDUCATION",
  );
  rejectsCode(
    () =>
      act(state, "configure_screening", { ...policy, requiredSkills: [" "] }),
    "INVALID_SKILLS",
  );
  rejectsCode(
    () =>
      act(state, "configure_screening", {
        ...policy,
        graduationYears: ["2027"],
      }),
    "INVALID_YEAR",
  );
  state = act(state, "configure_screening", {
    ...policy,
    requiredSkills: ["SQL", "SQL", " 用户研究 "],
  });
  assert.deepEqual(state.jobs[0].screeningPolicy!.requiredSkills, [
    "SQL",
    "用户研究",
  ]);
  assert.deepEqual(appOf(state).selection!.ruleReview, oldReport);
  assert.ok(state.events.some((event) => event.type === "configure_screening"));
});

test("missing skill or education evidence is unknown; explicit education/year mismatch is informational only", () => {
  let state = act(fresh(), "configure_screening", policy);
  const app = appOf(state);
  app.snapshot.education = "unknown";
  app.snapshot.graduationYear = null;
  app.snapshot.skills = [];
  app.snapshot.resume = "尚待补充项目资料";
  state = act(state, "run_screening", { applicationId: app.id });
  const result = appOf(state).selection!.ruleReview!;
  assert.equal(result.score, null);
  assert.equal(result.maxScore, null);
  assert.ok(result.evidence.every((item) => item.status === "unknown"));
  assert.equal(appOf(state).status, "active");
  assert.equal(appOf(state).stage, "new");
  appOf(state).snapshot.education = "college";
  appOf(state).snapshot.graduationYear = 2024;
  state = act(state, "run_screening", { applicationId: app.id });
  const mismatch = appOf(state).selection!.ruleReview!;
  assert.equal(mismatch.evidence[0].status, "missing");
  assert.equal(mismatch.evidence.at(-1)!.status, "missing");
  assert.equal(appOf(state).status, "active");
});

test("screening quotes only candidate fields, is job-specific and treats degree text as field data", () => {
  const state = seed(),
    job = state.jobs[0],
    snapshot = structuredClone(appOf(state).snapshot);
  job.screeningPolicy = {
    ...policy,
    updatedAt: NOW.toISOString(),
    minimumEducation: "bachelor",
  };
  snapshot.education = "本科";
  snapshot.skills = ["SQL"];
  snapshot.resume = "实际原文：参与用户研究，并记录访谈结论。";
  snapshot.graduationYear = 2027;
  const result = runRuleReview(job, snapshot, NOW.toISOString());
  assert.equal(result.evidence[0].status, "matched");
  assert.ok(result.evidence.some((item) => item.quote === "技能字段：SQL"));
  assert.ok(
    result.evidence.some((item) => item.quote.includes(snapshot.resume)),
  );
  assert.ok(!JSON.stringify(result).includes("已验证其能力合格"));
  assert.deepEqual(result.policy, screeningPolicy(job));
});

test("legacy resume scoring is deterministic and quotes actual text", () => {
  const state = seed(),
    app = appOf(state),
    job = state.jobs[0],
    result = app.selection!.resumeReview!;
  assert.deepEqual(
    result,
    runResumeReview(job, app.snapshot, result.createdAt),
  );
  assert.equal(
    result.score,
    result.evidence.reduce((sum, item) => sum + (item.points ?? 0), 0),
  );
  assert.equal(result.maxScore, 100);
  assert.match(result.disclaimer, /未调用真实 AI/);
  assert.ok(
    result.evidence.some((item) =>
      item.quote.includes(app.snapshot.resume.slice(0, 40)),
    ),
  );
});

test("a historical rule-demo resume report cannot support a new HR passing conclusion", () => {
  const state = seed(), before = structuredClone(state);
  assert.equal(appOf(state).selection!.resumeReview!.mode, "rule_demo");
  rejectsCode(() => act(state, "confirm_screening", {
    applicationId: "application_1", conclusion: "pass", note: "历史模拟评分不能代替真实复筛",
  }), "SELECTION_REVIEW_REQUIRED");
  assert.deepEqual(state, before);
});

test("AI resume review requires current initial screening and requests completion without a fake report", () => {
  let state = fresh();
  rejectsCode(
    () => act(state, "review_resume", { applicationId: "application_1" }),
    "SELECTION_RULE_REQUIRED",
  );
  state = reviewed(state);
  assert.equal(initialScreeningReady(appOf(state).selection!.ruleReview), true);
  const requested = act(state, "review_resume", { applicationId: "application_1" });
  assert.equal(appOf(requested).selection!.resumeReview, undefined);
  assert.equal(appOf(requested).selection!.aiReview!.status, "pending");
  assert.equal(appOf(requested).stage, "new");
  assert.ok(requested.events.some((item) => item.type === "review_resume" && item.note.includes("请求 AI")));
  const rescreened = act(requested, "run_screening", { applicationId: "application_1" });
  assert.equal(appOf(rescreened).selection!.aiReview, undefined);
  const noResume = structuredClone(state);
  appOf(noResume).snapshot.resume = "  ";
  rejectsCode(() => act(noResume, "review_resume", { applicationId: "application_1" }), "RESUME_REQUIRED");
  state = act(state, "configure_screening", policy);
  rejectsCode(
    () => act(state, "review_resume", { applicationId: "application_1" }),
    "SELECTION_REPORT_STALE",
  );
  rejectsCode(
    () =>
      act(state, "confirm_screening", {
        applicationId: "application_1",
        conclusion: "pass",
        note: "已经核实材料证据",
      }),
    "SELECTION_REPORT_STALE",
  );
});

test("opening an eligible legacy application queues a real report and preserves a current real result", () => {
  const applicationId = "application_1";
  for (const userId of ["manager", "interviewer", "admin"])
    rejectsCode(() => act(seed(), "ensure_resume_review", { applicationId }, userId), "FORBIDDEN");
  const missing = act(fresh(), "ensure_resume_review", { applicationId });
  assert.equal(initialScreeningReady(appOf(missing).selection!.ruleReview), true);
  assert.equal(appOf(missing).selection!.aiReview!.status, "pending");
  assert.equal(appOf(missing).selection!.resumeReview, undefined);

  const legacy = act(reviewed(fresh()), "confirm_screening", {
    applicationId, conclusion: "pass", note: "已有历史人工通过记录",
  });
  appOf(legacy).selection!.resumeReview = runResumeReview(
    legacy.jobs[0], appOf(legacy).snapshot, NOW.toISOString(),
  );
  appOf(legacy).decision = "hire";
  appOf(legacy).decisionNote = "已有历史经理录用记录";
  const queued = act(legacy, "ensure_resume_review", { applicationId });
  assert.equal(appOf(queued).selection!.resumeReview, undefined);
  assert.equal(appOf(queued).selection!.aiReview!.status, "pending");
  assert.equal(appOf(queued).selection!.hrReview, undefined);
  assert.equal(appOf(queued).decision, "pending");
  assert.equal(appOf(queued).stage, appOf(legacy).stage);

  const real = structuredClone(legacy);
  appOf(real).selection!.resumeReview = completedModelReport(real, applicationId);
  const retained = act(real, "ensure_resume_review", { applicationId });
  assert.deepEqual(appOf(retained), appOf(real));
  assert.deepEqual(retained.events, real.events);
});

test("legacy review blockers are explicit and preserve prior human decisions and evidence", () => {
  const applicationId = "application_1";
  const cases = [
    {
      message: /岗位规则已更新/,
      prepare: (state: AppState) => { appOf(state).selection!.ruleReview!.policy!.minimumEducation = "doctor"; },
    },
    {
      message: /上传或填写简历文本/,
      prepare: (state: AppState) => { appOf(state).snapshot.resume = " "; },
    },
  ];
  for (const { message, prepare } of cases) {
    const state = reviewed(fresh());
    appOf(state).selection!.hrReview = {
      createdAt: NOW.toISOString(), actorId: "hr", conclusion: "pass", note: "保留既有人工依据",
    };
    appOf(state).decision = "hire";
    appOf(state).decisionNote = "保留既有经理依据";
    prepare(state);
    const next = act(state, "ensure_resume_review", { applicationId });
    assert.equal(appOf(next).selection!.aiReview!.status, "blocked");
    assert.match(appOf(next).selection!.aiReview!.message, message);
    assert.deepEqual(appOf(next).selection!.hrReview, appOf(state).selection!.hrReview);
    assert.deepEqual(appOf(next).selection!.resumeReview, appOf(state).selection!.resumeReview);
    assert.equal(appOf(next).decision, "hire");
    assert.equal(appOf(next).decisionNote, "保留既有经理依据");
    assert.equal(appOf(next).stage, "new");
  }

  const pending = act(fresh(), "ensure_resume_review", { applicationId });
  const configured = act(pending, "configure_screening", policy);
  assert.equal(appOf(configured).selection!.aiReview!.status, "blocked");
  assert.match(appOf(configured).selection!.aiReview!.message, /岗位规则已更新/);
});

test("unknown and mismatched initial screening evidence remains available to AI and human review", () => {
  let state = act(fresh(), "configure_screening", policy);
  const app = appOf(state);
  app.snapshot.education = "unknown";
  app.snapshot.graduationYear = null;
  app.snapshot.skills = [];
  app.snapshot.resume = "尚待补充项目资料";
  state = act(state, "run_screening", { applicationId: app.id });
  assert.equal(initialScreeningReady(undefined), false);
  assert.equal(initialScreeningReady(appOf(state).selection!.ruleReview), true);
  assert.equal(initialScreeningReady({ ...appOf(state).selection!.ruleReview!, evidence: [] }), false);
  assert.ok(appOf(state).selection!.ruleReview!.evidence.every((item) => item.status === "unknown"));
  for (const action of ["review_resume", "ensure_resume_review"]) {
    const requested = act(state, action, { applicationId: app.id });
    assert.equal(appOf(requested).selection!.aiReview!.status, "pending");
    assert.deepEqual(appOf(requested).selection!.ruleReview, appOf(state).selection!.ruleReview);
    assert.equal(appOf(requested).selection!.resumeReview, undefined);
    assert.equal(appOf(requested).selection!.hrReview, undefined);
    assert.equal(appOf(requested).stage, "new");
    rejectsCode(() => act(requested, "confirm_screening", {
      applicationId: app.id, conclusion: "pass", note: "待核实材料还需要真实报告与人工结论",
    }), "SELECTION_REVIEW_REQUIRED");
  }
  appOf(state).snapshot.education = "college";
  appOf(state).snapshot.graduationYear = 2024;
  state = act(state, "run_screening", { applicationId: app.id });
  assert.equal(initialScreeningReady(appOf(state).selection!.ruleReview), true);
  assert.ok(appOf(state).selection!.ruleReview!.evidence.some((item) => item.status === "missing"));
  for (const action of ["review_resume", "ensure_resume_review"]) {
    const requested = act(state, action, { applicationId: app.id });
    assert.equal(appOf(requested).selection!.aiReview!.status, "pending");
    assert.deepEqual(appOf(requested).selection!.ruleReview, appOf(state).selection!.ruleReview);
    assert.equal(appOf(requested).selection!.resumeReview, undefined);
    assert.equal(appOf(requested).selection!.hrReview, undefined);
  }
  assert.equal(appOf(state).selection!.resumeReview, undefined);
  assert.equal(appOf(state).status, "active");
});

test("only HR human rejection closes an application; pass and hold do not advance", () => {
  let state = fresh();
  const fields = {
    applicationId: "application_1",
    conclusion: "pass",
    note: "已人工核对原始材料",
  };
  rejectsCode(
    () => act(state, "confirm_screening", fields),
    "SELECTION_REVIEW_REQUIRED",
  );
  state = reviewed(state);
  rejectsCode(
    () => act(state, "confirm_screening", { ...fields, note: "太短" }),
    "REQUIRED",
  );
  state = act(state, "confirm_screening", fields);
  assert.equal(appOf(state).selection!.hrReview!.conclusion, "pass");
  assert.equal(appOf(state).stage, "new");
  state = act(state, "confirm_screening", { ...fields, conclusion: "hold" });
  assert.equal(appOf(state).status, "active");
  const scheduled = state.interviews.find(
    (item) => item.status === "scheduled",
  )!;
  state = act(state, "confirm_screening", {
    ...fields,
    applicationId: scheduled.applicationId,
    conclusion: "reject",
    note: "HR核实岗位经验后决定本次不通过",
  });
  assert.equal(appOf(state, scheduled.applicationId).status, "closed");
  assert.equal(
    state.interviews.find((item) => item.id === scheduled.id)!.status,
    "cancelled",
  );
  assert.ok(
    state.events.some(
      (event) =>
        event.applicationId === scheduled.applicationId &&
        event.type === "confirm_screening" &&
        event.to === "closed",
    ),
  );
});

test("explicit verification updates only one application snapshot, clears stale reviews and preserves assessments", () => {
  let state = reviewed(fresh());
  state = assign(state, "written").state;
  const app = appOf(state),
    candidateBefore = structuredClone(
      state.candidates.find((person) => person.id === app.candidateId)!,
    );
  app.decision = "hire";
  app.decisionNote = "更正前依据原资料作出的录用决定";
  app.selection!.aiReview = { status: "running", message: "正在生成", updatedAt: NOW.toISOString() };
  const other = state.applications.find(
    (item) => item.candidateId === app.candidateId && item.id !== app.id,
  )!;
  const otherBefore = structuredClone(other);
  const verify = {
    applicationId: app.id,
    education: "master",
    graduationYear: null,
    skills: ["SQL", "用户研究"],
    note: "候选人提供毕业证明并电话确认项目负责范围",
  };
  rejectsCode(
    () => act(state, "verify_screening_info", { ...verify, note: "" }),
    "REQUIRED",
  );
  rejectsCode(
    () =>
      act(state, "verify_screening_info", {
        ...verify,
        education: "unsupported",
      }),
    "INVALID_EDUCATION",
  );
  rejectsCode(
    () =>
      act(state, "verify_screening_info", {
        ...verify,
        graduationYear: "2027",
      }),
    "INVALID_YEAR",
  );
  state = act(state, "verify_screening_info", verify);
  const after = appOf(state);
  assert.equal(after.snapshot.education, "master");
  assert.equal(after.snapshot.graduationYear, null);
  assert.deepEqual(after.selection!.ruleReview, runRuleReview(
    state.jobs.find((job) => job.id === after.jobId)!, after.snapshot, NOW.toISOString(),
  ));
  assert.equal(after.selection!.resumeReview, undefined);
  assert.equal(after.selection!.aiReview, undefined);
  assert.equal(after.selection!.hrReview, undefined);
  assert.equal(after.decision, "pending");
  assert.equal(after.decisionNote, "");
  assert.equal(after.selection!.assessments.length, 1);
  assert.deepEqual(
    state.candidates.find((person) => person.id === app.candidateId),
    candidateBefore,
  );
  assert.deepEqual(appOf(state, other.id), otherBefore);
  assert.ok(
    state.events.some(
      (event) =>
        event.type === "verify_screening_info" &&
        event.note.includes(verify.note),
    ),
  );
});

test("corrected interview-stage records require fresh HR review and manager decision before an offer", () => {
  let state = seed();
  const interview = state.interviews.find((item) =>
    item.status === "completed" &&
    appOf(state, item.applicationId).stage === "interview" &&
    item.interviewerIds.every((userId) => state.scorecards.some((card) =>
      card.interviewId === item.id && card.userId === userId && card.status === "submitted",
    )),
  )!;
  const applicationId = interview.applicationId;
  const confirm = (current: AppState) => act(current, "confirm_screening", {
    applicationId, conclusion: "pass", note: "已核实原始资料与岗位全部要求",
  });
  const decide = (current: AppState) => act(current, "decision", {
    applicationId, decision: "hire", note: "已核对人工筛选及全体面试评价",
  }, "manager");
  state = decide(confirm(reviewed(state, applicationId)));
  state = act(state, "confirm_screening", {
    applicationId, conclusion: "hold", note: "补充核实资料期间暂停录用决定",
  });
  assert.equal(appOf(state, applicationId).decision, "pending");
  state = decide(confirm(state));
  const snapshot = appOf(state, applicationId).snapshot;
  state = act(state, "verify_screening_info", {
    applicationId, education: "master", graduationYear: snapshot.graduationYear,
    skills: snapshot.skills, note: "候选人补充学历证明后更正本次投递",
  });
  assert.equal(appOf(state, applicationId).decision, "pending");
  assert.equal(appOf(state, applicationId).stage, "interview");
  rejectsCode(() => decide(state), "SCREENING_APPROVAL_REQUIRED");
  rejectsCode(() => act(state, "sendOffer", {
    applicationId, deadline: "2026-10-25T10:00:00Z",
  }), "DECISION_REQUIRED");
  state = decide(confirm(reviewed(state, applicationId)));
  state = act(state, "sendOffer", { applicationId, deadline: "2026-10-25T10:00:00Z" });
  assert.equal(appOf(state, applicationId).offer.status, "sent");
});

test("assessment assignment snapshots questions and rejects invalid kind or duplicate pending task", () => {
  let state = fresh();
  rejectsCode(
    () =>
      act(state, "assign_assessment", {
        applicationId: "application_1",
        kind: "face_emotion",
      }),
    "INVALID_ASSESSMENT",
  );
  for (const kind of ["written", "preference", "ai_interview"] as const) {
    const assigned = assign(state, kind);
    state = assigned.state;
    assert.ok(assigned.task.questions.length >= 2);
    assert.ok(assigned.task.questions.every((question) => question.required));
    assert.equal(assigned.task.status, "assigned");
  }
  rejectsCode(
    () =>
      act(state, "assign_assessment", {
        applicationId: "application_1",
        kind: "written",
      }),
    "ASSESSMENT_PENDING",
  );
  assert.equal(appOf(state).stage, "new");
  assert.equal(appOf(state).status, "active");
});

test("empty, incomplete, malformed and unknown-question answer sheets fail atomically", () => {
  const { state, task } = assign(fresh(), "written"),
    before = JSON.stringify(state);
  const fields = { applicationId: "application_1", assessmentId: task.id };
  rejectsCode(
    () => act(state, "submit_assessment", { ...fields, answers: {} }),
    "ASSESSMENT_INCOMPLETE",
  );
  rejectsCode(
    () => act(state, "submit_assessment", { ...fields, answers: [] }),
    "ASSESSMENT_ANSWERS_REQUIRED",
  );
  rejectsCode(
    () =>
      act(state, "submit_assessment", {
        ...fields,
        answers: { ...writtenAnswers, injected: "not a question" },
      }),
    "UNKNOWN_ANSWER",
  );
  rejectsCode(
    () =>
      act(state, "submit_assessment", {
        ...fields,
        answers: { ...writtenAnswers, priority: "invalid" },
      }),
    "ASSESSMENT_INVALID_OPTION",
  );
  rejectsCode(
    () =>
      act(state, "submit_assessment", {
        ...fields,
        answers: { ...writtenAnswers, plan: "" },
      }),
    "ASSESSMENT_INCOMPLETE",
  );
  assert.equal(JSON.stringify(state), before);
});

test("written assessment persists answers, scores fixed rules, and locks duplicate submission", () => {
  const assigned = assign(fresh(), "written");
  let state = assigned.state;
  const fields = {
    applicationId: "application_1",
    assessmentId: assigned.task.id,
    answers: writtenAnswers,
  };
  state = act(state, "submit_assessment", fields);
  const completed = appOf(state).selection!.assessments[0];
  assert.deepEqual(completed.answers, writtenAnswers);
  assert.equal(completed.status, "submitted");
  assert.equal(completed.report!.score, 100);
  assert.ok(
    completed.report!.evidence.some((item) =>
      item.quote.includes(writtenAnswers.plan),
    ),
  );
  assert.equal(appOf(state).stage, "new");
  assert.equal(appOf(state).status, "active");
  rejectsCode(
    () => act(state, "submit_assessment", fields),
    "ASSESSMENT_LOCKED",
  );
  const another = assign(state, "written");
  assert.notEqual(another.task.id, assigned.task.id);
});

test("work preferences preserve self-report only, with no aggregate score, diagnosis or passing line", () => {
  const assigned = assign(fresh(), "preference");
  const answers = Object.fromEntries(
    assigned.task.questions.map((question, index) => [
      question.id,
      String(index + 1),
    ]),
  );
  const state = act(assigned.state, "submit_assessment", {
    applicationId: "application_1",
    assessmentId: assigned.task.id,
    answers,
  });
  const result = appOf(state).selection!.assessments[0].report!;
  assert.equal(result.score, null);
  assert.equal(result.maxScore, null);
  assert.ok(
    result.evidence.every(
      (item) => item.status === "info" && item.points === undefined,
    ),
  );
  assert.match(result.disclaimer, /不用于诊断/);
  assert.match(result.summary, /无总分/);
  rejectsCode(
    () =>
      act(assigned.state, "submit_assessment", {
        applicationId: "application_1",
        assessmentId: assigned.task.id,
        answers: { ...answers, preference_1: "6" },
      }),
    "ASSESSMENT_INVALID_OPTION",
  );
});

test("AI interview demo explicitly scores public text markers and cites provided answers", () => {
  const assigned = assign(fresh(), "ai_interview");
  const answers = {
    case: "背景是项目需求不清楚，目标是改善流程。我负责行动落实并记录结果，之后通过复盘发现还需持续验证的部分。",
    collaboration:
      "我们有范围分歧，通过沟通形成先验证的共识，后续每周检查进展并调整安排。",
  };
  const state = act(assigned.state, "submit_assessment", {
    applicationId: "application_1",
    assessmentId: assigned.task.id,
    answers,
  });
  const result = appOf(state).selection!.assessments[0].report!;
  assert.equal(result.score, 100);
  assert.equal(result.mode, "rule_demo");
  assert.match(result.summary, /未进行语音、视频、模型推理或情绪识别/);
  assert.ok(result.evidence.some((item) => item.quote.includes(answers.case)));
  assert.ok(
    result.evidence.some((item) => item.quote.includes(answers.collaboration)),
  );
});

test("manager reads owned-job reports but cannot mutate them; interviewer cannot see reports, HR remarks or peer assists", () => {
  let state = fresh();
  const target = state.interviews.find(
    (item) =>
      item.status === "scheduled" &&
      item.interviewerIds.includes("interviewer"),
  )!;
  state = act(state, "run_screening", { applicationId: target.applicationId });
  state = act(state, "confirm_screening", {
    applicationId: target.applicationId,
    conclusion: "hold",
    note: "私密甄选备注只供招聘HR和本岗位经理查看",
  });
  const view = projectState(
    state,
    state.users.find((user) => user.id === "interviewer")!,
  );
  const json = JSON.stringify(view);
  assert.equal(appOf(view, target.applicationId).selection, undefined);
  assert.ok(!json.includes("私密甄选备注"));
  assert.ok(!view.events.some((event) => event.type === "confirm_screening"));
  const manager = state.users.find((user) => user.id === "manager")!;
  assert.ok(
    appOf(projectState(state, manager), target.applicationId).selection,
  );
  rejectsCode(
    () =>
      act(
        state,
        "run_screening",
        { applicationId: target.applicationId },
        "manager",
      ),
    "FORBIDDEN",
  );
  state.jobs.find(
    (job) => job.id === appOf(state, target.applicationId).jobId,
  )!.managerId = "another_manager";
  assert.ok(
    !projectState(state, manager).applications.some(
      (app) => app.id === target.applicationId,
    ),
  );
});

test("interview assist requires independent submitted own scorecard and does not change scores", () => {
  let state = seed();
  const draft = state.scorecards.find((card) => card.status === "draft")!;
  rejectsCode(
    () =>
      act(
        state,
        "generate_interview_assist",
        { scorecardId: draft.id },
        draft.userId,
      ),
    "SCORECARD_NOT_SUBMITTED",
  );
  const card = state.scorecards.find((item) => item.status === "submitted")!,
    before = {
      ratings: structuredClone(card.ratings),
      evidence: card.evidence,
      recommendation: card.recommendation,
    };
  rejectsCode(
    () =>
      act(state, "generate_interview_assist", { scorecardId: card.id }, "hr"),
    "FORBIDDEN",
  );
  state = act(
    state,
    "generate_interview_assist",
    { scorecardId: card.id },
    card.userId,
  );
  const after = state.scorecards.find((item) => item.id === card.id)!;
  assert.deepEqual(
    {
      ratings: after.ratings,
      evidence: after.evidence,
      recommendation: after.recommendation,
    },
    before,
  );
  assert.equal(after.assistReport!.score, null);
  assert.ok(
    after.assistReport!.evidence.every((item) =>
      item.quote.includes(card.evidence),
    ),
  );
  const own = projectState(
    state,
    state.users.find((user) => user.id === card.userId)!,
  );
  assert.ok(own.scorecards.find((item) => item.id === card.id)!.assistReport);
  assert.equal(
    projectState(
      state,
      state.users.find((user) => user.id === "hr")!,
    ).scorecards.find((item) => item.id === card.id)!.assistReport,
    undefined,
  );
  const appId = state.interviews.find(
    (item) => item.id === card.interviewId,
  )!.applicationId;
  assert.equal(appOf(state, appId).stage, "interview");
  state = act(state, "returnScorecard", {
    scorecardId: card.id,
    reason: "请补充可核实的个人负责范围",
  });
  assert.equal(
    state.scorecards.find((item) => item.id === card.id)!.assistReport,
    undefined,
  );
});

test("anonymization clears new reports, answers, verified education and auxiliary evidence", () => {
  let state = seed();
  const card = state.scorecards.find((item) => item.status === "submitted")!;
  const app = state.applications.find((item) =>
    state.interviews.some(
      (interview) =>
        interview.applicationId === item.id &&
        interview.id === card.interviewId,
    ),
  )!;
  const candidateId = app.candidateId;
  app.selection = {
    assessments: [],
    hrReview: {
      createdAt: NOW.toISOString(),
      actorId: "hr",
      conclusion: "hold",
      note: "私密答卷证据应当清理",
    },
  };
  state = act(
    state,
    "generate_interview_assist",
    { scorecardId: card.id },
    card.userId,
  );
  state = act(state, "anonymizeCandidate", { candidateId });
  assert.ok(
    state.applications
      .filter((item) => item.candidateId === candidateId)
      .every(
        (item) => !item.selection && item.snapshot.education === "unknown",
      ),
  );
  assert.equal(
    state.candidates.find((item) => item.id === candidateId)!.education,
    "unknown",
  );
  assert.equal(
    state.scorecards.find((item) => item.id === card.id)!.assistReport,
    undefined,
  );
  assert.ok(!JSON.stringify(state).includes("私密答卷证据应当清理"));
});

test("education is persisted through existing candidate forms and English/Chinese CSV import", () => {
  let state = seed();
  const person = state.candidates[0];
  state = act(state, "updateCandidate", {
    candidateId: person.id,
    education: "doctor",
  });
  assert.equal(state.candidates[0].education, "doctor");
  assert.notEqual(appOf(state).snapshot.education, "doctor");
  const raw = parseCsv(
    "姓名,邮箱,学历\n学历演示,education-demo@example.com,本科",
  );
  assert.equal(raw[0].education, "本科");
  state = act(state, "importPreview", {
    jobId: "job_1",
    csv: "name,email,education\n学历演示,education-demo@example.com,bachelor",
  });
  const taskId = state.imports[0].id;
  state = act(state, "importCommit", {
    importId: taskId,
    linkDuplicates: false,
  });
  assert.equal(
    state.candidates.find(
      (item) => item.email === "education-demo@example.com",
    )!.education,
    "bachelor",
  );
});

test("policy changes and report reruns invalidate current HR conclusions while preserving audit and terminal history", () => {
  const confirm = (state: AppState) =>
    act(state, "confirm_screening", {
      applicationId: "application_1",
      conclusion: "pass",
      note: "已人工核对原始资料及岗位证据",
    });
  const approved = confirm(reviewed(fresh()));
  appOf(approved).decision = "hire";
  appOf(approved).decisionNote = "原甄选证据支持录用";
  const previousRule = structuredClone(appOf(approved).selection!.ruleReview);
  const previousResume = structuredClone(appOf(approved).selection!.resumeReview);
  for (const [id, status, stage] of [
    ["historical_closed", "closed", "interview"],
    ["historical_joined", "joined", "joined"],
    ["historical_offer", "active", "offer"],
    ["historical_onboarding", "active", "onboarding"],
  ] as const) {
    approved.applications.push({ ...structuredClone(appOf(approved)), id, status, stage });
  }
  const configured = act(approved, "configure_screening", policy);
  assert.equal(appOf(configured).selection!.hrReview, undefined);
  assert.equal(appOf(configured).decision, "pending");
  assert.equal(appOf(configured).decisionNote, "");
  assert.deepEqual(appOf(configured).selection!.ruleReview, previousRule);
  assert.deepEqual(appOf(configured).selection!.resumeReview, previousResume);
  for (const historical of configured.applications.filter((app) => app.id.startsWith("historical_"))) {
    assert.deepEqual(historical.selection!.hrReview, appOf(approved, historical.id).selection!.hrReview);
    assert.equal(historical.decision, "hire");
  }
  assert.ok(configured.events.some((event) => event.applicationId === "application_1" && event.type === "configure_screening" && event.note.includes("需重新人工复核")));
  for (const action of ["run_screening", "review_resume"]) {
    const rerun = act(approved, action, { applicationId: "application_1" });
    assert.equal(appOf(rerun).selection!.hrReview, undefined);
    assert.equal(appOf(rerun).decision, "pending");
    assert.equal(appOf(rerun).decisionNote, "");
    assert.equal(appOf(rerun).status, "active");
    assert.equal(appOf(rerun).stage, "new");
    assert.ok(rerun.events.some((event) => event.applicationId === "application_1" && event.type === "confirm_screening" && event.note.includes("已人工核对原始资料及岗位证据")));
    assert.ok(rerun.events.some((event) => event.applicationId === "application_1" && event.type === action && event.note.includes("需重新人工复核")));
    assert.equal(appOf(rerun).selection!.resumeReview, undefined);
    rejectsCode(() => confirm(rerun), "SELECTION_REVIEW_REQUIRED");
    appOf(rerun).selection!.resumeReview = structuredClone(previousResume);
    const reconfirmed = confirm(rerun);
    assert.equal(appOf(reconfirmed).selection!.hrReview!.conclusion, "pass");
  }
});
