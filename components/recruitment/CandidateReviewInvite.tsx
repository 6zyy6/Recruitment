"use client";

import { useRef, useState } from "react";
import { Mail, Copy, ExternalLink, RefreshCw, X, Settings } from "lucide-react";
import type {
  Application,
  CandidateReviewSummary,
  Snapshot,
} from "@/lib/domain";
import { Badge, Spinner, dateTime } from "./ui";

export type MailDelivery = {
  status: "sent" | "failed" | "unknown" | "sending" | "preview";
  reason: string;
  messageId?: string;
  sentAt?: string;
};
export function mailDeliveryLabel(delivery: MailDelivery) {
  return {
    sent: "Gmail 已接受发送",
    failed: "邮件发送失败",
    unknown: "发送结果待核实",
    sending: "邮件正在发送，请勿重复操作",
    preview: "仅生成预览，尚未发送",
  }[delivery.status];
}
export function DeliveryStatus({ delivery }: { delivery: MailDelivery }) {
  return (
    <div
      className={"mail-delivery-note " + delivery.status}
      role={
        delivery.status === "failed" || delivery.status === "unknown"
          ? "alert"
          : "status"
      }
    >
      <strong>{mailDeliveryLabel(delivery)}</strong>
      <p>{delivery.reason}</p>
      {delivery.status === "sent" ? (
        <p>
          Gmail 接受请求不代表邮件已送达候选人。
          {delivery.sentAt ? ` 发送记录时间：${dateTime(delivery.sentAt)}` : ""}
        </p>
      ) : delivery.status === "unknown" || delivery.status === "sending" ? (
        <p>
          请先核实已连接邮箱的 Gmail
          已发送记录，并刷新本页；不要直接再次发送。若确认需要重新邀请，先明确撤销旧链接，再手动发送新邀请。
        </p>
      ) : null}
    </div>
  );
}
type Invitation = {
  reviewUrl: string;
  mailPreview: { to: string; subject: string; text: string; reason: string };
  mailDelivery?: MailDelivery;
  snapshot: Snapshot;
};
type ApiResult = Partial<Invitation> & {
  message?: string;
  signInUrl?: string;
  connectUrl?: string;
};
type Summary = CandidateReviewSummary & {
  deliveryReason?: string;
  sentAt?: string;
  providerMessageId?: string;
};
function fromSummary(summary: Summary | undefined): MailDelivery | null {
  if (!summary) return null;
  const value = String(summary.delivery);
  const status = value === "pending" ? "sending" : value;
  if (!["sent", "failed", "unknown", "sending", "preview"].includes(status))
    return null;
  return {
    status: status as MailDelivery["status"],
    reason:
      summary.deliveryReason ||
      (status === "sent"
        ? "Gmail 已接受此核对邮件的发送请求。"
        : status === "preview"
          ? "该历史记录仅生成了邮件预览。"
          : "请核实 Gmail 连接和已发送记录。"),
    sentAt: summary.sentAt,
    messageId: summary.providerMessageId,
  };
}

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
  const [localDelivery, setLocalDelivery] = useState<MailDelivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configLink, setConfigLink] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const pending = useRef(false);
  const [attemptBaseId, setAttemptBaseId] = useState("");
  const summary = application.snapshot.review as Summary | undefined;
  const serverDelivery = fromSummary(summary);
  const reconciled =
    (localDelivery?.status === "unknown" ||
      localDelivery?.status === "sending") &&
    summary?.reviewId !== attemptBaseId &&
    serverDelivery &&
    (summary?.status === "revoked" ||
      !["unknown", "sending"].includes(serverDelivery.status));
  const delivery = reconciled
    ? serverDelivery
    : localDelivery || invitation?.mailDelivery || serverDelivery;
  const uncertain =
    ((!reconciled &&
      (localDelivery?.status === "unknown" ||
        localDelivery?.status === "sending")) ||
      (summary?.status === "pending" &&
        (serverDelivery?.status === "unknown" ||
          serverDelivery?.status === "sending"))) === true;
  const expired =
    summary?.status === "pending" &&
    Date.parse(summary.expiresAt) <= new Date().getTime();
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
  async function request(
    action: "createCandidateReview" | "revokeCandidateReview",
  ) {
    if (pending.current || (action === "createCandidateReview" && uncertain))
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setConfigLink("");
    setSignInUrl("");
    if (action === "createCandidateReview") {
      setAttemptBaseId(summary?.reviewId || "");
      setInvitation(null);
      setLocalDelivery({
        status: "sending",
        reason: "正在提交核对邮件发送请求，请等待服务端返回结果。",
      });
    }
    let responseStatus = 0;
    let deliverySet = false;
    try {
      const response = await fetch("/api/candidate-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          applicationId: application.id,
          expectedRevision: revision,
          ...(action === "createCandidateReview" ? { sendEmail: true } : {}),
        }),
      });
      responseStatus = response.status;
      const data = (await response.json()) as ApiResult;
      if (data.snapshot) onSnapshot(data.snapshot);
      if (data.signInUrl) setSignInUrl(data.signInUrl);
      if (data.connectUrl || response.status === 503)
        setConfigLink(data.connectUrl || "/mail-connect");
      if (data.mailDelivery) {
        setLocalDelivery(data.mailDelivery);
        deliverySet = true;
      }
      if (!response.ok) {
        if (action === "createCandidateReview" && !data.mailDelivery)
          setLocalDelivery({
            status: [400, 401, 403, 404, 422, 503].includes(response.status)
              ? "failed"
              : "unknown",
            reason: data.message || "请求未能完成，请核实 Gmail 已发送记录。",
          });
        throw new Error(data.message || "邀请操作未完成，请刷新资料后核实。");
      }
      if (action === "createCandidateReview") {
        if (data.reviewUrl && data.mailPreview && data.snapshot)
          setInvitation(data as Invitation);
        deliverySet = true;
        setLocalDelivery(
          data.mailDelivery || {
            status: "preview",
            reason: "服务端未返回发送确认，仅按预览记录显示。",
          },
        );
      } else {
        setInvitation(null);
        setLocalDelivery(null);
        setRevokeConfirmed(false);
        setNotice("邀请已撤销，旧核对链接已失效；撤销不召回已发出的邮件。");
      }
    } catch (cause) {
      if (action === "createCandidateReview" && !deliverySet)
        setLocalDelivery({
          status: [400, 401, 403, 404, 422, 503].includes(responseStatus)
            ? "failed"
            : "unknown",
          reason: !responseStatus
            ? "未能取得服务端发送结果，邮件可能已被 Gmail 接受。"
            : cause instanceof Error
              ? cause.message
              : "请核实 Gmail 已发送记录。",
        });
      setError(
        cause instanceof Error ? cause.message : "操作未完成，请核实后再处理。",
      );
    } finally {
      pending.current = false;
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
          : "发送核对邀请，让候选人自行确认简历识别结果。确认仅更新本次投递和人才主档，不改变招聘阶段。"}
      </p>
      {summary?.status === "pending" && (
        <p>
          链接有效期至 {dateTime(summary.expiresAt)} ·
          仅对应本次投递，请勿转发。
        </p>
      )}
      {delivery && <DeliveryStatus delivery={delivery} />}
      {uncertain && (
        <div className="mail-delivery-actions">
          <a
            className="button small"
            href="https://mail.google.com/mail/#sent"
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={14} />
            核实 Gmail 已发送
          </a>
          <button className="button small" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={14} />
            刷新发送状态
          </button>
        </div>
      )}
      {editable && (
        <div className="review-invite-actions">
          <button
            className="button small primary"
            disabled={busy || uncertain || !application.snapshot.email}
            onClick={() => request("createCandidateReview")}
          >
            {busy ? <Spinner /> : <Mail size={14} />}{" "}
            {summary ? "重新发送核对邀请（旧链接失效）" : "发送核对邀请"}
          </button>
          {summary?.status === "pending" && (
            <button
              className="text-button"
              disabled={busy || (uncertain && !revokeConfirmed)}
              onClick={() => request("revokeCandidateReview")}
            >
              <X size={13} />
              撤销邀请
            </button>
          )}
        </div>
      )}
      {uncertain && summary?.status === "pending" && editable && (
        <label className="mail-delivery-revoke">
          <input
            type="checkbox"
            checked={revokeConfirmed}
            onChange={(event) => setRevokeConfirmed(event.target.checked)}
          />
          我已在 Gmail 核实发送记录，确需撤销本次核对链接。
        </label>
      )}
      {!application.snapshot.email && editable && (
        <p>当前投递未提供邮箱，暂不能发送核对邮件。</p>
      )}
      {invitation && (
        <div className="review-invite-preview">
          <small>
            收件人：{invitation.mailPreview.to} ·{" "}
            {delivery ? mailDeliveryLabel(delivery) : "邮件内容"}
          </small>
          <p>
            <strong>{invitation.mailPreview.subject}</strong>
          </p>
          <pre>{invitation.mailPreview.text}</pre>
          <div className="review-invite-actions">
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
                  setError("复制失败，可从邮件内容中复制链接。");
                }
              }}
            >
              <Copy size={13} />
              复制链接
            </button>
            {delivery && ["failed", "preview"].includes(delivery.status) && (
              <a
                className="text-button"
                target="_blank"
                rel="noreferrer noopener"
                href={gmailUrl}
              >
                <Mail size={14} />
                备用：在 Gmail 打开草稿
              </a>
            )}
          </div>
          <p>
            核对链接仅对应本次投递，7 天有效，请勿转发。备用草稿只有在 Gmail
            确认后才会发送，系统不会据此记录发送成功。
          </p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button className="text-button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={13} />
            刷新资料
          </button>
        </div>
      )}
      {(configLink || signInUrl) && (
        <div className="mail-delivery-actions">
          {configLink && (
            <a
              className="button small"
              href={configLink}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Settings size={14} />
              配置发件 Gmail
            </a>
          )}
          {signInUrl && (
            <a className="button small primary" href={signInUrl} target="_top">
              以站点所有者身份登录
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}
