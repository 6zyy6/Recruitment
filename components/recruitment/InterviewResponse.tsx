"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Calendar, CheckCircle2, ShieldCheck } from "lucide-react";
import { Field, Spinner } from "./ui";

type InterviewView = {
  invitation: {
    id: string;
    version: number;
    response: "pending" | "confirmed" | "reschedule_requested";
    respondedAt: string;
    responseNote: string;
    expiresAt: string;
  };
  interview: {
    round: string;
    start: string;
    end: string;
    location: string;
    meetingUrl?: string;
    meetingId?: string;
    meetingPassword?: string;
  };
  candidateName: string;
  jobTitle: string;
};
const fullDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "full",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(value));

export default function InterviewResponse() {
  const [view, setView] = useState<InterviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<
    "confirmed" | "reschedule_requested"
  >("confirmed");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const token = useRef("");
  const lock = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(window.location.search);
    const hash = window.location.hash.slice(1);
    token.current =
      new URLSearchParams(hash).get("token") ||
      (hash && !hash.includes("=") ? hash : "") ||
      query.get("token") ||
      "";
    if (query.has("token")) {
      query.delete("token");
      const search = query.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}#token=${encodeURIComponent(token.current)}`,
      );
    }
    (async () => {
      try {
        if (!token.current)
          throw new Error(
            "邀请链接不完整，请联系招聘人员获取邮件中的专属链接。",
          );
        const result = await fetch(
          `/api/interview-response?token=${encodeURIComponent(token.current)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const data = (await result.json()) as InterviewView & {
          message?: string;
        };
        if (!result.ok)
          throw new Error(
            data.message || "邀请已失效或暂不可用，请联系招聘人员。",
          );
        if (!controller.signal.aborted) setView(data);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "加载失败，请稍后刷新重试。",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || lock.current || view.invitation.response !== "pending") return;
    if (response === "reschedule_requested" && note.trim().length < 5) {
      setError("请填写至少 5 个字的改期原因或建议时间。");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fetch("/api/interview-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: token.current,
          expectedVersion: view.invitation.version,
          response,
          note: note.trim(),
        }),
      });
      const data = (await result.json()) as {
        message?: string;
        view?: InterviewView;
      };
      if (!result.ok)
        throw new Error(data.message || "答复未提交，请刷新邀请后重试。");
      if (!data.view) throw new Error("暂未获得答复结果，请刷新页面核实。");
      setView(data.view);
      setNotice(data.message || "答复已提交给招聘团队。");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "连接中断，请刷新页面核实答复是否已提交。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const answered = !!view && view.invitation.response !== "pending";
  const expired = !!view && Date.parse(view.invitation.expiresAt) <= now;
  const meetingUrl = view?.interview.meetingUrl;
  const safeMeetingUrl =
    meetingUrl && /^https?:\/\//i.test(meetingUrl) ? meetingUrl : "";
  return (
    <main className="candidate-review-page interview-response-page">
      <header className="review-page-brand">
        <span className="brand-icon">T</span>
        <span>
          <strong>拾才</strong>
          <small>面试邀请答复</small>
        </span>
        <ShieldCheck size={20} />
      </header>
      <section className="review-page-card">
        {loading ? (
          <div className="review-page-state">
            <Spinner />
            <p>正在加载你的面试邀请…</p>
          </div>
        ) : !view ? (
          <div className="review-page-state">
            <AlertCircle size={44} />
            <h1>暂时无法打开面试邀请</h1>
            <p role="alert">{error}</p>
            <small>请联系邀请你的招聘人员，确认最新安排。</small>
          </div>
        ) : (
          <>
            <div className="review-page-intro">
              <span className="review-page-icon">
                <Calendar size={25} />
              </span>
              <div>
                <span className="eyebrow">{view.candidateName}，你好</span>
                <h1>期待与你交流</h1>
                <p>
                  应聘职位：<strong>{view.jobTitle}</strong>
                </p>
              </div>
            </div>
            <dl className="interview-response-details">
              <div>
                <dt>面试轮次</dt>
                <dd>{view.interview.round}</dd>
              </div>
              <div>
                <dt>面试时间</dt>
                <dd>
                  {fullDate(view.interview.start)} —{" "}
                  {fullDate(view.interview.end)}
                  <small>北京时间（UTC+8）</small>
                </dd>
              </div>
              <div>
                <dt>面试地点</dt>
                <dd>{view.interview.location}</dd>
              </div>
              {safeMeetingUrl && (
                <div>
                  <dt>线上会议</dt>
                  <dd>
                    <a
                      href={safeMeetingUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      打开会议链接
                    </a>
                  </dd>
                </div>
              )}
              {view.interview.meetingId && (
                <div>
                  <dt>会议号</dt>
                  <dd>{view.interview.meetingId}</dd>
                </div>
              )}
              {view.interview.meetingPassword && (
                <div>
                  <dt>会议密码</dt>
                  <dd>{view.interview.meetingPassword}</dd>
                </div>
              )}
            </dl>
            {answered ? (
              <div className="interview-response-result" role="status">
                <CheckCircle2 size={25} />
                <div>
                  <h2>
                    {view.invitation.response === "confirmed"
                      ? "你已确认参加面试"
                      : "你的改期申请已提交"}
                  </h2>
                  <p>
                    {view.invitation.response === "confirmed"
                      ? "招聘团队已收到你的答复，请按时参加。如需变更，请联系招聘人员。"
                      : "招聘团队将联系你确认新的时间。在收到新邀请前，原定时间尚未变更。"}
                  </p>
                  {view.invitation.responseNote && (
                    <p className="interview-response-note">
                      你的留言：{view.invitation.responseNote}
                    </p>
                  )}
                  {notice && <small>{notice}</small>}
                  <small>本次答复已锁定。</small>
                </div>
              </div>
            ) : expired ? (
              <div className="form-error" role="alert">
                邀请已过期，请联系招聘人员获取新的邀请。
              </div>
            ) : (
              <form onSubmit={submit}>
                <fieldset
                  className="interview-response-choices"
                  disabled={busy}
                >
                  <legend>请确认你的安排</legend>
                  <label className="interview-response-choice">
                    <input
                      type="radio"
                      name="response"
                      value="confirmed"
                      checked={response === "confirmed"}
                      onChange={() => setResponse("confirmed")}
                    />
                    <span>
                      <strong>确认参加</strong>
                      <small>我可以按上述时间参加面试。</small>
                    </span>
                  </label>
                  <label className="interview-response-choice">
                    <input
                      type="radio"
                      name="response"
                      value="reschedule_requested"
                      checked={response === "reschedule_requested"}
                      onChange={() => setResponse("reschedule_requested")}
                    />
                    <span>
                      <strong>申请改期</strong>
                      <small>请招聘团队联系我确认其他时间。</small>
                    </span>
                  </label>
                  <Field
                    label={
                      response === "reschedule_requested"
                        ? "改期原因 / 建议时间"
                        : "给招聘团队留言"
                    }
                    required={response === "reschedule_requested"}
                    help={
                      response === "reschedule_requested"
                        ? "请填写 5–1000 个字，说明原因或建议可参加的时间。"
                        : "选填，最多 1000 个字。"
                    }
                  >
                    <textarea
                      rows={4}
                      maxLength={1000}
                      minLength={
                        response === "reschedule_requested" ? 5 : undefined
                      }
                      required={response === "reschedule_requested"}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={
                        response === "reschedule_requested"
                          ? "例如：原时间有工作安排，周三或周四下午可以参加。"
                          : "如有需要提前说明的事项，可在此留言。"
                      }
                    />
                  </Field>
                </fieldset>
                {error && (
                  <div className="form-error" role="alert">
                    {error}
                  </div>
                )}
                <div className="review-page-submit">
                  <span>
                    答复有效期至 {fullDate(view.invitation.expiresAt)}
                  </span>
                  <button className="button primary" disabled={busy}>
                    {busy ? <Spinner /> : <CheckCircle2 size={16} />}
                    {response === "confirmed" ? "确认参加面试" : "提交改期申请"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </section>
      <footer className="review-page-footer">
        拾才 TalentFlow · 此链接仅用于本次面试答复，请勿转发
      </footer>
    </main>
  );
}
