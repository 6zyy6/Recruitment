import type {
  AppState,
  Application,
  Assessment,
  AssessmentKind,
  AssessmentQuestion,
  Candidate,
  EducationLevel,
  Job,
  Scorecard,
  ScreeningPolicy,
  SelectionEvidence,
  SelectionReport,
  User,
} from "./domain.ts";

export const SELECTION_ACTIONS = [
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

export class SelectionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code: string, message: string, status = 422): never => {
  throw new SelectionError(code, message, status);
};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const normalize = (value: string) =>
  value.toLocaleLowerCase().replace(/\s+/g, "");
const educationRanks: Record<string, number> = {
  college: 1,
  bachelor: 2,
  master: 3,
  doctor: 4,
  大专: 1,
  专科: 1,
  本科: 2,
  学士: 2,
  硕士: 3,
  研究生: 3,
  博士: 4,
};
const educationLabels: Record<EducationLevel, string> = {
  any: "不限",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
};
const disclaimer =
  "固定规则演示，未调用真实 AI。结果仅供人工核实，不代表能力认定或录用建议，不自动淘汰或推进。";
const preferenceDisclaimer =
  "工作偏好问卷演示，不是经过信效度验证的心理测评，不用于诊断、性格标签、排名或录用评分。请经候选人确认后用于沟通。";

export function screeningPolicy(job: Job): ScreeningPolicy {
  return structuredClone(
    job.screeningPolicy ?? {
      minimumEducation: "any",
      requiredSkills: job.skills,
      graduationYears: job.type === "campus" ? job.graduationYears : [],
      updatedAt: job.createdAt,
    },
  );
}
export function hasLegacyScreeningApproval(state: AppState, app: Application): boolean {
  if (!app.screeningNote.trim() || app.selection?.hrReview) return false;
  const events = state.events.filter((item) => item.applicationId === app.id);
  if ((app.selection && !events.some((item) => item.type === "advanced" && item.from === "screening" && item.to === "interview")) ||
    events.some((item) => ["run_screening", "review_resume", "verify_screening_info", "confirm_screening", "configure_screening"].includes(item.type)))
    return false;
  const job = state.jobs.find((item) => item.id === app.jobId);
  if (!job) return false;
  const policy = JSON.stringify(screeningPolicy(job));
  if ([app.selection?.ruleReview, app.selection?.resumeReview].some(
    (report) => report && (!report.policy || JSON.stringify(report.policy) !== policy),
  )) return false;
  return !state.reviews?.some((review) =>
    review.applicationId === app.id && review.status === "submitted" && review.submittedFields &&
    Object.entries(review.fields).some(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(review.submittedFields![key as keyof typeof review.fields]),
    ),
  );
}
function excerpt(source: string, token: string): string {
  const index = source.toLocaleLowerCase().indexOf(token.toLocaleLowerCase());
  return index < 0
    ? ""
    : source.slice(
        Math.max(0, index - 24),
        Math.min(source.length, index + token.length + 60),
      );
}
function skillEvidence(candidate: Candidate, skill: string): SelectionEvidence {
  const listed = candidate.skills.find(
    (value) => normalize(value) === normalize(skill),
  );
  const quote = excerpt(candidate.resume, skill);
  return {
    label: `必备技能 · ${skill}`,
    status: listed || quote ? "matched" : "unknown",
    quote: listed
      ? `技能字段：${listed}`
      : quote
        ? `简历关键词线索（不代表能力已验证）：${quote}`
        : "技能字段和简历中未找到该关键词；需人工核实，不代表不具备能力。",
  };
}
function report(
  kind: SelectionReport["kind"],
  title: string,
  now: string,
  evidence: SelectionEvidence[],
  score: number | null = null,
  maxScore: number | null = null,
): SelectionReport {
  return {
    createdAt: now,
    kind,
    mode: "rule_demo",
    ruleVersion: "demo-rules-2026-10-20",
    title,
    summary: "",
    score,
    maxScore,
    evidence,
    gaps: evidence
      .filter((item) => item.status === "missing" || item.status === "unknown")
      .map((item) => item.label),
    disclaimer,
  };
}
export function runRuleReview(
  job: Job,
  candidate: Candidate,
  now: string,
): SelectionReport {
  const policy = screeningPolicy(job);
  const rank = educationRanks[normalize(candidate.education ?? "")];
  const educationName =
    candidate.education === "unknown"
      ? "待核实"
      : educationLabels[candidate.education as EducationLevel] ||
        candidate.education;
  const education: SelectionEvidence =
    policy.minimumEducation === "any"
      ? {
          label: "学历要求 · 不限",
          status: "info",
          quote: educationName
            ? `学历字段：${educationName}`
            : "学历未提供，当前规则不限制学历。",
        }
      : {
          label: `最低学历 · ${educationLabels[policy.minimumEducation]}`,
          status:
            rank === undefined
              ? "unknown"
              : rank >= educationRanks[policy.minimumEducation]
                ? "matched"
                : "missing",
          quote:
            rank === undefined
              ? "学历字段未知或无法识别，需人工核实。"
              : `学历字段：${educationName}；规则要求：${educationLabels[policy.minimumEducation]}`,
        };
  const evidence = [
    education,
    ...policy.requiredSkills.map((skill) => skillEvidence(candidate, skill)),
  ];
  if (policy.graduationYears.length)
    evidence.push({
      label: `毕业届别 · ${policy.graduationYears.join(" / ")}`,
      status:
        candidate.graduationYear == null
          ? "unknown"
          : policy.graduationYears.includes(candidate.graduationYear)
            ? "matched"
            : "missing",
      quote:
        candidate.graduationYear == null
          ? "毕业年份未提供，需人工核实；不会自动淘汰。"
          : `毕业年份字段：${candidate.graduationYear}`,
    });
  const result = report("rule", "岗位规则初筛", now, evidence);
  result.policy = policy;
  result.summary = `${evidence.filter((item) => item.status === "matched").length} 项命中线索，${evidence.filter((item) => item.status === "missing").length} 项条件差异，${evidence.filter((item) => item.status === "unknown").length} 项未知。初筛仅整理线索，缺项和未知信息交由 AI 复筛与 HR 核实，不自动淘汰。`;
  return result;
}
export function initialScreeningReady(
  value: SelectionReport | undefined,
): boolean {
  return Boolean(
    value?.kind === "rule" &&
      value.evidence.length,
  );
}
export function runResumeReview(
  job: Job,
  candidate: Candidate,
  now: string,
): SelectionReport {
  const policy = screeningPolicy(job);
  const skills = policy.requiredSkills.map((skill) =>
    skillEvidence(candidate, skill),
  );
  const matched = skills.filter((item) => item.status === "matched").length;
  const skillPoints = skills.length
    ? Math.round((matched / skills.length) * 50)
    : 0;
  const evidence: SelectionEvidence[] = [
    {
      label: "岗位关键词覆盖（50 分）",
      status:
        skills.length && matched === skills.length ? "matched" : "unknown",
      quote: skills.length
        ? skills.map((item) => `${item.label}：${item.quote}`).join("\n")
        : "尚未配置必备技能，无法核对关键词覆盖。",
      points: skillPoints,
      maxPoints: 50,
    },
  ];
  const resume = candidate.resume.trim();
  evidence.push({
    label: "简历信息量（20 分）",
    status: resume.length >= 80 ? "matched" : "missing",
    quote: `原始简历共 ${resume.length} 字符；演示阈值为 80 字符。${resume ? `原文摘录：${resume.slice(0, 100)}` : "未提供简历文本。"}`,
    points: resume.length >= 80 ? 20 : 0,
    maxPoints: 20,
  });
  const action = ["负责", "参与", "设计", "实现", "推动", "分析", "优化"].find(
    (token) => resume.includes(token),
  );
  evidence.push({
    label: "个人行为描述（15 分）",
    status: action ? "matched" : "missing",
    quote: action
      ? `原文摘录：${excerpt(resume, action)}`
      : "未找到负责、参与、设计、实现、推动、分析或优化等行为词；请人工补充核实。",
    points: action ? 15 : 0,
    maxPoints: 15,
  });
  const resultToken = resume.match(
    /\d+(?:\.\d+)?\s*%|提升|降低|增长|改善|复盘|结果/,
  )?.[0];
  evidence.push({
    label: "结果描述线索（15 分）",
    status: resultToken ? "matched" : "missing",
    quote: resultToken
      ? `原文摘录：${excerpt(resume, resultToken)}`
      : "未找到数字百分比或提升、降低、增长、改善、复盘、结果等词；不推断实际业绩。",
    points: resultToken ? 15 : 0,
    maxPoints: 15,
  });
  const result = report(
    "resume",
    "简历复筛 · 固定规则演示",
    now,
    evidence,
    evidence.reduce((sum, item) => sum + (item.points ?? 0), 0),
    100,
  );
  result.policy = policy;
  result.summary = `演示材料完整度 ${result.score}/100：关键词覆盖 50 分、信息量 20 分、行为词 15 分、结果词 15 分。只检查资料中可引用的文本，不评判真实能力。`;
  return result;
}

export function assessmentQuestions(
  kind: AssessmentKind,
  job: Job,
): AssessmentQuestion[] {
  if (kind === "written")
    return [
      {
        id: "priority",
        type: "single_choice",
        required: true,
        prompt: `面对“${job.title}”的一项新任务，第一步更合适的是？`,
        options: [
          { value: "a", label: "立即投入完整实现，再寻找目标" },
          { value: "b", label: "确认问题、目标用户、约束和现状基线" },
          { value: "c", label: "先承诺截止时间，跳过范围确认" },
        ],
      },
      {
        id: "evidence",
        type: "single_choice",
        required: true,
        prompt: "如何验证方案是否带来改善？",
        options: [
          { value: "a", label: "只看少数支持者的评价" },
          { value: "b", label: "仅以按时上线作为成功标准" },
          { value: "c", label: "使用预先约定的指标，并与基线或对照比较" },
        ],
      },
      {
        id: "plan",
        type: "text",
        required: true,
        minLength: 20,
        maxLength: 2000,
        prompt:
          "请用至少 20 个字说明一个方案的验证计划。固定规则各检查“基线”“指标”“对照或验证”“复盘”四类词，每类 10 分，不进行语义能力评判。",
      },
    ];
  if (kind === "preference") {
    const prompts = [
      "我倾向于先与同伴讨论，再独立推进任务。",
      "我喜欢在目标、分工和节奏清楚时开展工作。",
      "面对新问题，我愿意尝试不同方法。",
      "我更愿意及时交流工作过程中的反馈。",
    ];
    const labels = ["很不符合", "不太符合", "视情境而定", "比较符合", "很符合"];
    return prompts.map((prompt, index) => ({
      id: `preference_${index + 1}`,
      type: "likert",
      required: true,
      prompt,
      options: labels.map((label, value) => ({
        value: String(value + 1),
        label,
      })),
    }));
  }
  return [
    {
      id: "case",
      type: "text",
      required: true,
      minLength: 30,
      maxLength: 3000,
      prompt: `围绕“${job.title}”，描述一个你亲自参与的项目：说明背景、目标、你的行动、结果和复盘。至少 30 个字。演示仅检查这些结构词，不能验证经历真实性。`,
    },
    {
      id: "collaboration",
      type: "text",
      required: true,
      minLength: 20,
      maxLength: 2000,
      prompt:
        "描述一次协作分歧：说明分歧、沟通方式、共识与后续。至少 20 个字。固定规则只检查上述结构词，不判断人格或价值观。",
    },
  ];
}
export function createAssessment(
  kind: AssessmentKind,
  job: Job,
  assignedBy: string,
  now: string,
): Assessment {
  const titles: Record<AssessmentKind, string> = {
    written: "岗位基础笔试",
    preference: "工作偏好问卷",
    ai_interview: "AI 面试 · 固定规则演示",
  };
  return {
    id: `assessment_${crypto.randomUUID()}`,
    kind,
    title: titles[kind],
    status: "assigned",
    assignedAt: now,
    assignedBy,
    questions: assessmentQuestions(kind, job),
    answers: {},
    submittedAt: "",
  };
}
function answersFor(
  assessment: Assessment,
  input: unknown,
): Record<string, string> {
  if (!input || Array.isArray(input) || typeof input !== "object")
    fail("ASSESSMENT_ANSWERS_REQUIRED", "请按题目填写完整答卷");
  const supplied = input as Record<string, unknown>;
  if (
    Object.keys(supplied).some(
      (key) => !assessment.questions.some((question) => question.id === key),
    )
  )
    fail("UNKNOWN_ANSWER", "答卷包含不属于本次测评的题目");
  const answers: Record<string, string> = {};
  for (const question of assessment.questions) {
    const value = text(supplied[question.id]);
    if (!value && question.required)
      fail("ASSESSMENT_INCOMPLETE", `请完成题目：${question.prompt}`);
    if (
      value.length < (question.minLength ?? 1) ||
      value.length > (question.maxLength ?? 3000)
    )
      fail(
        "ASSESSMENT_ANSWER_LENGTH",
        `答案长度应为 ${question.minLength ?? 1}–${question.maxLength ?? 3000} 个字符`,
      );
    if (
      question.type !== "text" &&
      !question.options?.some((option) => option.value === value)
    )
      fail("ASSESSMENT_INVALID_OPTION", "请选择本题提供的有效选项");
    answers[question.id] = value;
  }
  return answers;
}
function quotedAnswer(
  assessment: Assessment,
  answers: Record<string, string>,
  questionId: string,
): string {
  const question = assessment.questions.find((item) => item.id === questionId)!;
  const value = answers[questionId];
  return (
    question.options?.find((option) => option.value === value)?.label ?? value
  );
}
function markers(
  answer: string,
  groups: string[][],
): { count: number; found: string[] } {
  const found = groups
    .map((group) => group.find((token) => answer.includes(token)))
    .filter((value): value is string => Boolean(value));
  return { count: found.length, found };
}
export function submitAssessment(
  assessment: Assessment,
  input: unknown,
  now: string,
): Assessment {
  if (assessment.status !== "assigned")
    fail("ASSESSMENT_LOCKED", "答卷已提交并锁定，请新建测评后再作答", 409);
  const answers = answersFor(assessment, input);
  const evidence: SelectionEvidence[] = [];
  if (assessment.kind === "preference") {
    assessment.questions.forEach((question) =>
      evidence.push({
        label: question.prompt,
        status: "info",
        quote: `受测者自述：${quotedAnswer(assessment, answers, question.id)}（${answers[question.id]}/5）。仅呈现本次回答，不推断稳定人格。`,
      }),
    );
    const result = report("preference", "工作偏好沟通记录", now, evidence);
    result.summary =
      "记录四项情境偏好供后续沟通；无总分、及格线或排名。偏好没有标准答案。";
    result.disclaimer = preferenceDisclaimer;
    return {
      ...assessment,
      answers,
      status: "submitted",
      submittedAt: now,
      report: result,
    };
  }
  if (assessment.kind === "written") {
    const correct: Record<string, string> = { priority: "b", evidence: "c" };
    ["priority", "evidence"].forEach((questionId) => {
      const matched = answers[questionId] === correct[questionId];
      evidence.push({
        label: assessment.questions.find(
          (question) => question.id === questionId,
        )!.prompt,
        status: matched ? "matched" : "missing",
        quote: `答卷选择：${quotedAnswer(assessment, answers, questionId)}。固定题库参考选项：${quotedAnswer(assessment, { ...answers, [questionId]: correct[questionId] }, questionId)}`,
        points: matched ? 30 : 0,
        maxPoints: 30,
      });
    });
    const found = markers(answers.plan, [
      ["基线"],
      ["指标"],
      ["对照", "验证"],
      ["复盘"],
    ]);
    evidence.push({
      label: "验证计划结构词覆盖",
      status: found.count === 4 ? "matched" : "missing",
      quote: `答卷原文：${answers.plan}\n命中的公开规则词：${found.found.join("、") || "无"}`,
      points: found.count * 10,
      maxPoints: 40,
    });
  } else {
    const rubrics: [string, string[][]][] = [
      ["case", [["背景"], ["目标"], ["行动", "负责"], ["结果"], ["复盘"]]],
      ["collaboration", [["分歧"], ["沟通"], ["共识"], ["后续"]]],
    ];
    rubrics.forEach(([questionId, groups]) => {
      const found = markers(answers[questionId], groups);
      evidence.push({
        label: assessment.questions.find(
          (question) => question.id === questionId,
        )!.prompt,
        status: found.count === groups.length ? "matched" : "missing",
        quote: `答卷原文：${answers[questionId]}\n命中的公开结构词：${found.found.join("、") || "无"}。这些词出现不等于经历属实或能力合格。`,
        points: Math.round((found.count / groups.length) * 50),
        maxPoints: 50,
      });
    });
  }
  const score = evidence.reduce((sum, item) => sum + (item.points ?? 0), 0);
  const result = report(
    assessment.kind,
    assessment.kind === "written"
      ? "笔试报告 · 固定题库演示"
      : "AI 面试报告 · 固定规则演示",
    now,
    evidence,
    score,
    100,
  );
  result.summary = `公开题库或结构词规则得分 ${score}/100，不设置自动晋级线；请核实答卷和岗位表现。${assessment.kind === "ai_interview" ? "未进行语音、视频、模型推理或情绪识别。" : ""}`;
  return {
    ...assessment,
    answers,
    status: "submitted",
    submittedAt: now,
    report: result,
  };
}
export function interviewAssist(
  card: Scorecard,
  job: Job,
  now: string,
): SelectionReport {
  if (card.status !== "submitted")
    fail(
      "SCORECARD_NOT_SUBMITTED",
      "请先独立提交本人面试评价，再生成辅助核对报告",
    );
  const evidence: SelectionEvidence[] = job.dimensions.map((dimension) => ({
    label: dimension,
    status: "info",
    quote: `本人已提交评分：${card.ratings[dimension] ?? "未提供"}/5；本人证据原文：${card.evidence}`,
  }));
  const result = report(
    "interview_assist",
    "本人面试评价辅助核对",
    now,
    evidence,
  );
  result.summary =
    "仅整理本人已提交的维度评分和事实证据，不另行评分、不修改原评价，也不读取其他面试官的意见。请核对证据是否具体支持各维度。";
  if (card.evidence.length < 40)
    result.gaps.push(
      "事实证据少于 40 字符，请人工核查是否需要补充具体场景、行动与结果。",
    );
  return result;
}

export function handleSelectionAction(
  state: AppState,
  user: User,
  input: Record<string, unknown>,
  now: string,
): boolean {
  const action = text(input.action);
  if (!SELECTION_ACTIONS.includes(action)) return false;
  if (action !== "generate_interview_assist" && user.role !== "hr")
    fail("FORBIDDEN", "甄选配置、人工筛选和演示测评录入需要招聘 HR 权限", 403);
  const audit = (app: Application, note: string) => {
    app.version++;
    app.updatedAt = now;
    state.events.push({
      id: `event_${crypto.randomUUID()}`,
      applicationId: app.id,
      actorId: user.id,
      at: now,
      type: action,
      from: app.stage,
      to: app.status === "closed" ? "closed" : app.stage,
      note,
    });
  };
  const jobById = (jobId: unknown) =>
    state.jobs.find((job) => job.id === jobId) ??
    fail("NOT_FOUND", "职位不存在", 404);
  const invalidateReview = (app: Application) => {
    if (app.selection) delete app.selection.hrReview;
    app.decision = "pending";
    app.decisionNote = "";
  };
  if (action === "configure_screening") {
    const job = jobById(input.jobId);
    if (job.status === "closed")
      fail("JOB_CLOSED", "已关闭职位不可修改甄选规则");
    const level = text(input.minimumEducation);
    if (!Object.hasOwn(educationLabels, level))
      fail("INVALID_EDUCATION", "请选择有效的最低学历要求");
    if (
      !Array.isArray(input.requiredSkills) ||
      input.requiredSkills.some(
        (skill) =>
          typeof skill !== "string" ||
          !skill.trim() ||
          skill.trim().length > 60,
      ) ||
      input.requiredSkills.length > 30
    )
      fail("INVALID_SKILLS", "必备技能应为最多 30 项、每项 1–60 字符的列表");
    if (
      !Array.isArray(input.graduationYears) ||
      input.graduationYears.length > 20 ||
      input.graduationYears.some(
        (year) => !Number.isInteger(year) || year < 1960 || year > 2100,
      )
    )
      fail("INVALID_YEAR", "毕业年份应为最多 20 项、1960–2100 的整数列表");
    job.screeningPolicy = {
      minimumEducation: level as EducationLevel,
      requiredSkills: [
        ...new Set(
          (input.requiredSkills as string[]).map((skill) => skill.trim()),
        ),
      ],
      graduationYears: [...new Set(input.graduationYears as number[])],
      updatedAt: now,
    };
    state.applications
      .filter((app) => app.jobId === job.id)
      .forEach((app) => {
        const needsReview =
          app.status === "active" &&
          ["new", "screening", "interview"].includes(app.stage);
        if (needsReview) {
          invalidateReview(app);
          if (app.selection?.aiReview && ["pending", "running"].includes(app.selection.aiReview.status))
            app.selection.aiReview = {
              status: "blocked",
              message: "岗位规则已更新，请重新执行岗位初筛后生成 AI 复筛报告。",
              updatedAt: now,
            };
        }
        audit(
          app,
          needsReview
            ? "岗位甄选规则已更新；历史报告保留原规则快照，请按新规则重跑报告；原HR结论及经理决定失效，需重新人工复核。"
            : "岗位甄选规则已更新；保留本投递的历史报告和HR结论，不修改已结束或进入后续阶段的结果。",
        );
      });
    return true;
  }
  if (action === "generate_interview_assist") {
    const card =
      state.scorecards.find((item) => item.id === input.scorecardId) ??
      fail("NOT_FOUND", "面试评价不存在", 404);
    if (card.userId !== user.id)
      fail("FORBIDDEN", "只能对本人已提交的评价生成辅助报告", 403);
    const interview =
      state.interviews.find((item) => item.id === card.interviewId) ??
      fail("NOT_FOUND", "面试不存在", 404);
    if (!interview.interviewerIds.includes(user.id))
      fail("FORBIDDEN", "当前用户不属于该场面试", 403);
    const app =
      state.applications.find((item) => item.id === interview.applicationId) ??
      fail("NOT_FOUND", "投递不存在", 404);
    const job = jobById(app.jobId);
    if (user.role === "manager" && job.managerId !== user.id)
      fail("FORBIDDEN", "仅可查看本人负责岗位的评价", 403);
    card.assistReport = interviewAssist(card, job, now);
    audit(app, "生成本人评价辅助核对报告；固定规则演示，不重新评分。");
    return true;
  }
  const app =
    state.applications.find((item) => item.id === input.applicationId) ??
    fail("NOT_FOUND", "投递不存在", 404);
  if (app.status !== "active")
    fail("APPLICATION_CLOSED", "该投递已结束，不能执行新的甄选操作");
  if (!["new", "screening", "interview"].includes(app.stage))
    fail("SELECTION_STAGE", "进入 Offer 后仅可查看历史甄选报告");
  const job = jobById(app.jobId);
  if (action === "ensure_resume_review" && hasLegacyScreeningApproval(state, app)) return true;
  app.selection ??= { assessments: [] };
  app.selection.assessments ??= [];
  const currentPolicy = screeningPolicy(job);
  const isCurrent = (value: SelectionReport | undefined) =>
    Boolean(
      value?.policy &&
        JSON.stringify(value.policy) === JSON.stringify(currentPolicy),
    );
  switch (action) {
    case "verify_screening_info": {
      const education = text(input.education),
        note = text(input.note);
      if (
        !["unknown", "college", "bachelor", "master", "doctor"].includes(
          education,
        )
      )
        fail("INVALID_EDUCATION", "请选择已核实的学历，无法确认时请选择未知");
      if (
        input.graduationYear !== null &&
        (!Number.isInteger(input.graduationYear) ||
          Number(input.graduationYear) < 1960 ||
          Number(input.graduationYear) > 2100)
      )
        fail("INVALID_YEAR", "毕业年份应为 1960–2100 的整数或未知");
      if (
        !Array.isArray(input.skills) ||
        input.skills.length > 30 ||
        input.skills.some(
          (skill) =>
            typeof skill !== "string" || !skill.trim() || skill.length > 60,
        )
      )
        fail("INVALID_SKILLS", "请以列表提供最多 30 项已核实技能");
      if (note.length < 5 || note.length > 2000)
        fail("REQUIRED", "请填写 5–2000 字符的核实来源和更正依据");
      const before = {
        education: app.snapshot.education ?? "unknown",
        graduationYear: app.snapshot.graduationYear,
        skills: app.snapshot.skills,
      };
      app.snapshot.education = education;
      app.snapshot.graduationYear = input.graduationYear as number | null;
      app.snapshot.skills = [
        ...new Set((input.skills as string[]).map((skill) => skill.trim())),
      ];
      app.selection.ruleReview = runRuleReview(job, app.snapshot, now);
      delete app.selection.resumeReview;
      delete app.selection.aiReview;
      invalidateReview(app);
      app.screeningNote = "";
      audit(
        app,
        `人工核实本投递条件：${JSON.stringify(before)} → ${JSON.stringify({ education, graduationYear: app.snapshot.graduationYear, skills: app.snapshot.skills })}；依据：${note}。已按更正资料重新初筛；旧复筛报告、HR结论及经理决定已失效，需重新人工复核；主档和其他投递未改动。`,
      );
      break;
    }
    case "run_screening":
      app.selection.ruleReview = runRuleReview(job, app.snapshot, now);
      delete app.selection.resumeReview;
      delete app.selection.aiReview;
      invalidateReview(app);
      audit(app, "完成岗位规则初筛；只标记匹配、缺项和未知信息，未自动淘汰；旧简历复筛报告、HR结论及经理决定失效，需重新人工复核。");
      break;
    case "review_resume":
      if (!app.selection.ruleReview)
        fail(
          "SELECTION_RULE_REQUIRED",
          "请先执行岗位规则初筛，再生成简历复筛报告",
        );
      if (!isCurrent(app.selection.ruleReview))
        fail("SELECTION_REPORT_STALE", "岗位规则已更新，请先重新执行规则初筛");
      if (!initialScreeningReady(app.selection.ruleReview))
        fail("INITIAL_SCREENING_REQUIRED", "请先完成岗位线索初筛，再生成 AI 复筛报告");
      if (!app.snapshot.resume.trim())
        fail("RESUME_REQUIRED", "请先上传或填写简历文本，再生成 AI 复筛报告");
      delete app.selection.resumeReview;
      app.selection.aiReview = {
        status: "pending",
        message: "初筛已完成，正在等待 AI 简历复筛；缺项与未知信息将交由 AI 和 HR 核实。",
        updatedAt: now,
      };
      invalidateReview(app);
      audit(app, "请求 AI 简历复筛；旧复筛报告、HR结论及经理决定失效，报告生成后需重新人工复核。");
      break;
    case "ensure_resume_review": {
      app.selection.ruleReview ??= runRuleReview(job, app.snapshot, now);
      const blocker = !isCurrent(app.selection.ruleReview)
        ? "岗位规则已更新，请重新执行岗位初筛后生成 AI 复筛报告。"
        : !initialScreeningReady(app.selection.ruleReview)
          ? "请先完成岗位线索初筛，再生成 AI 复筛报告。"
          : !app.snapshot.resume.trim()
            ? "请先上传或填写简历文本，再生成 AI 复筛报告。"
            : "";
      if (blocker) {
        app.selection.aiReview = { status: "blocked", message: blocker, updatedAt: now };
        audit(app, `AI 简历复筛暂未启动：${blocker}`);
        break;
      }
      if (app.selection.resumeReview?.mode === "llm" && isCurrent(app.selection.resumeReview))
        break;
      delete app.selection.resumeReview;
      app.selection.aiReview = {
        status: "pending",
        message: "初筛已完成，正在等待 AI 简历复筛；缺项与未知信息将交由 AI 和 HR 核实。",
        updatedAt: now,
      };
      invalidateReview(app);
      audit(app, "初筛已完成，已请求 AI 简历复筛；缺项与未知信息交由 AI 和 HR 核实；旧复筛报告、HR结论及经理决定失效，报告生成后需重新人工复核。");
      break;
    }
    case "confirm_screening": {
      const conclusion = text(input.conclusion),
        note = text(input.note);
      if (!["pass", "hold", "reject"].includes(conclusion))
        fail("INVALID_CONCLUSION", "请选择通过、待核实或不通过");
      if (note.length < 5 || note.length > 2000)
        fail("REQUIRED", "请填写 5–2000 字符的人工判断依据");
      if (
        conclusion === "pass" &&
        (!app.selection.ruleReview || app.selection.resumeReview?.mode !== "llm")
      )
        fail(
          "SELECTION_REVIEW_REQUIRED",
          "人工确认通过前，请先执行规则初筛和简历复筛",
        );
      if (
        conclusion === "pass" &&
        (!isCurrent(app.selection.ruleReview) ||
          !isCurrent(app.selection.resumeReview))
      )
        fail(
          "SELECTION_REPORT_STALE",
          "岗位规则已更新，请重新完成初筛和复筛后再确认通过",
        );
      if (conclusion !== "pass") invalidateReview(app);
      app.selection.hrReview = {
        createdAt: now,
        actorId: user.id,
        conclusion: conclusion as "pass" | "hold" | "reject",
        note,
      };
      if (conclusion === "reject") {
        app.status = "closed";
        app.outcome = `人工筛选不通过 · ${note}`;
        state.interviews
          .filter(
            (interview) =>
              interview.applicationId === app.id &&
              interview.status === "scheduled",
          )
          .forEach((interview) => {
            interview.status = "cancelled";
          });
      }
      audit(
        app,
        `HR 人工确认：${conclusion} · ${note}；报告本身不决定流程结果。`,
      );
      break;
    }
    case "assign_assessment": {
      const kind = text(input.kind);
      if (!["written", "preference", "ai_interview"].includes(kind))
        fail(
          "INVALID_ASSESSMENT",
          "请选择岗位笔试、工作偏好问卷或 AI 面试演示",
        );
      if (
        app.selection.assessments.some(
          (item) => item.kind === kind && item.status === "assigned",
        )
      )
        fail(
          "ASSESSMENT_PENDING",
          "该类型已有待作答测评，请先完成现有任务",
          409,
        );
      app.selection.assessments.push(
        createAssessment(kind as AssessmentKind, job, user.id, now),
      );
      audit(app, `派发${kind}演示测评；由 HR 代录合成答卷，未发送真实邀请。`);
      break;
    }
    case "submit_assessment": {
      const index = app.selection.assessments.findIndex(
        (item) => item.id === input.assessmentId,
      );
      if (index < 0) fail("NOT_FOUND", "该投递的测评任务不存在", 404);
      app.selection.assessments[index] = submitAssessment(
        app.selection.assessments[index],
        input.answers,
        now,
      );
      audit(
        app,
        "演示答卷已提交并锁定；保留原始回答和固定规则证据，未自动推进流程。",
      );
      break;
    }
  }
  return true;
}
