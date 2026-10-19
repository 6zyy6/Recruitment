"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Mail,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { Badge, Spinner } from "./ui";

type Connection = {
  configured: boolean;
  connected: boolean;
  senderEmail?: string;
  canManage: boolean;
  message: string;
};
type ApiMessage = {
  message?: string;
  signInUrl?: string;
  connectUrl?: string;
  authorizationUrl?: string;
};
export default function MailConnect() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void readStatus(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);
  async function readStatus(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/gmail", { cache: "no-store", signal });
      const result = (await response.json()) as Connection & ApiMessage;
      if (!mounted.current || signal?.aborted) return null;
      if (result.signInUrl) setSignInUrl(result.signInUrl);
      if (!response.ok) {
        setConnection(null);
        throw new Error(result.message || "暂时无法读取 Gmail 连接状态。");
      }
      setConnection(result);
      setSignInUrl(
        result.signInUrl ||
          (!result.canManage
            ? "/signin-with-chatgpt?return_to=%2Fmail-connect"
            : ""),
      );
      return result;
    } catch (cause) {
      if (mounted.current && !signal?.aborted)
        setError(
          cause instanceof Error ? cause.message : "连接状态读取失败，请重试。",
        );
      return null;
    } finally {
      if (mounted.current && !signal?.aborted) setLoading(false);
    }
  }
  async function request(action: "connect" | "disconnect") {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/gmail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = (await response.json()) as ApiMessage;
      if (!mounted.current) return;
      if (result.signInUrl) setSignInUrl(result.signInUrl);
      if (!response.ok)
        throw new Error(result.message || "连接操作未完成，请重试。");
      if (action === "connect") {
        const url = new URL(result.authorizationUrl || "");
        if (url.protocol !== "https:" || url.hostname !== "accounts.google.com")
          throw new Error("授权地址无法确认，请刷新后重试。");
        setAuthorizationUrl(url.href);
        try {
          if (window.top && window.top !== window)
            window.top.location.href = url.href;
          else window.location.assign(url.href);
        } catch {
          setNotice("请点击下方“继续 Google 官方授权”，在完整页面中完成连接。");
        }
      } else {
        const current = await readStatus();
        if (mounted.current && current)
          setNotice(
            current.connected
              ? "连接状态已刷新，请核对当前账号。"
              : "Gmail 连接已断开，系统将停止通过该邮箱发送新邮件。",
          );
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "连接操作失败，请稍后重试。",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <main className="mail-connect-page">
      <header className="mail-connect-header">
        <Link href="/" className="mail-connect-brand">
          <span>T</span>
          <strong>
            拾才 <small>TalentFlow</small>
          </strong>
        </Link>
        <Link className="text-button" href="/">
          <ArrowLeft size={15} />
          返回招聘工作台
        </Link>
      </header>
      <section className="mail-connect-card">
        <div className="mail-connect-icon">
          <Mail size={28} />
        </div>
        <h1>连接招聘发件邮箱</h1>
        <p className="mail-connect-lead">
          通过 Google 官方授权连接 Gmail，使用已连接邮箱发送候选人资料核对邮件。
        </p>
        {loading ? (
          <div className="mail-connect-loading" role="status">
            <Spinner />
            正在读取连接状态
          </div>
        ) : connection ? (
          <div
            className={
              "mail-connect-status " + (connection.connected ? "connected" : "")
            }
          >
            <div>
              {connection.connected ? (
                <CheckCircle2 size={20} />
              ) : (
                <Mail size={20} />
              )}
              <strong>
                {connection.connected
                  ? "Gmail 已连接"
                  : connection.configured
                    ? "Gmail 尚未连接"
                    : "授权配置待完成"}
              </strong>
              <Badge tone={connection.connected ? "green" : "neutral"}>
                {connection.connected ? "连接有效" : "未连接"}
              </Badge>
            </div>
            {connection.connected && connection.senderEmail && (
              <p className="mail-connect-sender">
                发件邮箱：<strong>{connection.senderEmail}</strong>
              </p>
            )}
            <p>{connection.message}</p>
          </div>
        ) : null}
        {connection && !connection.configured && (
          <div className="mail-connect-note">
            <InfoIcon />
            <p>
              请由站点所有者在安全的部署配置中完成 Google OAuth
              设置。此页面不收集 Client Secret、访问令牌或邮箱密码。
            </p>
          </div>
        )}
        {connection && !connection.canManage && (
          <div className="mail-connect-note">
            <ShieldCheck size={17} />
            <p>
              仅站点所有者可以管理发件邮箱。请使用站点绑定的真实身份登录后操作。
            </p>
          </div>
        )}
        {error && (
          <div className="mail-connect-error" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="mail-connect-note" role="status">
            <CheckCircle2 size={17} />
            <p>{notice}</p>
          </div>
        )}
        <div className="mail-connect-actions">
          {signInUrl ? (
            <a className="button primary" href={signInUrl} target="_top">
              以站点所有者身份登录
              <ExternalLink size={15} />
            </a>
          ) : connection?.canManage && connection.configured ? (
            connection.connected ? (
              <button
                className="button"
                disabled={busy}
                onClick={() => request("disconnect")}
              >
                {busy ? <Spinner /> : <Unplug size={15} />}断开 Gmail 连接
              </button>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => request("connect")}
              >
                {busy ? <Spinner /> : <Mail size={16} />}通过 Google
                官方授权连接
                <ExternalLink size={14} />
              </button>
            )
          ) : null}
          <button
            className="button"
            disabled={busy || loading}
            onClick={() => void readStatus()}
          >
            <RefreshCw size={15} />
            刷新连接状态
          </button>
        </div>
        {authorizationUrl && (
          <a
            className="mail-connect-auth-link"
            href={authorizationUrl}
            target="_top"
            rel="noreferrer"
          >
            继续 Google 官方授权
            <ExternalLink size={14} />
          </a>
        )}
        <div className="mail-connect-explainer">
          <h2>
            <ShieldCheck size={16} />
            发送前后都保持清晰
          </h2>
          <ul>
            <li>
              连接邮箱不会发送邮件，只有明确点击发送核对邀请时才会请求 Gmail
              发送。
            </li>
            <li>
              “Gmail 已接受发送”表示 Gmail 接受了请求，不代表邮件已送达候选人。
            </li>
            <li>发送结果待核实时，请先在 Gmail 发件箱核实，避免重复发送。</li>
            <li>候选人核对链接仅对应本次投递，7 天有效，请勿转发。</li>
          </ul>
        </div>
      </section>
      <footer className="mail-connect-footer">
        拾才 TalentFlow · 招聘邮件连接
      </footer>
    </main>
  );
}
function InfoIcon() {
  return <AlertCircle size={17} />;
}
