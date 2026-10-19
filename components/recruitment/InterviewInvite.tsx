"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, RefreshCw } from "lucide-react";
import type { Application, Interview, Snapshot } from "@/lib/domain";
import { Badge, Modal, Spinner, dateTime } from "./ui";

type MailPreview = { to: string; subject: string; text: string };
type InvitationResult = {
  snapshot?: Snapshot;
  mailPreview?: MailPreview;
  mailReady?: boolean;
  mailDelivery?: {
    status: "sent" | "failed" | "unknown" | "sending";
    reason: string;
  };
  message?: string;
  signInUrl?: string;
  connectUrl?: string;
};

export default function InterviewInvite({
  interview,
  application,
  recipientEmail,
  revision,
  canSend,
  onSnapshot,
  onRefresh,
}: {
  interview: Interview;
  application: Application;
  recipientEmail: string;
  revision: number;
  canSend: boolean;
  onSnapshot: (snapshot: Snapshot) => void;
  onRefresh: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<MailPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connect, setConnect] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const summary = interview.invitation;
  const expired = !!summary && Date.parse(summary.expiresAt) <= now;
  const recipientChanged =
    !!summary &&
    summary.to.toLowerCase() !== recipientEmail.trim().toLowerCase();
  const inactive =
    !!summary && (!!summary.revokedAt || expired || recipientChanged);
  const blocked =
    uncertain ||
    (!!summary &&
      !inactive &&
      ["sent", "pending", "unknown"].includes(summary.delivery));
  const deliveryLabel = recipientChanged
    ? "联系邮箱已更新，请重新发送"
    : inactive
      ? "邀请已失效 · 需重新发送"
      : uncertain
        ? "发送结果待核实"
        : summary
          ? {
              pending: "发送处理中",
              sent: "面试邮件已发送",
              failed: "面试邮件发送失败",
              unknown: "发送结果待核实",
            }[summary.delivery]
          : interview.notified
            ? "已人工通知 · 未发送面试邮件"
            : "尚未发送面试邮件";
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  async function verify() {
    if (await onRefresh()) setUncertain(false);
  }

  async function request(action: string, fields: Record<string, unknown> = {}) {
    const response = await fetch("/api/interview-invitation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, interviewId: interview.id, ...fields }),
    });
    const data = (await response.json()) as InvitationResult;
    if (!response.ok) {
      setConnect(
        response.status === 401 ||
          (response.status === 503 && !!data.connectUrl),
      );
      throw Object.assign(
        new Error(data.message || "面试邀请操作未完成，请刷新后重试。"),
        { responseReceived: true },
      );
    }
    return data;
  }
  async function showPreview() {
    if (lock.current || blocked) return;
    lock.current = true;
    setOpen(true);
    setRevoking(false);
    setPreview(null);
    setBusy(true);
    setError("");
    setNotice("");
    setConnect(false);
    try {
      const data = await request("previewInterviewInvitation", {
        expectedRevision: revision,
      });
      if (!data.mailPreview)
        throw new Error("暂时无法生成邮件预览，请刷新后重试。");
      setPreview(data.mailPreview);
      setPreviewRevision(revision);
      setConnect(data.mailReady === false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "邮件预览加载失败，请重试。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (lock.current || blocked || !preview || previewRevision !== revision)
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setConnect(false);
    try {
      const data = await request("sendInterviewInvitation", {
        expectedRevision: previewRevision,
        requestId: `invite_${crypto.randomUUID()}`,
      });
      if (data.snapshot) onSnapshot(data.snapshot);
      setPreview(null);
      if (data.mailDelivery?.status === "sent") {
        setNotice(
          "面试邮件已发送，等待候选人答复。发送成功不代表邮件已送达或候选人已确认。",
        );
      } else if (data.mailDelivery?.status === "failed") {
        setError(
          data.mailDelivery.reason || "发送失败，可关闭后重新预览并重试。",
        );
      } else {
        setUncertain(true);
        setError(
          data.mailDelivery?.reason ||
            "发送结果暂未确认，请刷新核实后再操作，避免重复发送。",
        );
      }
    } catch (e) {
      // A lost response may occur after the provider accepted the email.
      if (!(e as { responseReceived?: boolean })?.responseReceived)
        setUncertain(true);
      setError(
        e instanceof Error
          ? e.message
          : "连接中断，发送结果待核实，请刷新后查看。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function revoke() {
    if (lock.current || !revokeConfirmed) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await request("revokeInterviewInvitation", {
        expectedRevision: revision,
      });
      if (data.snapshot) onSnapshot(data.snapshot);
      setUncertain(false);
      setRevoking(false);
      setNotice(
        "邀请已撤销，旧答复链接已失效。需要继续邀请时，请重新预览并发送。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销未完成，请刷新后核实。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const needsRefresh =
    uncertain ||
    (!inactive &&
      (summary?.delivery === "unknown" || summary?.delivery === "pending"));
  return (
    <div className="interview-invite">
      <div className="interview-invite-status">
        <Badge
          tone={!inactive && summary?.delivery === "sent" ? "blue" : "neutral"}
        >
          {deliveryLabel}
        </Badge>
        {summary && !inactive && (
          <Badge
            tone={
              summary.response === "confirmed"
                ? "green"
                : summary.response === "reschedule_requested"
                  ? "amber"
                  : "neutral"
            }
          >
            {
              {
                pending: "候选人待答复",
                confirmed: "候选人已确认参加",
                reschedule_requested: "候选人申请改期",
              }[summary.response]
            }
          </Badge>
        )}
      </div>
      {summary?.sentAt && !inactive && (
        <p>
          发送时间：{dateTime(summary.sentAt)} · {summary.to}
        </p>
      )}
      {summary?.responseNote && !inactive && (
        <p className="interview-response-note">
          候选人留言：{summary.responseNote}
        </p>
      )}
      {summary?.respondedAt && !inactive && (
        <p>答复时间：{dateTime(summary.respondedAt)}</p>
      )}
      {summary?.deliveryReason && !inactive && summary.delivery !== "sent" && (
        <p>{summary.deliveryReason}</p>
      )}
      {canSend && (
        <div className="interview-invite-actions">
          <button
            className="text-button"
            disabled={busy || blocked || !recipientEmail}
            onClick={showPreview}
          >
            <Mail size={13} />
            {summary?.delivery === "failed" && !inactive
              ? "重试发送面试邀请"
              : "发送面试邀请"}
          </button>
          {needsRefresh && (
            <button className="text-button" disabled={busy} onClick={verify}>
              <RefreshCw size={13} />
              刷新核实发送状态
            </button>
          )}
          {summary &&
            !inactive &&
            ["sent", "pending", "unknown"].includes(summary.delivery) && (
              <button
                className="text-button muted"
                disabled={busy}
                onClick={() => {
                  setOpen(true);
                  setRevoking(true);
                  setRevokeConfirmed(false);
                  setPreview(null);
                  setError("");
                  setNotice("");
                  setConnect(false);
                }}
              >
                撤销邀请
              </button>
            )}
          {!recipientEmail && <p>请先补充候选人邮箱。</p>}
        </div>
      )}
      {needsRefresh && <p>发送结果核实前，请勿重复发送。</p>}
      {open && (
        <Modal
          title={revoking ? "撤销面试邀请" : "发送面试邀请"}
          subtitle={`${application.snapshot.name} · ${interview.round} · ${dateTime(interview.start)}（北京时间）`}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="modal-body interview-invite-modal">
            {revoking && (
              <>
                <p>
                  撤销会使旧答复链接失效，不会召回已发送的邮件。撤销后可重新发送新的邀请。
                </p>
                {needsRefresh && (
                  <p>
                    当前发送结果待核实，请先在 Gmail
                    已发送邮件中确认，避免候选人收到重复邀请。
                  </p>
                )}
                <label className="review-confirm">
                  <input
                    type="checkbox"
                    checked={revokeConfirmed}
                    disabled={busy}
                    onChange={(event) =>
                      setRevokeConfirmed(event.target.checked)
                    }
                  />
                  <span>我已核对发送情况，确认撤销旧邀请。</span>
                </label>
              </>
            )}
            {busy && !preview && (
              <p>
                <Spinner />
                正在处理面试邀请…
              </p>
            )}
            {preview && (
              <div className="interview-mail-preview">
                <small>收件人：{preview.to}</small>
                <h3>{preview.subject}</h3>
                <pre>
                  {preview.text.replace(
                    /\{\{RESPONSE_URL\}\}(?:（发送时生成专属答复链接）)?/g,
                    "（发送时生成专属答复链接）",
                  )}
                </pre>
                <p>
                  确认后通过已连接的招聘邮箱发送，候选人可在邮件中确认参加或申请改期。
                </p>
              </div>
            )}
            {preview && previewRevision !== revision && (
              <p className="form-error">面试资料已更新，请关闭后重新预览。</p>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {connect && (
              <p>
                请先连接用于发送邀请的招聘邮箱。
                <a className="button small" href="/mail-connect">
                  连接招聘邮箱后继续
                </a>
              </p>
            )}
            {needsRefresh && (
              <button className="text-button" disabled={busy} onClick={verify}>
                <RefreshCw size={13} />
                刷新核实发送状态
              </button>
            )}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {notice ? "完成" : "关闭"}
            </button>
            {preview && (
              <button
                type="button"
                className="button primary"
                disabled={
                  busy || blocked || connect || previewRevision !== revision
                }
                onClick={send}
              >
                {busy ? <Spinner /> : <Mail size={15} />}发送面试邀请
              </button>
            )}
            {revoking && (
              <button
                type="button"
                className="button danger"
                disabled={busy || !revokeConfirmed}
                onClick={revoke}
              >
                {busy && <Spinner />}确认撤销邀请
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
