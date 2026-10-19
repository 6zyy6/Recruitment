import assert from "node:assert/strict";

// Uses its own synthetic fixtures and never resets or deletes existing demo data.
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:5173").replace(
  /\/$/,
  "",
);
const testSiteUserId = process.env.TEST_SITE_USER_ID;
const testSiteUserEmail = process.env.TEST_SITE_USER_EMAIL;
const siteHeaders = {};
if (testSiteUserId !== undefined || testSiteUserEmail !== undefined) {
  assert.ok(testSiteUserId?.trim() && testSiteUserEmail?.trim(), "TEST_SITE_USER_ID and TEST_SITE_USER_EMAIL must both be configured");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname), "Test Sites identity headers are only allowed against a local server");
  siteHeaders["oai-authenticated-user-id"] = testSiteUserId.trim();
  siteHeaders["oai-authenticated-user-email"] = testSiteUserEmail.trim();
}
const password = process.env.DEMO_PASSWORD || "Demo2026!";
const runId = Date.now().toString(36);
const selectionActions = [
  "configure_screening",
  "run_screening",
  "review_resume",
  "ensure_resume_review",
  "confirm_screening",
  "verify_screening_info",
  "assign_assessment",
  "submit_assessment",
  "generate_interview_assist",
];
let passed = 0;
let skipped = 0;
let realReady = false;
let modelFailure = "尚未取得真实模型报告";
const SKIP = Symbol("skip");

class Session {
  constructor(userId) {
    this.userId = userId;
    this.cookie = "";
  }

  async request(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...siteHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(65_000),
    });
    const cookies =
      response.headers.getSetCookie?.() ||
      [response.headers.get("set-cookie")].filter(Boolean);
    if (cookies.length)
      this.cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `${path}: HTTP ${response.status}; expected JSON, received ${raw.slice(0, 200)}`,
      );
    }
    return { status: response.status, data };
  }

  async login() {
    const result = await this.request("/api/session", {
      userId: this.userId,
      password,
    });
    assert.equal(
      result.status,
      200,
      `Login ${this.userId}: ${JSON.stringify(result.data)}`,
    );
    assert.equal(result.data.user.id, this.userId);
    assert.ok(this.cookie, "A successful login must set a session cookie");
  }

  async snapshot() {
    const result = await this.request("/api/recruitment");
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.user.id, this.userId);
    return result.data.state;
  }

  async action(
    action,
    fields = {},
    expectedStatus = 200,
    expectedCode,
    expectedRevision,
  ) {
    const revision = expectedRevision ?? (await this.snapshot()).revision;
    const result = await this.request("/api/recruitment", {
      action,
      expectedRevision: revision,
      ...fields,
    });
    assert.equal(
      result.status,
      expectedStatus,
      `${action}: ${JSON.stringify(result.data)}`,
    );
    if (expectedCode)
      assert.equal(
        result.data.error,
        expectedCode,
        `${action}: ${JSON.stringify(result.data)}`,
      );
    return result.data;
  }
}

const hr = new Session("hr");
const manager = new Session("manager");
const interviewer = new Session("interviewer");
let job;
let otherJob;
let applicationId;
let otherApplicationId;
let candidateId;
let written;
let preference;
let aiInterview;
const privateNote = `私密甄选结论-${runId}：HR 已对照原始材料逐项确认并保留来源。`;
const verificationNote = `核实原件-${runId}：候选人提供学历证明并逐项确认所用技能。`;
const resume =
  "仅用于甄选验收的合成简历。候选人负责内部协作项目，参与流程梳理、信息记录和方案设计，分析执行中的问题并推动持续改善。项目结果包含沟通时长降低百分之十，已记录目标、个人行动和复盘过程，相关材料仍需人工核实。";
const writtenAnswers = {
  priority: "b",
  evidence: "c",
  plan: `答卷专属${runId}：先记录业务基线并明确约束，约定可观测指标，使用小规模对照进行验证，最后复盘结果与局限。`,
};
const aiAnswers = {
  case: `项目答卷${runId}：背景是跨团队需求不清楚，目标是减少重复沟通。我负责方案设计和行动落实，记录结果并组织复盘，继续核实改善能否稳定保持。`,
  collaboration: `协作答卷${runId}：我们对范围有分歧，通过沟通明确约束，形成先验证再扩大的共识，后续每周检查进展并调整安排。`,
};

async function check(name, task) {
  if ((await task()) === SKIP) return;
  passed += 1;
  process.stdout.write(`PASS ${String(passed).padStart(2, "0")} ${name}\n`);
}
function skip(name) {
  skipped += 1;
  process.stdout.write(`SKIP ${name}: ${modelFailure}\n`);
  return SKIP;
}

function appOf(state, id = applicationId) {
  const app = state.applications.find((item) => item.id === id);
  assert.ok(app, `Missing synthetic application ${id}`);
  return app;
}

function assessmentOf(state, id) {
  const task = appOf(state).selection?.assessments.find(
    (item) => item.id === id,
  );
  assert.ok(task, `Missing assessment ${id}`);
  return task;
}

function staysNew(state) {
  const app = appOf(state);
  assert.equal(
    app.stage,
    "new",
    "Selection and assessment operations must not automatically advance the application",
  );
  assert.equal(
    app.status,
    "active",
    "Reports must not automatically reject the candidate",
  );
  assert.equal(app.decision, "pending");
  assert.equal(app.offer.status, "none");
  assert.equal(app.joinedAt, "");
}

function numericReport(report, expectedKind, expectedScore) {
  assert.ok(report);
  assert.equal(report.kind, expectedKind);
  assert.equal(report.mode, "rule_demo");
  assert.equal(report.maxScore, 100);
  assert.equal(
    report.score,
    report.evidence.reduce((sum, item) => sum + (item.points ?? 0), 0),
  );
  if (expectedScore !== undefined) assert.equal(report.score, expectedScore);
  assert.match(report.disclaimer, /未调用真实 AI/);
  assert.ok(report.evidence.every((item) => item.quote.trim()));
}
function realReport(report) {
  assert.ok(report);
  assert.equal(report.kind, "resume");
  assert.equal(report.mode, "llm");
  assert.equal(report.score, null);
  assert.equal(report.maxScore, null);
  assert.ok(report.model?.trim());
  assert.ok(report.questions?.length);
  assert.ok(report.evidence.length);
  assert.ok(report.evidence.every((item) => item.quote.trim() &&
    (resume.includes(item.quote) || (item.status !== "matched" && item.quote === "简历未提供相关依据"))));
}

async function createOpenJob(suffix, type) {
  const before = await hr.snapshot();
  await hr.action("createJob", {
    title: `V2甄选验收-${suffix}-${runId}`,
    department: "演示产品研发中心",
    location: "上海",
    type,
    batch: type === "campus" ? "2027 届甄选验收" : "",
    graduationYears: type === "campus" ? [2027] : [],
    headcount: 2,
    managerId: "manager",
    skills: ["SQL", "用户研究"],
    dimensions: ["专业能力", "协作沟通"],
    description:
      "合成验收职位，用于验证人工甄选、公开规则报告和演示测评，不用于真实招聘决策。",
  });
  const created = (await hr.snapshot()).jobs.find(
    (item) => !before.jobs.some((previous) => previous.id === item.id),
  );
  assert.ok(created);
  await hr.action("jobStatus", { jobId: created.id, status: "pending" });
  await manager.action("jobStatus", { jobId: created.id, status: "open" });
  return (await hr.snapshot()).jobs.find((item) => item.id === created.id);
}

async function assign(kind) {
  const before = await hr.snapshot();
  const oldIds = new Set(
    appOf(before).selection?.assessments.map((item) => item.id) ?? [],
  );
  await hr.action("assign_assessment", { applicationId, kind });
  const task = appOf(await hr.snapshot()).selection.assessments.find(
    (item) => !oldIds.has(item.id),
  );
  assert.ok(task);
  return task;
}

async function main() {
  process.stdout.write(
    `Selection V2 API smoke — ${baseUrl}\nSynthetic run: ${runId}\n`,
  );

  await check("独立角色会话与自建社招、校招和多岗候选人", async () => {
    for (const session of [hr, manager, interviewer]) await session.login();
    assert.equal(
      new Set([hr, manager, interviewer].map((session) => session.cookie)).size,
      3,
    );
    job = await createOpenJob("校招主流程", "campus");
    otherJob = await createOpenJob("社招隔离对照", "social");
    const before = await hr.snapshot();
    await hr.action("createCandidate", {
      jobId: job.id,
      name: `V2合成候选人-${runId}`,
      email: `selection-${runId}@example.com`,
      phone: "",
      school: "演示大学",
      major: "信息管理",
      education: "unknown",
      graduationYear: null,
      skills: [],
      resume,
      availability: "合成候选人可协商到岗",
      source: "V2 API验收",
    });
    let state = await hr.snapshot();
    const app = state.applications.find(
      (item) =>
        !before.applications.some((previous) => previous.id === item.id),
    );
    assert.ok(app);
    applicationId = app.id;
    candidateId = app.candidateId;
    assert.ok(app.selection.ruleReview, "Intake must automatically create initial screening");
    assert.equal(app.selection.resumeReview, undefined);
    await hr.action("createApplication", {
      candidateId,
      jobId: otherJob.id,
      source: "同人跨岗隔离对照",
    });
    state = await hr.snapshot();
    otherApplicationId = state.applications.find(
      (item) => item.candidateId === candidateId && item.jobId === otherJob.id,
    )?.id;
    assert.ok(otherApplicationId);
    staysNew(state);
  });

  await check("学历、技能、届别规则持久化并校验异常配置", async () => {
    const policy = {
      jobId: job.id,
      minimumEducation: "bachelor",
      requiredSkills: ["SQL", " SQL ", "用户研究"],
      graduationYears: [2027],
    };
    await hr.action("configure_screening", policy);
    let state = await hr.snapshot();
    const saved = state.jobs.find((item) => item.id === job.id).screeningPolicy;
    assert.equal(saved.minimumEducation, "bachelor");
    assert.deepEqual(saved.requiredSkills, ["SQL", "用户研究"]);
    assert.deepEqual(saved.graduationYears, [2027]);
    assert.ok(saved.updatedAt);
    await hr.action(
      "configure_screening",
      { ...policy, minimumEducation: "famous_school" },
      422,
      "INVALID_EDUCATION",
    );
    await hr.action(
      "configure_screening",
      { ...policy, requiredSkills: [" "] },
      422,
      "INVALID_SKILLS",
    );
    await hr.action(
      "configure_screening",
      { ...policy, graduationYears: ["2027"] },
      422,
      "INVALID_YEAR",
    );
    state = await hr.snapshot();
    assert.deepEqual(
      state.jobs.find((item) => item.id === job.id).screeningPolicy,
      saved,
    );
    staysNew(state);
  });

  await check(
    "顺序门禁有效，未知学历与未提技能标为 unknown 且不淘汰",
    async () => {
      await hr.action(
        "review_resume",
        { applicationId },
        422,
        "SELECTION_REPORT_STALE",
      );
      await hr.action(
        "confirm_screening",
        { applicationId, conclusion: "pass", note: privateNote },
        422,
        "SELECTION_REVIEW_REQUIRED",
      );
      await hr.action("run_screening", { applicationId });
      await hr.action("review_resume", { applicationId }, 422, "INITIAL_SCREENING_REQUIRED");
      const state = await hr.snapshot();
      const report = appOf(state).selection.ruleReview;
      assert.equal(report.kind, "rule");
      assert.equal(report.score, null);
      assert.equal(report.maxScore, null);
      assert.equal(report.evidence.length, 4);
      assert.ok(report.evidence.every((item) => item.status === "unknown"));
      assert.ok(report.evidence.some((item) => item.label.includes("学历")));
      assert.ok(report.evidence.some((item) => item.label.includes("SQL")));
      assert.ok(
        !state.events.some(
          (item) =>
            item.applicationId === applicationId && item.to === "closed",
        ),
      );
      staysNew(state);
    },
  );

  await check("人工核实只改本投递，失效旧报告并保留测评", async () => {
    written = await assign("written");
    const before = await hr.snapshot();
    const candidateBefore = before.candidates.find(
      (item) => item.id === candidateId,
    );
    const otherBefore = appOf(before, otherApplicationId);
    const fields = {
      applicationId,
      education: "master",
      graduationYear: 2027,
      skills: ["SQL", "用户研究"],
      note: verificationNote,
    };
    await hr.action(
      "verify_screening_info",
      { ...fields, note: "" },
      422,
      "REQUIRED",
    );
    await hr.action(
      "verify_screening_info",
      { ...fields, graduationYear: "2027" },
      422,
      "INVALID_YEAR",
    );
    await hr.action("verify_screening_info", fields);
    const state = await hr.snapshot();
    const app = appOf(state);
    realReady = app.selection.resumeReview?.mode === "llm";
    assert.equal(app.snapshot.education, "master");
    assert.equal(app.snapshot.graduationYear, 2027);
    assert.deepEqual(app.snapshot.skills, ["SQL", "用户研究"]);
    assert.ok(app.selection.ruleReview);
    if (!realReady) {
      assert.equal(app.selection.resumeReview, undefined);
      assert.equal(app.selection.hrReview, undefined);
    }
    assert.deepEqual(assessmentOf(state, written.id), written);
    assert.deepEqual(
      state.candidates.find((item) => item.id === candidateId),
      candidateBefore,
    );
    assert.deepEqual(appOf(state, otherApplicationId), otherBefore);
    assert.ok(
      state.events.some(
        (item) =>
          item.applicationId === applicationId &&
          item.type === "verify_screening_info" &&
          item.note.includes(verificationNote),
      ),
    );
    staysNew(state);
  });

  await check("通过初筛自动请求真实模型，失败时无伪造报告且 HR 通过受阻", async () => {
    const state = await hr.snapshot(), selection = appOf(state).selection;
    realReady = selection.resumeReview?.mode === "llm";
    if (realReady) realReport(selection.resumeReview);
    else {
      assert.equal(selection.resumeReview, undefined);
      assert.equal(selection.aiReview.status, "failed");
      assert.ok(selection.aiReview.message);
      modelFailure = selection.aiReview.message;
      await hr.action("confirm_screening", {
        applicationId, conclusion: "pass", note: privateNote,
      }, 422, "SELECTION_REVIEW_REQUIRED");
    }
    staysNew(state);
  });

  await check("真实简历复筛成功后 HR 通过保存报告和人工依据", async () => {
    if (!realReady) return skip("真实报告成功与 HR 通过");
    await hr.action("confirm_screening", {
      applicationId,
      conclusion: "pass",
      note: privateNote,
    });
    const state = await hr.snapshot();
    const selection = appOf(state).selection;
    realReport(selection.resumeReview);
    assert.deepEqual(
      selection.resumeReview.policy,
      state.jobs.find((item) => item.id === job.id).screeningPolicy,
    );
    assert.equal(selection.hrReview.conclusion, "pass");
    assert.equal(selection.hrReview.actorId, "hr");
    assert.equal(selection.hrReview.note, privateNote);
    assert.ok(
      ["run_screening", "verify_screening_info", "confirm_screening"].every((type) =>
        state.events.some(
          (item) => item.applicationId === applicationId && item.type === type,
        ),
      ),
    );
    staysNew(state);
  });

  await check("规则变更阻止旧报告通过，旧 revision 返回 409", async () => {
    const before = await hr.snapshot();
    const oldReport = appOf(before).selection.ruleReview;
    await hr.action("configure_screening", {
      jobId: job.id,
      minimumEducation: "master",
      requiredSkills: ["SQL", "用户研究", "数据分析"],
      graduationYears: [2027],
    });
    await hr.action(
      "run_screening",
      { applicationId },
      409,
      "REVISION_CONFLICT",
      before.revision,
    );
    await hr.action(
      "review_resume",
      { applicationId },
      422,
      "SELECTION_REPORT_STALE",
    );
    await hr.action(
      "confirm_screening",
      { applicationId, conclusion: "pass", note: privateNote },
      422,
      realReady ? "SELECTION_REPORT_STALE" : "SELECTION_REVIEW_REQUIRED",
    );
    let state = await hr.snapshot();
    assert.deepEqual(appOf(state).selection.ruleReview, oldReport);
    await hr.action("verify_screening_info", {
      applicationId, education: "master", graduationYear: 2027,
      skills: ["SQL", "用户研究", "数据分析"], note: verificationNote,
    });
    state = await hr.snapshot();
    realReady = appOf(state).selection.resumeReview?.mode === "llm";
    if (!realReady) {
      assert.equal(appOf(state).selection.resumeReview, undefined);
      assert.equal(appOf(state).selection.aiReview.status, "failed");
      staysNew(state);
      return;
    }
    await hr.action("confirm_screening", {
      applicationId,
      conclusion: "pass",
      note: privateNote,
    });
    state = await hr.snapshot();
    assert.equal(appOf(state).selection.hrReview.conclusion, "pass");
    assert.deepEqual(
      appOf(state).selection.ruleReview.policy,
      state.jobs.find((item) => item.id === job.id).screeningPolicy,
    );
    staysNew(state);
  });

  await check("派发三类测评快照题目，重复待作答任务返回 409", async () => {
    await hr.action(
      "assign_assessment",
      { applicationId, kind: "face_emotion" },
      422,
      "INVALID_ASSESSMENT",
    );
    await hr.action(
      "assign_assessment",
      { applicationId, kind: "written" },
      409,
      "ASSESSMENT_PENDING",
    );
    preference = await assign("preference");
    aiInterview = await assign("ai_interview");
    const state = await hr.snapshot();
    for (const kind of ["written", "preference", "ai_interview"]) {
      const task = appOf(state).selection.assessments.find(
        (item) => item.kind === kind,
      );
      assert.ok(task);
      assert.equal(task.status, "assigned");
      assert.equal(task.assignedBy, "hr");
      assert.ok(task.questions.length >= 2);
      assert.ok(task.questions.every((item) => item.required));
      await hr.action(
        "assign_assessment",
        { applicationId, kind },
        409,
        "ASSESSMENT_PENDING",
      );
    }
    staysNew(await hr.snapshot());
  });

  await check(
    "笔试拒绝空卷、非法选项、未知题目和过短答案且原子保存",
    async () => {
      const before = await hr.snapshot();
      const fields = { applicationId, assessmentId: written.id };
      for (const [answers, code] of [
        [{}, "ASSESSMENT_INCOMPLETE"],
        [[], "ASSESSMENT_ANSWERS_REQUIRED"],
        [
          { ...writtenAnswers, priority: "invalid" },
          "ASSESSMENT_INVALID_OPTION",
        ],
        [{ ...writtenAnswers, injected: "not a question" }, "UNKNOWN_ANSWER"],
        [{ ...writtenAnswers, plan: "过短" }, "ASSESSMENT_ANSWER_LENGTH"],
      ])
        await hr.action("submit_assessment", { ...fields, answers }, 422, code);
      const state = await hr.snapshot();
      assert.deepEqual(
        assessmentOf(state, written.id),
        assessmentOf(before, written.id),
      );
      assert.equal(appOf(state).version, appOf(before).version);
      assert.equal(state.revision, before.revision);
      staysNew(state);
    },
  );

  await check("笔试保存原始答卷与规则报告，重复提交返回 409", async () => {
    const fields = {
      applicationId,
      assessmentId: written.id,
      answers: writtenAnswers,
    };
    await hr.action("submit_assessment", fields);
    let state = await hr.snapshot();
    const completed = assessmentOf(state, written.id);
    assert.equal(completed.status, "submitted");
    assert.ok(completed.submittedAt);
    assert.deepEqual(completed.answers, writtenAnswers);
    numericReport(completed.report, "written", 100);
    assert.ok(
      completed.report.evidence.some((item) =>
        item.quote.includes(writtenAnswers.plan),
      ),
    );
    await hr.action("submit_assessment", fields, 409, "ASSESSMENT_LOCKED");
    state = await hr.snapshot();
    assert.deepEqual(assessmentOf(state, written.id), completed);
    staysNew(state);
  });

  await check(
    "偏好问卷验证选项，只保存自述且无总分、及格线和排名",
    async () => {
      const answers = Object.fromEntries(
        preference.questions.map((question, index) => [
          question.id,
          String(index + 1),
        ]),
      );
      const fields = { applicationId, assessmentId: preference.id };
      await hr.action(
        "submit_assessment",
        { ...fields, answers: { ...answers, preference_1: "6" } },
        422,
        "ASSESSMENT_INVALID_OPTION",
      );
      await hr.action("submit_assessment", { ...fields, answers });
      const state = await hr.snapshot();
      const completed = assessmentOf(state, preference.id);
      assert.deepEqual(completed.answers, answers);
      assert.equal(completed.report.kind, "preference");
      assert.equal(completed.report.score, null);
      assert.equal(completed.report.maxScore, null);
      assert.ok(
        completed.report.evidence.every(
          (item) =>
            item.status === "info" &&
            item.points === undefined &&
            item.maxPoints === undefined,
        ),
      );
      assert.match(completed.report.summary, /无总分、及格线或排名/);
      assert.match(completed.report.disclaimer, /不用于诊断/);
      await hr.action(
        "submit_assessment",
        { ...fields, answers },
        409,
        "ASSESSMENT_LOCKED",
      );
      staysNew(state);
    },
  );

  await check(
    "AI 面试明确为固定规则演示，报告引用原回答且不自动推进",
    async () => {
      const fields = { applicationId, assessmentId: aiInterview.id };
      await hr.action(
        "submit_assessment",
        { ...fields, answers: { ...aiAnswers, case: "不足字数" } },
        422,
        "ASSESSMENT_ANSWER_LENGTH",
      );
      await hr.action("submit_assessment", { ...fields, answers: aiAnswers });
      const state = await hr.snapshot();
      const completed = assessmentOf(state, aiInterview.id);
      assert.deepEqual(completed.answers, aiAnswers);
      numericReport(completed.report, "ai_interview", 100);
      assert.match(completed.report.title, /固定规则演示/);
      assert.match(
        completed.report.summary,
        /未进行语音、视频、模型推理或情绪识别/,
      );
      assert.ok(
        Object.values(aiAnswers).every((answer) =>
          completed.report.evidence.some((item) => item.quote.includes(answer)),
        ),
      );
      await hr.action(
        "submit_assessment",
        { ...fields, answers: aiAnswers },
        409,
        "ASSESSMENT_LOCKED",
      );
      staysNew(state);
    },
  );

  await check(
    "经理只读；面试官无法读取甄选报告、答卷或私密审计记录",
    async () => {
      const before = await hr.snapshot();
      const fieldsByAction = [
        [
          "configure_screening",
          {
            jobId: job.id,
            minimumEducation: "any",
            requiredSkills: [],
            graduationYears: [],
          },
        ],
        ["run_screening", { applicationId }],
        ["review_resume", { applicationId }],
        ["ensure_resume_review", { applicationId }],
        [
          "verify_screening_info",
          {
            applicationId,
            education: "unknown",
            graduationYear: null,
            skills: [],
            note: verificationNote,
          },
        ],
        [
          "confirm_screening",
          { applicationId, conclusion: "reject", note: privateNote },
        ],
        ["assign_assessment", { applicationId, kind: "written" }],
        [
          "submit_assessment",
          { applicationId, assessmentId: written.id, answers: writtenAnswers },
        ],
      ];
      for (const [action, fields] of fieldsByAction)
        await manager.action(action, fields, 403, "FORBIDDEN");
      await interviewer.action(
        "run_screening",
        { applicationId },
        403,
        "FORBIDDEN",
      );
      await check("经理甄选写权限隔离独立于模型配置", async () => {
        assert.deepEqual(appOf(await hr.snapshot()), appOf(before));
      });
      assert.ok(appOf(await manager.snapshot()).selection.ruleReview);
      if (!realReady) return skip("面试安排与面试官报告可见性（经理写权限隔离已验证）");

      // Only these explicit HR operations move the fixture into a schedulable stage.
      await hr.action("advance", {
        applicationId,
        note: "人工开始筛选流程，报告不自动改变阶段。",
      });
      await hr.action("advance", {
        applicationId,
        note: "HR 已核实甄选材料，并明确安排进入面试。",
      });
      const state = await hr.snapshot();
      const start = new Date(Date.now() + 14 * 86_400_000);
      start.setUTCHours(4, 0, 0, 0);
      while (
        state.interviews.some(
          (item) =>
            item.status === "scheduled" &&
            Date.parse(item.start) < start.getTime() + 3_600_000 &&
            Date.parse(item.end) > start.getTime(),
        )
      )
        start.setTime(start.getTime() + 2 * 3_600_000);
      await hr.action("scheduleInterview", {
        applicationId,
        round: "V2可见性验收面试",
        start: start.toISOString(),
        end: new Date(start.getTime() + 3_600_000).toISOString(),
        interviewerIds: ["interviewer"],
        location: "合成面试房间",
      });
      const view = await interviewer.snapshot();
      const restricted = appOf(view);
      assert.equal(restricted.stage, "interview");
      assert.equal(restricted.selection, undefined);
      assert.ok(
        !view.events.some(
          (item) =>
            item.applicationId === applicationId &&
            selectionActions.includes(item.type),
        ),
      );
      const serialized = JSON.stringify(view);
      for (const secret of [
        privateNote,
        verificationNote,
        writtenAnswers.plan,
        ...Object.values(aiAnswers),
      ])
        assert.ok(
          !serialized.includes(secret),
          "Interviewer projection must omit HR selection notes and original assessment answers",
        );
      assert.equal(restricted.snapshot.email, "");
    },
  );

  await check(
    "新版甄选阻止绕过当前 HR 通过，报告和资料变更后须重新复核与决策",
    async () => {
      if (!realReady) return skip("真实复筛完成后的经理决定、面试和 Offer 门禁");
      const fields = { applicationId: otherApplicationId };
      const mainBefore = appOf(await hr.snapshot());
      const advance = {
        ...fields,
        note: "合成验收：完成当前人工复核后进入面试。",
      };
      const decision = {
        ...fields,
        decision: "hire",
        note: "合成验收：经理依据当前 HR 复核和面试评价确认录用。",
      };
      const offer = {
        ...fields,
        deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reference: `V2-GATE-${runId}`,
      };
      const approveSelection = async () => {
        const current = appOf(await hr.snapshot(), otherApplicationId);
        if (current.selection?.resumeReview?.mode !== "llm")
          await hr.action("run_screening", fields);
        await hr.action("confirm_screening", {
          ...fields,
          conclusion: "pass",
          note: "合成验收：逐项核实当前报告及投递资料后人工确认通过。",
        });
      };

      await hr.action("verify_screening_info", {
        ...fields, education: "bachelor", graduationYear: 2027,
        skills: ["SQL", "用户研究"], note: verificationNote,
      });
      await hr.action("advance", advance);
      await hr.action("advance", advance, 422, "SCREENING_APPROVAL_REQUIRED");
      await hr.action("confirm_screening", {
        ...fields,
        conclusion: "hold",
        note: "合成验收：资料仍待核实，不能仅凭推进备注跳过本结论。",
      });
      await hr.action("advance", advance, 422, "SCREENING_APPROVAL_REQUIRED");
      await approveSelection();
      await hr.action("review_resume", fields);
      await hr.action("advance", advance, 422, "SCREENING_APPROVAL_REQUIRED");
      assert.equal(appOf(await hr.snapshot(), otherApplicationId).stage, "screening");
      await approveSelection();
      await hr.action("advance", advance);

      const beforeInterview = await hr.snapshot();
      const start = new Date(Date.now() + 16 * 86_400_000);
      start.setUTCHours(4, 0, 0, 0);
      while (
        beforeInterview.interviews.some(
          (item) =>
            item.status === "scheduled" &&
            Date.parse(item.start) < start.getTime() + 3_600_000 &&
            Date.parse(item.end) > start.getTime(),
        )
      )
        start.setTime(start.getTime() + 2 * 3_600_000);
      await hr.action("scheduleInterview", {
        ...fields,
        round: "V2人工录用门槛验收",
        start: start.toISOString(),
        end: new Date(start.getTime() + 3_600_000).toISOString(),
        interviewerIds: ["interviewer"],
        location: "合成验收面试房间",
      });
      const interview = (await hr.snapshot()).interviews.find(
        (item) => item.applicationId === otherApplicationId,
      );
      assert.ok(interview);
      await hr.action("interviewStatus", {
        interviewId: interview.id,
        status: "completed",
      });
      await interviewer.action("submitScorecard", {
        interviewId: interview.id,
        ratings: Object.fromEntries(otherJob.dimensions.map((dimension) => [dimension, 4])),
        evidence: "合成验收：面试中候选人说明个人行动、项目结果及可核实材料。",
        recommendation: "建议录用",
      });
      await manager.action("decision", decision);

      for (const [action, mutation] of [
        ["review_resume", fields],
        [
          "verify_screening_info",
          {
            ...fields,
            education: "bachelor",
            graduationYear: 2027,
            skills: ["SQL", "用户研究"],
            note: "合成验收：补充学历证明后更正本投递资料，旧结论必须失效。",
          },
        ],
      ]) {
        await hr.action(action, mutation);
        const changed = appOf(await hr.snapshot(), otherApplicationId);
        assert.equal(changed.stage, "interview");
        assert.equal(changed.selection.hrReview, undefined);
        assert.equal(changed.decision, "pending");
        assert.equal(changed.decisionNote, "");
        await manager.action("decision", decision, 422, "SCREENING_APPROVAL_REQUIRED");
        await hr.action("sendOffer", offer, 422, "DECISION_REQUIRED");
        await approveSelection();
        await manager.action("decision", decision);
      }
      await hr.action("sendOffer", offer);
      const state = await hr.snapshot();
      const completed = appOf(state, otherApplicationId);
      assert.equal(completed.stage, "offer");
      assert.equal(completed.offer.status, "sent");
      assert.equal(completed.decision, "hire");
      assert.equal(completed.selection.hrReview.conclusion, "pass");
      assert.deepEqual(appOf(state), mainBefore);
    },
  );

  process.stdout.write(
    `\n${passed} V2 selection API scenarios passed; ${skipped} explicitly skipped. Synthetic run: ${runId}.\nNo seed reset was performed; synthetic fixtures remain for review. Session cookies were not printed.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `\nFAIL after ${passed} passed scenarios (run ${runId}): ${error.stack || error.message}\n`,
  );
  process.exitCode = 1;
});
