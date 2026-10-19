"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  GraduationCap,
  MapPin,
  Search,
  SearchX,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { PublicJob, PublicReceipt } from "@/lib/careers";
import { extractResumeFile } from "@/lib/resume-file";
import { parseResumeText, type ResumeFields } from "@/lib/resume-parser";
import { Badge, ErrorMessage, Field, Spinner } from "./ui";

const emptyFields: ResumeFields = {
  name: "",
  email: "",
  phone: "",
  school: "",
  major: "",
  education: "unknown",
  graduationYear: "",
  skills: "",
  resume: "",
  availability: "",
};

function JobMeta({ job }: { job: PublicJob }) {
  return (
    <div className="career-job-meta">
      <span><Building2 size={15} />{job.department}</span>
      <span><MapPin size={15} />{job.location}</span>
      <span>{job.type === "campus" ? <GraduationCap size={16} /> : <BriefcaseBusiness size={15} />}{job.type === "campus" ? "校园招聘" : "社会招聘"}</span>
    </div>
  );
}

export default function Careers() {
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [requestedJob, setRequestedJob] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [city, setCity] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setRequestedJob(new URLSearchParams(window.location.search).get("job") || "");
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await fetch("/api/careers", { cache: "no-store", signal: controller.signal });
        const result = await response.json() as { jobs: PublicJob[]; message?: string };
        if (!response.ok) throw new Error(result.message || "职位暂时加载失败，请稍后重试。");
        setJobs(result.jobs);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "职位加载失败，请稍后重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);
  const job = jobs.find((item) => item.id === requestedJob);
  const search = query.trim().toLowerCase();
  const visible = jobs.filter((item) =>
    (type === "all" || item.type === type) &&
    (!city || item.location === city) &&
    (!search || [item.title, item.department, ...item.skills].join(" ").toLowerCase().includes(search)),
  );
  return (
    <div className="careers-page">
      <a href="#career-main" className="career-skip">跳至主要内容</a>
      <header className="career-header">
        <a className="career-brand" href="/careers" aria-label="拾才招聘首页">
          <span className="brand-icon">T</span>
          <span>拾才 <small>TalentFlow</small></span>
        </a>
        <nav aria-label="招聘导航">
          <a className="career-nav-current" href="/careers">在招职位</a>
          <a href="/">企业工作台 <ArrowUpRight size={14} /></a>
        </nav>
      </header>
      <div className="career-demo"><ShieldCheck size={15} /><span>招聘体验演示 · 请使用合成资料投递，勿提交真实个人信息。</span></div>
      <main id="career-main" className="career-main">
        {loading ? (
          <div className="career-loading" aria-busy="true" aria-label="正在加载招聘职位">
            <div /><div /><div />
            <p><Spinner /> 正在获取最新职位</p>
          </div>
        ) : error ? (
          <section className="career-empty">
            <SearchX size={30} /><h1>暂时无法加载职位</h1><p role="alert">{error}</p>
            <button className="button primary" onClick={() => setReload((value) => value + 1)}>重新加载</button>
          </section>
        ) : requestedJob ? job ? (
          <>
            <a href="/careers" className="career-back"><ArrowLeft size={16} />所有职位</a>
            <div className="career-detail-grid">
              <section className="career-job-detail">
                <div className="eyebrow">YOUR NEXT CHAPTER</div>
                <div className="career-title-row"><Badge tone={job.type === "campus" ? "violet" : "blue"}>{job.type === "campus" ? "校园招聘" : "社会招聘"}</Badge><span className="career-open"><span />招聘中</span></div>
                <h1>{job.title}</h1>
                <JobMeta job={job} />
                {job.batch && <p className="career-batch">{job.batch}</p>}
                <a className="button primary career-mobile-apply" href="#career-application">投递这个职位 <ArrowRight size={16} /></a>
                <div className="career-job-section"><h2>关于这个职位</h2><p className="career-description">{job.description || "职位详情待补充，欢迎提交简历，由招聘人员进一步沟通。"}</p></div>
                {job.skills.length > 0 && <div className="career-job-section"><h2>我们关注的技能</h2><div className="career-skills">{job.skills.map((skill) => <span key={skill}>{skill}</span>)}</div></div>}
                {job.type === "campus" && job.graduationYears.length > 0 && <div className="career-job-section"><h2>面向毕业届别</h2><p>{job.graduationYears.map((year) => `${year} 届`).join("、")}</p></div>}
                <div className="career-process"><h2>投递之后，会发生什么？</h2><ol><li><span>01</span><div><strong>招聘团队查看简历</strong><p>资料进入该职位的候选人列表，等待人工查看。</p></div></li><li><span>02</span><div><strong>进一步沟通与面试</strong><p>如有合适机会，招聘人员会通过你填写的联系方式联系。</p></div></li><li><span>03</span><div><strong>反馈与后续安排</strong><p>后续进展由招聘团队沟通，请留意邮箱与电话。</p></div></li></ol></div>
              </section>
              <ApplicationForm key={job.id} job={job} />
            </div>
          </>
        ) : (
          <section className="career-empty"><BriefcaseBusiness size={30} /><h1>这个职位暂未开放</h1><p>职位可能已暂停或结束招聘，看看其他机会吧。</p><a className="button primary" href="/careers">浏览在招职位 <ArrowRight size={16} /></a></section>
        ) : (
          <>
            <section className="career-intro">
              <div><div className="eyebrow">OPPORTUNITIES AT TALENTFLOW</div><h1>你的下一站，<br /><span>从这里开始。</span></h1><p>找到适合你的职位，让我们从一份简历开始了解。</p></div>
              <aside className="career-intro-note"><span className="career-note-icon"><FileText size={24} /></span><h2>好机会，直接投。</h2><p>选职位 · 传简历 · 确认投递</p><small>无需企业账号，提交后即可获得回执。</small><a href="#career-jobs">探索在招职位 <ArrowRight size={16} /></a></aside>
            </section>
            <section id="career-jobs" aria-labelledby="career-jobs-title">
              <div className="career-section-head"><div><h2 id="career-jobs-title">寻找你的机会 <span>{jobs.length}</span></h2><p>社会招聘与校园招聘，都在这里。</p></div></div>
              <div className="career-filters">
                <div className="career-search"><Search size={18} /><input aria-label="搜索职位、部门或技能" placeholder="搜索职位、部门或技能" type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
                <select aria-label="工作城市" value={city} onChange={(event) => setCity(event.target.value)}><option value="">所有城市</option>{[...new Set(jobs.map((item) => item.location))].sort().map((location) => <option key={location} value={location}>{location}</option>)}</select>
              </div>
              <div className="career-list-head"><div className="career-types" aria-label="招聘类型">{[["all", "全部职位"], ["social", "社会招聘"], ["campus", "校园招聘"]].map(([value, label]) => <button key={value} aria-pressed={type === value} className={type === value ? "active" : ""} onClick={() => setType(value)}>{label}</button>)}</div><span aria-live="polite">{visible.length} 个职位</span></div>
              {visible.length ? <div className="career-jobs">{visible.map((item) => <a className="career-job-card" href={`/careers?job=${encodeURIComponent(item.id)}`} key={item.id}><div><div className="career-card-type"><span>{item.type === "campus" ? "CAMPUS" : "EXPERIENCED"}</span><Badge tone={item.type === "campus" ? "violet" : "blue"}>{item.type === "campus" ? "校招" : "社招"}</Badge></div><h3>{item.title}</h3><JobMeta job={item} /><div className="career-card-skills">{item.skills.slice(0, 3).map((skill) => <span key={skill}>{skill}</span>)}</div></div><span className="career-card-cta">查看并投递 <ArrowUpRight size={18} /></span></a>)}</div> : <div className="career-empty"><SearchX size={30} /><h3>{jobs.length ? "暂时没有匹配的职位" : "暂时没有开放职位"}</h3><p>{jobs.length ? "试试其他关键词、城市或招聘类型。" : "招聘机会更新后将在这里展示，欢迎之后再来。"}</p>{jobs.length > 0 && <button className="button" onClick={() => { setQuery(""); setCity(""); setType("all"); }}>清除筛选条件</button>}</div>}
            </section>
          </>
        )}
      </main>
      <footer className="career-footer"><span>拾才 TalentFlow · 招聘机会</span><span>从相互了解，到一起工作。</span></footer>
    </div>
  );
}

function ApplicationForm({ job }: { job: PublicJob }) {
  const [fields, setFields] = useState<ResumeFields>({ ...emptyFields });
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState("");
  const [parseNote, setParseNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<PublicReceipt | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef("");
  const requestBody = useRef("");
  const changed = useRef(new Set<keyof ResumeFields>());
  const sequence = useRef(0);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const parsingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    if (receipt) document.getElementById("career-receipt-title")?.focus();
  }, [receipt]);
  function change(key: keyof ResumeFields, value: string) {
    changed.current.add(key);
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  async function readFile(file: File) {
    if (savingRef.current) return;
    const current = ++sequence.current;
    parsingRef.current = true;
    setParsing(true);
    setFileName("");
    setParseError("");
    setParseNote("");
    try {
      const { text } = await extractResumeFile(file);
      if (!mounted.current || sequence.current !== current) return;
      const result = parseResumeText(text, job.skills);
      result.fields.resume = text;
      setFields((previous) => {
        const next = { ...previous };
        for (const key of Object.keys(emptyFields) as Array<keyof ResumeFields>) {
          if ((!next[key].trim() || (key === "education" && next[key] === "unknown")) && !changed.current.has(key) && result.fields[key]) next[key] = result.fields[key];
        }
        return next;
      });
      setFileName(file.name);
      setParseNote("简历已读取，仅补充了空缺且未编辑的资料。请核对下方信息与简历正文后提交。");
    } catch (cause) {
      if (mounted.current && sequence.current === current) setParseError(cause instanceof Error ? cause.message : "读取失败，请更换文件或直接粘贴简历正文。");
    } finally {
      if (mounted.current && sequence.current === current) { parsingRef.current = false; setParsing(false); }
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || parsingRef.current || receipt) return;
    setError("");
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        jobId: job.id,
        candidate: {
          ...fields,
          graduationYear: fields.graduationYear ? Number(fields.graduationYear) : null,
          skills: [...new Set(fields.skills.split(/[,，;；\n]/).map((value) => value.trim()).filter(Boolean))],
        },
        consent,
      };
      const serialized = JSON.stringify(payload);
      if (!requestId.current || requestBody.current !== serialized) {
        requestId.current = crypto.randomUUID();
        requestBody.current = serialized;
      }
      const response = await fetch("/api/careers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: requestId.current }),
      });
      const result = await response.json() as { receipt: PublicReceipt; message?: string };
      if (!response.ok) throw new Error(result.message || "投递尚未完成，请核对资料后重试。");
      if (mounted.current) setReceipt(result.receipt);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "网络暂时不可用，请重试。相同资料重试不会重复投递。");
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  if (receipt) return (
    <section className="career-application career-receipt" aria-live="polite">
      <span className="career-success-icon"><CheckCircle2 size={32} /></span>
      <Badge tone="green">已投递 · 待 HR 查看</Badge>
      <h2 id="career-receipt-title" tabIndex={-1}>简历已送达。</h2>
      <p>感谢你的关注，招聘团队已收到本次投递。</p>
      <dl><div><dt>应聘职位</dt><dd>{receipt.jobTitle}</dd></div><div><dt>投递回执</dt><dd className="mono">{receipt.reference}</dd></div><div><dt>提交时间</dt><dd>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(receipt.submittedAt))}</dd></div></dl>
      <p className="career-receipt-note">请保存回执。如有进一步安排，招聘人员会通过你留下的联系方式与你沟通。本页暂不提供在线进度查询。</p>
      <div className="career-receipt-actions"><button className="button" onClick={async () => { try { await navigator.clipboard.writeText(`投递回执：${receipt.reference}\n应聘职位：${receipt.jobTitle}\n提交时间：${receipt.submittedAt}`); setCopied(true); } catch { setError("复制失败，请手动保存上方回执编号。"); } }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制回执" : "复制投递回执"}</button><a href="/careers" className="button primary">浏览其他职位 <ArrowRight size={16} /></a></div>
      <ErrorMessage message={error} />
    </section>
  );
  return (
    <section id="career-application" className="career-application">
      <div className="career-form-heading"><span className="career-note-icon"><FileText size={21} /></span><div><h2>投递这个职位</h2><p>上传简历，核对信息，即可提交。</p></div></div>
      <form onSubmit={submit} aria-busy={saving}>
        <fieldset disabled={saving} className="career-fieldset">
          <div className="career-form-step"><span>01</span><h3>上传简历</h3><small>或直接粘贴正文</small></div>
          <button type="button" className={`career-upload ${dragging ? "dragging" : ""}`} disabled={parsing} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void readFile(file); }} aria-describedby="career-file-help">
            {parsing ? <Spinner /> : fileName ? <CheckCircle2 size={25} /> : <Upload size={25} />}
            <strong>{parsing ? "正在读取简历…" : fileName || "点击选择或拖入简历"}</strong>
            <span>{fileName ? "重新上传只补充未编辑的空缺资料" : "PDF 文字版 / DOCX / TXT · 不超过 3 MiB"}</span>
          </button>
          <input ref={fileInput} type="file" accept=".pdf,.docx,.txt" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ""; }} />
          <p id="career-file-help" className="career-helper">上传后提取文字并辅助填写资料，原文件不保存。扫描版 PDF 请改为粘贴正文。</p>
          {parseNote && <p className="career-parse-note" role="status"><CheckCircle2 size={15} />{parseNote}</p>}
          <ErrorMessage message={parseError} />
          <div className="career-form-step"><span>02</span><h3>确认应聘资料</h3><small>* 为必填项</small></div>
          <div className="career-fields">
            <Field label="姓名" required><input name="name" autoComplete="name" required maxLength={80} value={fields.name} onChange={(event) => change("name", event.target.value)} placeholder="你的姓名" /></Field>
            <Field label="邮箱" required><input name="email" autoComplete="email" type="email" required maxLength={254} value={fields.email} onChange={(event) => change("email", event.target.value)} placeholder="name@example.com" /></Field>
            <Field label="手机"><input name="phone" autoComplete="tel" type="tel" maxLength={32} value={fields.phone} onChange={(event) => change("phone", event.target.value)} placeholder="选填" /></Field>
            <Field label="可到岗时间"><input name="availability" maxLength={240} value={fields.availability} onChange={(event) => change("availability", event.target.value)} placeholder="如：收到 Offer 后两周" /></Field>
          </div>
          <details className="career-extra" open={job.type === "campus" ? true : undefined}>
            <summary>教育背景与技能 <span>选填，可补充或更正</span></summary>
            <div className="career-fields">
              <Field label="毕业院校"><input name="school" maxLength={120} value={fields.school} onChange={(event) => change("school", event.target.value)} /></Field>
              <Field label="专业"><input name="major" maxLength={120} value={fields.major} onChange={(event) => change("major", event.target.value)} /></Field>
              <Field label="最高学历"><select name="education" value={fields.education} onChange={(event) => change("education", event.target.value)}><option value="unknown">暂不填写</option><option value="college">大专</option><option value="bachelor">本科</option><option value="master">硕士</option><option value="doctor">博士</option></select></Field>
              <Field label="毕业年份"><input name="graduationYear" inputMode="numeric" type="number" min={1960} max={2100} step={1} value={fields.graduationYear} onChange={(event) => change("graduationYear", event.target.value)} placeholder="如：2027" /></Field>
              <Field label="技能" span help="用逗号分隔，最多 30 项，每项不超过 60 字。"><input name="skills" value={fields.skills} onChange={(event) => change("skills", event.target.value)} placeholder="如：React，TypeScript" /></Field>
            </div>
          </details>
          <Field label="简历正文" required help="请核对提取内容；也可以直接粘贴简历正文。不超过 100,000 字。"><textarea name="resume" required rows={7} maxLength={100000} value={fields.resume} onChange={(event) => change("resume", event.target.value)} placeholder="个人经历、项目经验与相关能力…" /></Field>
          <div className="career-form-step"><span>03</span><h3>确认并提交</h3></div>
          <label className="career-consent"><input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我已核对以上资料，同意将本次填写的资料与简历正文提交给招聘团队，用于该职位的应聘沟通。我知晓当前为演示环境，仅使用合成资料。</span></label>
          <ErrorMessage message={error} />
          <button type="submit" className="button primary career-submit" disabled={parsing || saving}>{saving ? <><Spinner />正在提交…</> : <>{parsing ? "简历读取中…" : "确认投递"}<ArrowRight size={17} /></>}</button>
          <p className="career-submit-note">提交后进入该职位的待处理列表，不代表通过筛选。</p>
        </fieldset>
      </form>
    </section>
  );
}
