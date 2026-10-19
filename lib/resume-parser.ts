export interface ResumeFields {
  name: string;
  email: string;
  phone: string;
  school: string;
  major: string;
  education: string;
  graduationYear: string;
  skills: string;
  resume: string;
  availability: string;
}
export interface ResumeParseResult {
  fields: Partial<ResumeFields>;
  evidence: Partial<Record<keyof ResumeFields, string>>;
  warnings: string[];
}

type Section = "profile" | "education" | "experience" | "skills" | "excluded";
type Line = { text: string; section: Section };
type Match = { value: string; source: string };
const labels = {
  name: [
    "候选人姓名",
    "应聘者姓名",
    "姓名",
    "Full Name",
    "Applicant Name",
    "Candidate Name",
    "Name",
  ],
  email: [
    "候选人邮箱",
    "电子邮箱",
    "电子邮件",
    "联系邮箱",
    "邮箱",
    "E-mail",
    "Email",
  ],
  phone: [
    "候选人手机",
    "手机号码",
    "联系电话",
    "手机",
    "电话",
    "Mobile Phone",
    "Phone Number",
    "Mobile",
    "Telephone",
    "Phone",
    "Tel",
  ],
  school: [
    "毕业院校",
    "就读院校",
    "毕业学校",
    "院校",
    "学校",
    "University",
    "College",
    "Institution",
    "School",
  ],
  major: ["所学专业", "专业名称", "专业", "Field of Study", "Major"],
  education: [
    "最高学历",
    "最高学位",
    "学历",
    "学位",
    "Highest Education",
    "Highest Degree",
    "Education Level",
    "Qualification",
    "Degree",
  ],
  graduationYear: [
    "预计毕业时间",
    "毕业年份",
    "毕业年度",
    "毕业时间",
    "毕业日期",
    "毕业届别",
    "毕业届次",
    "届别",
    "届次",
    "Expected Graduation",
    "Year of Graduation",
    "Graduation Year",
    "Graduation Date",
    "Graduation",
    "Class of",
  ],
  skills: [
    "专业技能",
    "技能清单",
    "技能特长",
    "个人技能",
    "技术栈",
    "技能",
    "Technical Skills",
    "Skill Set",
    "Skills",
  ],
  availability: [
    "可到岗时间",
    "最快到岗时间",
    "到岗时间",
    "到岗日期",
    "可入职时间",
    "可入职日期",
    "Available to Start",
    "Available From",
    "Availability",
    "Start Date",
  ],
} satisfies Record<Exclude<keyof ResumeFields, "resume">, string[]>;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundaryLabels = [
  ...Object.values(labels).flat(),
  "性别",
  "年龄",
  "现居地",
  "地址",
  "求职意向",
  "Gender",
  "Age",
  "Location",
  "Address",
];
const nextLabel = new RegExp(
  `\\s+(?:${boundaryLabels
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|")})\\s*[:：]`,
  "i",
);
const otherPerson =
  /推荐人|推荐信|证明人|紧急联系人|导师(?:的)?(?:姓名|邮箱|电话)|招聘联系人|招聘邮箱|投递邮箱|HR\s*(?:邮箱|联系)|\b(?:referee|references?|referral|recruiter|mentor|supervisor|emergency contact|hiring contact|company email|employer email)\b/i;

function linesOf(text: string): Line[] {
  let section: Section = "profile";
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (
      /^(?:个人信息|基本信息|联系方式|个人资料|Personal (?:Information|Details)|Contact (?:Information|Details))\s*(?:[:：]|$)/i.test(
        line,
      )
    )
      section = "profile";
    else if (
      section !== "excluded" &&
      /^(?:教育经历|教育背景|学历背景|Education(?:al)?(?: Background| History)?|Academic Background)\s*(?:[:：]|$)/i.test(
        line,
      )
    )
      section = "education";
    else if (
      section !== "excluded" &&
      /^(?:工作经历|工作经验|职业经历|项目经历|实习经历|Work Experience|Employment(?: History)?|Career History|Experience|Projects?)\s*(?:[:：]|$)/i.test(
        line,
      )
    )
      section = "experience";
    else if (
      section !== "excluded" &&
      /^(?:专业技能|技能清单|技能特长|技能|Technical Skills|Skills)\s*(?:[:：]|$)/i.test(
        line,
      )
    )
      section = "skills";
    else if (
      /^(?:岗位要求|职位要求|任职要求|招聘要求|岗位职责|职位描述|Job (?:Requirements?|Description)|Requirements?|References?|Referees?|推荐人|证明人|推荐信息)\s*(?:[:：]|$)/i.test(
        line,
      )
    )
      section = "excluded";
    return {
      text: line,
      section: otherPerson.test(line) ? ("excluded" as const) : section,
    };
  });
}
function labeled(
  lines: Line[],
  aliases: string[],
  sections: Section[],
): Match[] {
  const pattern = new RegExp(
    `(?:^|[\\s|｜;；])(?:${aliases.map(escape).join("|")})\\s*(?:[:：]\\s*|\\s{2,})([^|｜;；]+)`,
    "gi",
  );
  const matches: Match[] = [];
  for (const line of lines) {
    if (!sections.includes(line.section)) continue;
    pattern.lastIndex = 0;
    for (const match of line.text.matchAll(pattern)) {
      const value = match[1].split(nextLabel)[0].trim();
      if (value) matches.push({ value, source: line.text });
    }
  }
  return matches;
}
function unique(
  matches: Match[],
  key = (value: string) => value.toLocaleLowerCase(),
): Match[] {
  const found = new Map<string, Match>();
  for (const match of matches)
    if (!found.has(key(match.value))) found.set(key(match.value), match);
  return [...found.values()];
}
function degrees(value: string): string[] {
  const patterns: [string, RegExp][] = [
    ["doctor", /博士|\b(?:Ph\.?\s?D\.?|Doctorate|Doctor of [A-Za-z ]+)\b/i],
    [
      "master",
      /硕士|研究生|\b(?:Master(?:'s)?(?: of [A-Za-z ]+)?|M\.?Sc\.?|M\.?Eng\.?)\b/i,
    ],
    [
      "bachelor",
      /本科|学士|\b(?:Bachelor(?:'s)?(?: of [A-Za-z ]+)?|B\.?Sc\.?|B\.?Eng\.?)\b/i,
    ],
    [
      "college",
      /大专|专科|\b(?:Associate(?:'s)?(?: Degree)?|College Diploma)\b/i,
    ],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(value))
    .map(([level]) => level);
}
const defaultSkills = [
  "TypeScript",
  "JavaScript",
  "React",
  "Vue",
  "Angular",
  "Node.js",
  "Python",
  "Java",
  "Go",
  "C++",
  "C#",
  "SQL",
  "MySQL",
  "PostgreSQL",
  "Figma",
  "Axure",
  "Excel",
  "Tableau",
  "Power BI",
  "用户研究",
  "产品规划",
  "产品设计",
  "交互设计",
  "数据分析",
  "统计分析",
  "项目管理",
];
const knownMajors = [
  "计算机科学与技术",
  "信息管理与信息系统",
  "电子信息工程",
  "软件工程",
  "计算机科学",
  "信息管理",
  "统计学",
  "工业设计",
  "工商管理",
  "应用数学",
  "金融学",
  "会计学",
  "Computer Science",
  "Software Engineering",
  "Information Systems",
  "Statistics",
];
function tokenPattern(token: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_+#])${escape(token)}(?![A-Za-z0-9_+#])`,
    "i",
  );
}
function isNegated(source: string, token: string): boolean {
  return new RegExp(
    `(?:不熟悉|不具备|未掌握|不会|不了解|没有|缺乏|no experience (?:with|in)|not familiar with)\\s*${escape(token)}`,
    "i",
  ).test(source);
}

// This parser reads labeled facts and literal text only. Resume instructions are never executed.
export function parseResumeText(
  text: string,
  jobSkills: string[] = [],
): ResumeParseResult {
  const fields: Partial<ResumeFields> = { education: "unknown" };
  const evidence: ResumeParseResult["evidence"] = {};
  const warnings: string[] = [];
  const source =
    typeof text === "string"
      ? text
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n")
          .trim()
      : "";
  if (!source)
    return {
      fields,
      evidence,
      warnings: ["简历没有可识别的文本，请重新上传或手工填写。"],
    };
  fields.resume = source.slice(0, 20000);
  evidence.resume = source.slice(0, 300);
  if (source.length > 20000)
    warnings.push(
      "简历正文超过 20,000 字符，表单仅保留前 20,000 字符；请核对后补充需要保留的内容。",
    );
  if (source.length > 100000)
    warnings.push("文本超过 100,000 字符，仅扫描前 100,000 字符进行字段识别。");
  const lines = linesOf(source.slice(0, 100000));
  const profile = ["profile"] as Section[];
  const education = ["profile", "education"] as Section[];
  function choose(
    field: keyof ResumeFields,
    matches: Match[],
    label: string,
  ): boolean {
    const values = unique(matches);
    if (values.length > 1) {
      warnings.push(`${label}存在多个不同值，未自动填写，请人工核实。`);
      evidence[field] = values.map((match) => match.source).join("\n");
      return false;
    }
    if (values.length === 1) {
      fields[field] = values[0].value;
      evidence[field] = values[0].source;
      return true;
    }
    return false;
  }

  const names = labeled(lines, labels.name, profile)
    .map((match) => ({
      ...match,
      value: match.value.replace(/^(?:Mr|Mrs|Ms|Dr)\.?\s+/i, "").trim(),
    }))
    .filter(
      (match) =>
        /^[\p{L}][\p{L} .·'’\-]{1,59}$/u.test(match.value) &&
        !/简历|求职|应聘|工程师|产品经理|联系人/.test(match.value),
    );
  choose("name", names, "姓名");

  const emailRegex =
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;
  const emailLabels = labeled(lines, labels.email, profile);
  const emailLines = emailLabels.length
    ? emailLabels
    : lines
        .filter((line) => line.section === "profile")
        .map((line) => ({ value: line.text, source: line.text }));
  const emails = emailLines.flatMap((line) =>
    [...line.value.matchAll(emailRegex)].map((match) => ({
      value: match[0].toLowerCase(),
      source: line.source,
    })),
  );
  choose("email", emails, "邮箱");

  const phoneLabels = labeled(lines, labels.phone, profile);
  const phoneLines = phoneLabels.length
    ? phoneLabels
    : lines
        .filter((line) => line.section === "profile")
        .map((line) => ({ value: line.text, source: line.text }));
  const phones: Match[] = [];
  for (const line of phoneLines) {
    const domestic = [
      ...line.value.matchAll(
        /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
      ),
    ];
    domestic.forEach((match) =>
      phones.push({
        value: match[0].replace(/[\s-]/g, "").replace(/^\+?86(?=1\d{10}$)/, ""),
        source: line.source,
      }),
    );
    if (!domestic.length && phoneLabels.length) {
      for (const part of line.value.split(/[,，;；/]|\s+or\s+/i)) {
        const match = part.match(/\+\d[\d\s().-]{6,}\d/);
        const value = match?.[0].replace(/[\s().-]/g, "");
        if (value && /^\+\d{8,15}$/.test(value))
          phones.push({ value, source: line.source });
      }
    }
  }
  choose(
    "phone",
    unique(phones, (value) => value.replace(/^\+?86(?=1\d{10}$)/, "")),
    "手机",
  );

  const schoolLabels = labeled(lines, labels.school, education);
  const schools = schoolLabels.length
    ? schoolLabels
    : lines
        .filter((line) => line.section === "education")
        .flatMap((line) => {
          const matches = [
            ...line.text.matchAll(
              /(?:^|[\s,，;；|｜:：])([\p{Script=Han}]{2,24}(?:大学|学院|学校|中学))(?=$|[\s,，;；|｜()（）])/gu,
            ),
          ];
          return matches.map((match) => ({
            value: match[1].replace(/^(?:毕业于|就读于)/, ""),
            source: line.text,
          }));
        });
  choose("school", schools, "院校");
  const majorLabels = labeled(lines, labels.major, education);
  const majors = majorLabels.length
    ? majorLabels
    : lines
        .filter((line) => line.section === "education")
        .flatMap((line) =>
          knownMajors
            .filter(
              (major) =>
                tokenPattern(major).test(line.text) &&
                !knownMajors.some(
                  (other) =>
                    other.length > major.length &&
                    other.includes(major) &&
                    line.text.includes(other),
                ),
            )
            .map((value) => ({ value, source: line.text })),
        );
  choose("major", majors, "专业");

  const highest = labeled(
    lines,
    ["最高学历", "最高学位", "Highest Education", "Highest Degree"],
    education,
  );
  const degreeLines = highest.length
    ? highest
    : labeled(lines, labels.education, education);
  const degreeSources = degreeLines.length
    ? degreeLines
    : lines
        .filter((line) => line.section === "education")
        .map((line) => ({ value: line.text, source: line.text }));
  const degreeMatches: Match[] = [];
  for (const line of degreeSources) {
    if (
      /在读|肄业|未毕业|未取得|候选学位|预计|\b(?:pursuing|expected|candidate for|in progress|incomplete)\b/i.test(
        line.value,
      )
    ) {
      warnings.push(
        "学历文本含在读、预计或未取得等信息，未自动认定已取得学历，请人工核实。",
      );
      continue;
    }
    degrees(line.value).forEach((value) =>
      degreeMatches.push({ value, source: line.source }),
    );
  }
  choose("education", degreeMatches, "最高学历");

  const graduation: Match[] = [];
  for (const line of labeled(lines, labels.graduationYear, education)) {
    const years = [...line.value.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)];
    years.forEach((match) =>
      graduation.push({ value: match[0], source: line.source }),
    );
  }
  for (const line of lines.filter((line) => education.includes(line.section))) {
    for (const match of line.text.matchAll(
      /(?<!\d)((?:19|20)\d{2})\s*(?:年\s*)?(?:届|(?:年?\s*\d{1,2}\s*月\s*)?毕业)/gu,
    ))
      graduation.push({ value: match[1], source: line.text });
  }
  for (const line of lines.filter((line) => education.includes(line.section))) {
    const match = line.text.match(/\bclass\s+of\s+((?:19|20)\d{2})\b/i);
    if (match) graduation.push({ value: match[1], source: line.text });
  }
  choose("graduationYear", graduation, "毕业届别");

  const skillMatches: Match[] = [];
  for (const line of labeled(lines, labels.skills, ["profile", "skills"])) {
    for (const raw of line.value.split(/[,，、;；|｜/]/)) {
      const value = raw
        .replace(/^(?:熟练(?:掌握|使用)?|熟悉|精通|掌握|了解|擅长|具备)\s*/, "")
        .replace(/[（(](?:熟练|精通|熟悉|了解)[）)]$/, "")
        .trim();
      if (
        value &&
        value.length <= 60 &&
        !/不熟悉|不具备|未掌握|不会|不了解|没有|缺乏/.test(raw)
      )
        skillMatches.push({ value, source: line.source });
    }
  }
  const dictionary = unique(
    [...jobSkills, ...defaultSkills]
      .filter(
        (value) =>
          typeof value === "string" &&
          value.trim().length <= 60 &&
          value.trim(),
      )
      .map((value) => ({ value: value.trim(), source: "" })),
  );
  for (const skill of dictionary) {
    const match = lines.find(
      (line) =>
        line.section !== "excluded" &&
        !/求职意向|意向岗位|期望职位|职位需求|岗位要求|招聘要求|\b(?:desired role|target role|job requirements?)\b/i.test(
          line.text,
        ) &&
        tokenPattern(skill.value).test(line.text) &&
        !isNegated(line.text, skill.value),
    );
    if (match) skillMatches.push({ value: skill.value, source: match.text });
  }
  const skills = unique(skillMatches);
  if (skills.length) {
    fields.skills = skills
      .slice(0, 30)
      .map((match) => match.value)
      .join(", ");
    evidence.skills = [
      ...new Set(skills.slice(0, 30).map((match) => match.source)),
    ].join("\n");
  }
  if (skills.length > 30)
    warnings.push("识别到超过 30 项技能，仅填入前 30 项，请人工核实取舍。");

  const availability = labeled(lines, labels.availability, [
    "profile",
    "education",
    "skills",
  ]);
  if (!availability.length) {
    for (const line of lines.filter((line) => line.section === "profile")) {
      const match = line.text.match(
        /随时到岗|随时入职|(?:一|两|二|三|四|\d+)周内到岗|(?:Offer|录用|离职)后(?:一|两|二|三|四|\d+)(?:个)?(?:工作日|天|周)(?:内)?(?:到岗|入职)?/i,
      );
      if (match) availability.push({ value: match[0], source: line.text });
    }
  }
  choose("availability", availability, "可到岗时间");
  const fieldLabels: Partial<Record<keyof ResumeFields, string>> = {
    name: "姓名",
    email: "邮箱",
    phone: "手机",
    school: "院校",
    major: "专业",
    education: "最高学历",
    graduationYear: "毕业届别",
    skills: "技能",
    availability: "可到岗时间",
  };
  for (const [field, label] of Object.entries(fieldLabels)) {
    const value = fields[field as keyof ResumeFields];
    if (
      (!value || value === "unknown") &&
      !warnings.some((warning) => warning.startsWith(`${label}存在`))
    )
      warnings.push(`未识别明确${label}，请人工核实。`);
  }
  return { fields, evidence, warnings: [...new Set(warnings)] };
}
