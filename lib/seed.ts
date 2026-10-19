import type {
  AppState,
  Application,
  Candidate,
  Job,
  Scorecard,
  User,
} from "./domain.ts";

export const DEMO_USERS: User[] = [
  { id: "hr", name: "林知夏", role: "hr", email: "hr@example.com" },
  {
    id: "manager",
    name: "陈默",
    role: "manager",
    email: "manager@example.com",
  },
  {
    id: "interviewer",
    name: "周予安",
    role: "interviewer",
    email: "interviewer@example.com",
  },
  {
    id: "interviewer2",
    name: "许清禾",
    role: "interviewer",
    email: "interviewer2@example.com",
  },
  {
    id: "admin",
    name: "系统管理员",
    role: "admin",
    email: "admin@example.com",
  },
];

export function createSeed(now = new Date()): AppState {
  const at = (days: number, hour = 10) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const date = (days: number) => at(days).slice(0, 10);
  const jobDefs = [
    [
      "高级产品经理",
      "产品中心",
      "上海",
      "social",
      "产品规划,用户研究,数据分析",
    ],
    ["前端开发工程师", "研发中心", "上海", "social", "React,TypeScript,工程化"],
    ["数据分析师", "数据中心", "杭州", "social", "SQL,Python,数据分析"],
    ["用户体验设计师", "设计中心", "上海", "social", "Figma,交互设计,用户研究"],
    ["产品培训生", "产品中心", "上海", "campus", "产品思维,用户研究,沟通表达"],
    ["研发培训生", "研发中心", "北京", "campus", "算法,Java,计算机基础"],
    [
      "市场运营专员",
      "市场中心",
      "深圳",
      "social",
      "内容运营,增长分析,活动策划",
    ],
    ["数据分析实习生", "数据中心", "杭州", "campus", "SQL,统计学,Python"],
  ];
  const jobs: Job[] = jobDefs.map((d, i) => ({
    id: `job_${i + 1}`,
    title: d[0],
    department: d[1],
    location: d[2],
    type: d[3] as Job["type"],
    batch: d[3] === "campus" ? "2027 届秋季校园招聘" : "",
    graduationYears: d[3] === "campus" ? [2027] : [],
    headcount: [2, 4, 2, 1, 6, 8, 2, 3][i],
    ownerId: "hr",
    managerId: "manager",
    status: i === 6 ? "pending" : i === 7 ? "paused" : "open",
    description: `参与${d[1]}的关键业务，负责${d[4].split(",")[0]}相关工作。期待有主动性、善于协作的伙伴，共同解决真实用户问题。`,
    skills: d[4].split(","),
    dimensions: ["专业能力", "问题解决", "沟通协作", "岗位匹配"],
    createdAt: at(-35 - i),
  }));
  const names = [
    "沈星河",
    "赵一诺",
    "李思远",
    "王可欣",
    "陈景行",
    "刘沐言",
    "杨书瑶",
    "黄子墨",
    "周若初",
    "吴思齐",
    "徐嘉宁",
    "孙明轩",
    "胡语桐",
    "朱亦辰",
    "高芷晴",
    "林逸凡",
    "何予涵",
    "郭清越",
    "马星冉",
    "罗时安",
    "梁乐知",
    "宋知微",
    "郑景初",
    "谢雨桐",
    "唐一舟",
    "韩以宁",
    "冯思源",
    "于念安",
    "董嘉禾",
    "萧云舒",
    "程亦宁",
    "曹知远",
    "许言蹊",
    "邓清和",
    "苏沐晨",
    "叶书宁",
  ];
  const schools = [
    "复旦大学",
    "上海交通大学",
    "浙江大学",
    "同济大学",
    "华东师范大学",
    "北京大学",
  ];
  const candidates: Candidate[] = names.map((name, i) => ({
    id: `candidate_${i + 1}`,
    name,
    email: `candidate${i + 1}@example.com`,
    phone: `1990000${String(i + 1).padStart(4, "0")}`,
    school: schools[i % schools.length],
    major: ["计算机科学", "信息管理", "统计学", "工业设计"][i % 4],
    graduationYear: [2021, 2022, 2027, 2027][i % 4],
    skills: jobs[i % 6].skills.slice(),
    resume: `${name}，${schools[i % schools.length]}毕业。具备${jobs[i % 6].skills.join("、")}相关实践经历，曾参与团队项目并负责需求分析与结果复盘。擅长跨团队沟通，关注用户反馈和业务结果。`,
    availability: i % 3 ? "Offer 后 2 周" : "随时到岗",
    createdAt: at(-28 + (i % 15)),
  }));
  const stages: Application["stage"][] = [
    ...Array(8).fill("new"),
    ...Array(8).fill("screening"),
    ...Array(12).fill("interview"),
    ...Array(4).fill("offer"),
    ...Array(6).fill("onboarding"),
    ...Array(4).fill("joined"),
  ];
  const applications: Application[] = stages.map((stage, i) => {
    const candidate = candidates[i % candidates.length];
    const job = jobs[(i + (i >= candidates.length ? 1 : 0)) % 6];
    if (job.type === "campus") candidate.graduationYear = 2027;
    return {
      id: `application_${i + 1}`,
      candidateId: candidate.id,
      jobId: job.id,
      snapshot: structuredClone(candidate),
      stage,
      status: stage === "joined" ? "joined" : "active",
      outcome: stage === "joined" ? "已入职" : "",
      source: [
        "猎聘",
        "BOSS 直聘",
        "内推",
        "官网投递",
        "校园宣讲会",
        "院校推荐",
      ][i % 6],
      ownerId: "hr",
      createdAt: at(-25 + (i % 12)),
      updatedAt: at(-(i % 5)),
      version: 1,
      screeningNote: ["interview", "offer", "onboarding", "joined"].includes(
        stage,
      )
        ? "经历与岗位关键能力匹配，已完成电话沟通，建议进入面试。"
        : "",
      decision: ["offer", "onboarding", "joined"].includes(stage)
        ? "hire"
        : "pending",
      decisionNote: ["offer", "onboarding", "joined"].includes(stage)
        ? "能力与团队需求匹配，建议录用。"
        : "",
      offer: {
        status:
          stage === "offer"
            ? "sent"
            : ["onboarding", "joined"].includes(stage)
              ? "accepted"
              : "none",
        sentAt: ["offer", "onboarding", "joined"].includes(stage) ? at(-4) : "",
        deadline: ["offer", "onboarding", "joined"].includes(stage)
          ? at(i === 28 ? -1 : 5)
          : "",
        answeredAt: ["onboarding", "joined"].includes(stage) ? at(-2) : "",
        reference: ["offer", "onboarding", "joined"].includes(stage)
          ? `DEMO-OFFER-${1000 + i}`
          : "",
      },
      agreement: {
        type: job.type === "campus" ? "三方协议" : "劳动合同",
        status:
          stage === "joined" || (stage === "onboarding" && i % 2 === 0)
            ? "signed"
            : "pending",
        date: stage === "joined" ? date(-1) : "",
        note: "",
      },
      plannedJoinDate:
        stage === "onboarding"
          ? date(i === 32 ? 0 : i - 31)
          : stage === "joined"
            ? date(-2)
            : "",
      joinedAt: stage === "joined" ? at(-2) : "",
    };
  });
  const state: AppState = {
    revision: 1,
    seededAt: now.toISOString(),
    users: structuredClone(DEMO_USERS),
    jobs,
    candidates,
    applications,
    interviews: [],
    scorecards: [],
    events: [],
    imports: [],
  };
  applications.forEach((app, i) => {
    if (!["interview", "offer", "onboarding", "joined"].includes(app.stage))
      return;
    const scheduled = app.stage === "interview" && i < 22;
    const interviewId = `interview_${i + 1}`;
    const day = scheduled ? Math.floor((i - 16) / 2) : -3 - (i % 3);
    const hour = scheduled ? 2 + (i % 2) * 3 : 3;
    state.interviews.push({
      id: interviewId,
      applicationId: app.id,
      round: i % 3 ? "专业一面" : "综合复试",
      start: at(day, hour),
      end: at(day, hour + 1),
      interviewerIds: i % 2 ? ["interviewer"] : ["interviewer", "interviewer2"],
      location: i % 2 ? "腾讯会议 · 线下面试替代场景" : "上海 · 会议室 A",
      status: scheduled ? "scheduled" : "completed",
      notified: i % 3 !== 0,
    });
    state.interviews[state.interviews.length - 1].interviewerIds.forEach(
      (userId, n) => {
        const submitted =
          !scheduled && (app.stage !== "interview" || i % 3 !== 1 || n === 1);
        const card: Scorecard = {
          id: `scorecard_${i + 1}_${n}`,
          interviewId,
          userId,
          ratings: Object.fromEntries(
            jobs
              .find((j) => j.id === app.jobId)!
              .dimensions.map((dimension, index) => [
                dimension,
                submitted ? 3 + ((i + index) % 3) : null,
              ]),
          ),
          evidence: submitted
            ? "能清晰拆解项目目标，说明个人负责范围，并以具体业务指标验证结果。协作案例较完整。"
            : "",
          recommendation: submitted ? "建议录用" : "",
          status: submitted ? "submitted" : "draft",
          submittedAt: submitted ? at(-2) : "",
        };
        state.scorecards.push(card);
      },
    );
  });
  // Snapshot is frozen at application creation, after campus eligibility is established.
  state.applications.forEach((app) => {
    app.snapshot = structuredClone(
      candidates.find((c) => c.id === app.candidateId)!,
    );
    const route: Application["stage"][] = [
      "new",
      "screening",
      "interview",
      "offer",
      "onboarding",
      "joined",
    ];
    route
      .slice(0, route.indexOf(app.stage) + 1)
      .forEach((stage, index) =>
        state.events.push({
          id: `event_${app.id}_${index}`,
          applicationId: app.id,
          actorId: "hr",
          at:
            stage === "offer"
              ? app.offer.sentAt
              : stage === "onboarding"
                ? app.offer.answeredAt
                : stage === "joined"
                  ? app.joinedAt
                  : new Date(
                      new Date(app.createdAt).getTime() + index * 86400000,
                    ).toISOString(),
          type: index ? "advanced" : "created",
          from: index ? route[index - 1] : "",
          to: stage,
          note: index
            ? "合成演示数据：阶段推进"
            : `通过${app.source}创建投递（合成演示数据）`,
        }),
      );
  });
  return state;
}
