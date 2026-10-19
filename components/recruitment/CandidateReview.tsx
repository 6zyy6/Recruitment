"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  FileCheck2,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import type { CandidateReviewFields } from "@/lib/domain";
import { Field, Spinner } from "./ui";

type ReviewData = {
  review: { id: string; status: string; version: number; expiresAt: string };
  job: { title: string; type: string };
  fields: CandidateReviewFields;
  demoNotice: string;
};
type Fields = Record<keyof CandidateReviewFields, string>;
const educationNames: Record<string, string> = {
  unknown: "待核实",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
};

export default function CandidateReview() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const token =
      new URLSearchParams(window.location.search).get("token") || "";
    (async () => {
      try {
        const response = await fetch(
          `/api/candidate-review?token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const result = (await response.json()) as ReviewData & {
          message?: string;
        };
        if (!response.ok)
          throw new Error(
            result.message || "核对链接暂时不可用，请联系招聘人员。",
          );
        setData(result);
        const raw = result.fields;
        const education = educationNames[raw.education]
          ? raw.education
          : {
              本科: "bachelor",
              硕士: "master",
              博士: "doctor",
              大专: "college",
            }[raw.education] || "unknown";
        setFields({
          ...raw,
          education,
          graduationYear: raw.graduationYear ? String(raw.graduationYear) : "",
          skills: raw.skills.join("，"),
        });
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "加载失败，请稍后重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !fields) return;
    if (!fields.email.trim() && !fields.phone.trim()) {
      setError("邮箱和手机至少保留一种联系方式。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const token =
        new URLSearchParams(window.location.search).get("token") || "";
      const response = await fetch("/api/candidate-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          expectedVersion: data.review.version,
          confirmed,
          fields: {
            ...fields,
            graduationYear: fields.graduationYear
              ? Number(fields.graduationYear)
              : null,
            skills: [
              ...new Set(
                fields.skills
                  .split(/[,，;；\n]/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              ),
            ],
          },
        }),
      });
      const result = (await response.json()) as { message?: string };
      if (!response.ok)
        throw new Error(result.message || "提交未完成，请重试。");
      setSubmitted(true);
      window.history.replaceState(null, "", window.location.pathname);
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  const update = (name: keyof Fields, value: string) =>
    setFields((current) => (current ? { ...current, [name]: value } : current));
  return (
    <main className="candidate-review-page">
      <header className="review-page-brand">
        <span className="brand-icon">T</span>
        <span>
          <strong>拾才</strong>
          <small>候选人资料确认</small>
        </span>
        <ShieldCheck size={20} />
      </header>
      <section className="review-page-card">
        {loading ? (
          <div className="review-page-state">
            <Spinner />
            <p>正在加载你的核对资料…</p>
          </div>
        ) : submitted ? (
          <div className="review-page-state">
            <CheckCircle2 size={52} />
            <h1>资料已确认，感谢配合</h1>
            <p>
              你的更正已提交给招聘团队。招聘人员将继续核实资料并跟进流程，资料确认不会自动改变招聘结果。
            </p>
            <small>
              本次提交已锁定。如需继续修改，请联系招聘人员重新邀请。
            </small>
          </div>
        ) : !data || !fields ? (
          <div className="review-page-state">
            <AlertCircle size={44} />
            <h1>暂时无法打开核对资料</h1>
            <p role="alert">{error}</p>
            <small>请联系邀请你的招聘人员，获取新的核对链接。</small>
          </div>
        ) : (
          <>
            <div className="review-page-intro">
              <span className="review-page-icon">
                <FileCheck2 size={25} />
              </span>
              <div>
                <span className="eyebrow">请核对自动识别的资料</span>
                <h1>让招聘团队更准确地了解你</h1>
                <p>
                  应聘职位：<strong>{data.job.title}</strong> ·{" "}
                  {data.job.type === "campus" ? "校园招聘" : "社会招聘"}
                </p>
              </div>
            </div>
            <div className="review-demo-note">{data.demoNotice}</div>
            <p className="review-page-help">
              以下内容来自简历识别或招聘人员录入。你可以修改错误、补充缺失信息；不确定的学历和毕业年份可以保留待核实。
            </p>
            <form onSubmit={submit}>
              <fieldset disabled={busy} className="review-page-fields">
                <Field label="姓名" required>
                  <input
                    value={fields.name}
                    maxLength={80}
                    required
                    onChange={(e) => update("name", e.target.value)}
                  />
                </Field>
                <Field label="联系邮箱">
                  <input
                    value={fields.email}
                    type="email"
                    maxLength={254}
                    onChange={(e) => update("email", e.target.value)}
                  />
                </Field>
                <Field label="手机号码">
                  <input
                    value={fields.phone}
                    maxLength={32}
                    onChange={(e) => update("phone", e.target.value)}
                  />
                </Field>
                <Field label="毕业院校">
                  <input
                    value={fields.school}
                    maxLength={120}
                    onChange={(e) => update("school", e.target.value)}
                  />
                </Field>
                <Field label="专业">
                  <input
                    value={fields.major}
                    maxLength={120}
                    onChange={(e) => update("major", e.target.value)}
                  />
                </Field>
                <Field label="最高学历">
                  <select
                    value={fields.education}
                    onChange={(e) => update("education", e.target.value)}
                  >
                    {Object.entries(educationNames).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="毕业年份" help="不确定可留空">
                  <input
                    value={fields.graduationYear}
                    type="number"
                    min={1960}
                    max={2100}
                    onChange={(e) => update("graduationYear", e.target.value)}
                  />
                </Field>
                <Field label="可到岗时间">
                  <input
                    value={fields.availability}
                    maxLength={240}
                    onChange={(e) => update("availability", e.target.value)}
                  />
                </Field>
                <Field label="专业技能" span help="多项请用逗号分隔">
                  <textarea
                    rows={2}
                    value={fields.skills}
                    maxLength={1800}
                    onChange={(e) => update("skills", e.target.value)}
                  />
                </Field>
              </fieldset>
              <label className="review-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  required
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={busy}
                />
                <span>我已核对，并确认以上资料准确。</span>
              </label>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="review-page-submit">
                <span>
                  有效期至{" "}
                  {new Intl.DateTimeFormat("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(data.review.expiresAt))}
                </span>
                <button
                  className="button primary"
                  disabled={busy || !confirmed}
                >
                  {busy ? <Spinner /> : <CheckCircle2 size={16} />}
                  确认并提交资料
                </button>
              </div>
            </form>
          </>
        )}
      </section>
      <footer className="review-page-footer">
        拾才 TalentFlow · 资料核对仅用于本次招聘 · 请勿转发核对链接
      </footer>
    </main>
  );
}
