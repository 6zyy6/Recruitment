"use client";

import { useState } from "react";
import { Mail, Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import type { Application, Snapshot } from "@/lib/domain";
import { Badge, Spinner, dateTime } from "./ui";

type Invitation = {
  reviewUrl: string;
  mailPreview: { to: string; subject: string; text: string; reason: string };
  snapshot: Snapshot;
};
export default function CandidateReviewInvite({
  application,
  revision,
  onSnapshot,
  onRefresh,
}: {
  application: Application;
  revision: number;
  onSnapshot: (snapshot: Snapshot) => void;
  onRefresh: () => void;
}) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const summary = application.snapshot.review;
  const expired =
    summary?.status === "pending" &&
    Date.parse(summary.expiresAt) <= Date.now();
  const status = expired
    ? "已过期"
    : summary
      ? {
          pending: "待候选人核对",
          submitted: "候选人已确认",
          revoked: "已撤销",
          expired: "已过期",
        }[summary.status]
      : "尚未邀请";
  const editable =
    application.status === "active" &&
    ["new", "screening", "interview"].includes(application.stage);
  async function request(action: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/candidate-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          applicationId: application.id,
          expectedRevision: revision,
        }),
      });
      const data = (await response.json()) as Invitation & { message?: string };
      if (!response.ok)
        throw new Error(data.message || "邀请操作未完成，请重试。");
      onSnapshot(data.snapshot);
      setInvitation(action === "createCandidateReview" ? data : null);
      setNotice(
        action === "createCandidateReview"
          ? "核对邀请已生成，邮件尚未发送。"
          : "邀请已撤销，旧链接已失效。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  const gmailUrl = invitation
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(invitation.mailPreview.to)}&su=${encodeURIComponent(invitation.mailPreview.subject)}&body=${encodeURIComponent(invitation.mailPreview.text)}`
    : "";
  return (
    <section className="review-invite-card">
      <h3>
        <Mail size={16} />
        候选人资料核对
        <Badge tone={summary?.status === "submitted" ? "green" : "blue"}>
          {status}
        </Badge>
      </h3>
      <p>
        {summary?.status === "submitted"
          ? `候选人于 ${dateTime(summary.submittedAt)} 确认资料。如有更正，本次投递的旧筛选结果和录用意见需重新复核。`
          : "邀请候选人自行核对简历识别结果。确认仅更新本次投递和人才主档，不改变招聘阶段。"}
      </p>
      {summary?.status === "pending" && (
        <p>
          链接有效期至 {dateTime(summary.expiresAt)} · 邮件预览，不代表已发送。
        </p>
      )}
      {editable && (
        <div className="review-invite-actions">
          <button
            className="button small"
            disabled={busy || !application.snapshot.email}
            onClick={() => request("createCandidateReview")}
          >
            {busy ? <Spinner /> : <Mail size={14} />}
            {summary ? "重新生成邀请（旧链接失效）" : "邀请候选人核对"}
          </button>
          {summary?.status === "pending" && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => request("revokeCandidateReview")}
            >
              <X size={13} />
              撤销邀请
            </button>
          )}
        </div>
      )}
      {!application.snapshot.email && editable && (
        <p>当前投递未提供邮箱，暂不能生成核对邮件。</p>
      )}
      {invitation && (
        <div className="review-invite-preview">
          <small>收件人：{invitation.mailPreview.to} · 尚未发送</small>
          <p>
            <strong>{invitation.mailPreview.subject}</strong>
          </p>
          <pre>{invitation.mailPreview.text}</pre>
          <div className="review-invite-actions">
            <a
              className="button small primary"
              target="_blank"
              rel="noreferrer noopener"
              href={gmailUrl}
            >
              <Mail size={14} />在 Gmail 打开核对邮件
            </a>
            <a
              className="button small"
              target="_blank"
              rel="noreferrer noopener"
              href={invitation.reviewUrl}
            >
              <ExternalLink size={14} />
              预览候选人核对页
            </a>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(invitation.reviewUrl);
                  setNotice("核对链接已复制，请勿转发给其他人。");
                } catch {
                  setError("复制失败，可从邮件预览中复制链接。");
                }
              }}
            >
              <Copy size={13} />
              复制链接
            </button>
          </div>
          <p>
            最后在 Gmail 确认发送，打开草稿不计为已发送。当前私有 Demo
            的核对页仅供站点所有者体验。
          </p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button className="text-button" onClick={onRefresh}>
            <RefreshCw size={13} />
            刷新资料
          </button>
        </div>
      )}
    </section>
  );
}
