export interface GmailEnvironment {
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_TOKEN_KEY?: string;
  MAIL_OPERATOR_EMAIL?: string;
  MAIL_BASE_URL?: string;
}
export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  senderEmail: string;
  canManage: boolean;
  message: string;
}
export interface ReviewEmail {
  id: string;
  to: string;
  subject: string;
  text: string;
}
export interface MailDelivery {
  status: "sent" | "failed" | "unknown" | "sending";
  messageId?: string;
  sentAt?: string;
  reason: string;
}
export type MailResult = MailDelivery;
export class GmailError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const SCOPES = "https://www.googleapis.com/auth/gmail.send openid email";
const OAUTH_COOKIE = "talentflow_gmail_oauth";
const CALLBACK_PATH = "/api/gmail/callback";
const OAUTH_TTL = 10 * 60 * 1000;
const STALE_SEND_MS = 2 * 60 * 1000;
const EMAIL =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i;
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}
function validEmail(value: string): boolean {
  return value === value.trim() && EMAIL.test(value);
}
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
function fail(code: string, message: string, status = 400): never {
  throw new GmailError(code, message, status);
}
function bytesBase64(value: Uint8Array): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}
function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export function base64Url(value: Uint8Array): string {
  return bytesBase64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return base64Bytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}
function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
async function hash(value: string): Promise<string> {
  return base64Url(await digest(value));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return hash(verifier);
}

export function tokenKey(value: string): Uint8Array<ArrayBuffer> {
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value.trim())) throw new Error();
    const key = base64Bytes(value.trim());
    if (key.length !== 32) throw new Error();
    return key;
  } catch {
    return fail(
      "MAIL_CONFIG",
      "GMAIL_TOKEN_KEY 必须是 32 字节随机密钥的标准 Base64 编码",
      503,
    );
  }
}
export async function encryptToken(
  value: string,
  encodedKey: string,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    tokenKey(encodedKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}
export async function decryptToken(
  value: string,
  encodedKey: string,
  context: string,
): Promise<string> {
  try {
    const [version, iv, ciphertext, extra] = value.split(".");
    if (
      version !== "v1" ||
      !iv ||
      !ciphertext ||
      extra !== undefined ||
      fromBase64Url(iv).length !== 12
    )
      throw new Error();
    const key = await crypto.subtle.importKey(
      "raw",
      tokenKey(encodedKey),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(iv),
        additionalData: new TextEncoder().encode(context),
      },
      key,
      fromBase64Url(ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return fail("MAIL_RECONNECT", "邮箱凭证无法解密，请重新连接 Gmail", 503);
  }
}
function encodedHeader(value: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).length > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((item) => `=?UTF-8?B?${bytesBase64(new TextEncoder().encode(item))}?=`)
    .join("\r\n ");
}
export function emailMime(
  mail: ReviewEmail,
  senderEmail: string,
  host: string,
  clock: Date,
): string {
  if (!validId(mail.id)) fail("INVALID_MAIL_ID", "邮件邀请标识无效");
  if (!validEmail(mail.to) || mail.to.length > 254 || !validEmail(senderEmail))
    fail("INVALID_RECIPIENT", "请提供单个有效收件邮箱");
  if (
    !mail.subject ||
    mail.subject.length > 200 ||
    /[\r\n\x00-\x1f\x7f]/.test(mail.subject)
  )
    fail("INVALID_MAIL_SUBJECT", "邮件主题为空、过长或包含无效字符");
  if (!mail.text || mail.text.length > 20000 || /\x00/.test(mail.text))
    fail("INVALID_MAIL_BODY", "邮件正文为空、过长或包含无效字符");
  if (!/^[a-z0-9.-]+$/i.test(host))
    fail("MAIL_CONFIG", "邮件域名配置无效", 503);
  const body =
    bytesBase64(new TextEncoder().encode(mail.text.replace(/\r?\n/g, "\r\n")))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "";
  const message = [
    `From: ${senderEmail}`,
    `To: ${mail.to.toLowerCase()}`,
    `Subject: ${encodedHeader(mail.subject)}`,
    `Date: ${clock.toUTCString()}`,
    `Message-ID: <tf-${mail.id}@${host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "",
  ].join("\r\n");
  return base64Url(new TextEncoder().encode(message));
}

interface SettingsRow {
  operator_email: string;
  operator_id: string;
  sender_email: string;
  refresh_token_enc: string;
  connection_id: string;
}
interface OAuthRow {
  state_hash: string;
  cookie_hash: string;
  operator_email: string;
  operator_id: string;
  verifier_enc: string;
  expires_at: number;
  used_at: number | null;
}
interface JobRow {
  id: string;
  status: MailDelivery["status"];
  message_id: string | null;
  sent_at: string | null;
  reason: string;
  updated_at: number;
}
interface Configuration {
  clientId: string;
  clientSecret: string;
  key: string;
  operatorEmail: string;
  base: URL;
}
interface Operator {
  email: string;
  id: string;
}
interface ServiceOptions {
  env: GmailEnvironment;
  db?: D1Database;
  fetcher?: typeof fetch;
  now?: () => number;
}
function config(env: GmailEnvironment): Configuration {
  const names: (keyof GmailEnvironment)[] = [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_TOKEN_KEY",
    "MAIL_OPERATOR_EMAIL",
    "MAIL_BASE_URL",
  ];
  const missing = names.filter((name) => !text(env[name]));
  if (missing.length)
    fail(
      "MAIL_CONFIG",
      `尚未配置 Gmail 自动发送：缺少 ${missing.join("、")}`,
      503,
    );
  let base: URL;
  try {
    base = new URL(text(env.MAIL_BASE_URL));
  } catch {
    return fail("MAIL_CONFIG", "MAIL_BASE_URL 必须是本站固定公开地址", 503);
  }
  if (
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    fail(
      "MAIL_CONFIG",
      "MAIL_BASE_URL 必须为本站 HTTPS 源地址，本地开发仅允许 loopback",
      503,
    );
  const operatorEmail = text(env.MAIL_OPERATOR_EMAIL).toLowerCase();
  if (!EMAIL.test(operatorEmail))
    fail("MAIL_CONFIG", "MAIL_OPERATOR_EMAIL 格式无效", 503);
  tokenKey(text(env.GMAIL_TOKEN_KEY));
  return {
    clientId: text(env.GMAIL_CLIENT_ID),
    clientSecret: text(env.GMAIL_CLIENT_SECRET),
    key: text(env.GMAIL_TOKEN_KEY),
    operatorEmail,
    base,
  };
}
function operator(request: Request, environment: GmailEnvironment): Operator {
  const email = text(
      request.headers.get("oai-authenticated-user-email"),
    ).toLowerCase(),
    id = text(request.headers.get("oai-authenticated-user-id"));
  if (!email || !id)
    fail("MAIL_LOGIN_REQUIRED", "请先使用站点登录功能登录邮件操作者账号", 401);
  if (
    !text(environment.MAIL_OPERATOR_EMAIL) ||
    email !== text(environment.MAIL_OPERATOR_EMAIL).toLowerCase()
  )
    fail(
      "MAIL_FORBIDDEN",
      "只有已配置的站点操作者可以管理 Gmail 或发送真实邮件",
      403,
    );
  return { email, id };
}
function origin(request: Request, cfg: Configuration) {
  if (
    new URL(request.url).origin !== cfg.base.origin ||
    (request.headers.get("origin") &&
      request.headers.get("origin") !== cfg.base.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    fail("MAIL_ORIGIN", "邮件操作请求来源不匹配", 403);
}
export function authorizeGmailRequest(
  request: Request,
  environment: GmailEnvironment,
) {
  const who = operator(request, environment),
    cfg = config(environment);
  origin(request, cfg);
  return who;
}
function cookie(request: Request): string {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${OAUTH_COOKIE}=`))
      ?.slice(OAUTH_COOKIE.length + 1) ?? ""
  );
}
function cookieValue(cfg: Configuration, value: string, clear = false): string {
  return `${OAUTH_COOKIE}=${value}; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${cfg.base.protocol === "https:" ? "; Secure" : ""}`;
}
function settingsContext(
  row: Pick<SettingsRow, "operator_email" | "sender_email">,
): string {
  return `gmail-refresh:v1:${row.operator_email}:${row.sender_email}`;
}
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function createGmailService(options: ServiceOptions) {
  const fetcher = options.fetcher ?? fetch,
    now = options.now ?? Date.now;
  function db(): D1Database {
    return options.db ?? fail("MAIL_DATABASE", "邮件发送记录数据库未连接", 503);
  }
  async function tables() {
    await db().batch([
      db().prepare(
        "CREATE TABLE IF NOT EXISTS mail_settings (id TEXT PRIMARY KEY, operator_email TEXT NOT NULL, operator_id TEXT NOT NULL, sender_email TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, connection_id TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      ),
      db().prepare(
        "CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, operator_email TEXT NOT NULL, operator_id TEXT NOT NULL, verifier_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)",
      ),
      db().prepare(
        "CREATE TABLE IF NOT EXISTS mail_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, message_id TEXT, sent_at TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      ),
    ]);
  }
  async function settings(): Promise<SettingsRow | null> {
    return db()
      .prepare("SELECT * FROM mail_settings WHERE id = 'gmail'")
      .first<SettingsRow>();
  }
  async function tokenRequest(
    cfg: Configuration,
    values: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          ...values,
        }),
      });
    } catch (error) {
      const timeout =
        error instanceof DOMException && error.name === "TimeoutError";
      return fail(
        timeout ? "MAIL_TOKEN_TIMEOUT" : "MAIL_TOKEN_TRANSPORT",
        timeout
          ? "连接 Google 授权服务超时，请重新连接 Gmail"
          : "无法连接 Google 授权服务，邮件尚未发送",
        503,
      );
    }
    if (response.status >= 300 && response.status < 400)
      fail(
        "MAIL_TOKEN_REDIRECT",
        "Google 授权服务返回重定向，已停止请求，请重新连接 Gmail",
        503,
      );
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      body = parsed as Record<string, unknown>;
    } catch (error) {
      const timeout =
        error instanceof DOMException && error.name === "TimeoutError";
      return fail(
        timeout ? "MAIL_TOKEN_TIMEOUT" : "MAIL_TOKEN_RESPONSE",
        timeout
          ? "读取 Google 授权响应超时，请重新连接 Gmail"
          : "Google 授权响应无效，请稍后重新连接 Gmail",
        503,
      );
    }
    if (
      !response.ok ||
      typeof body.access_token !== "string" ||
      !body.access_token
    )
      fail(
        "MAIL_RECONNECT",
        "Google 授权已失效或未成功，请重新连接 Gmail",
        503,
      );
    if (
      typeof body.scope === "string" &&
      !body.scope
        .split(/\s+/)
        .includes("https://www.googleapis.com/auth/gmail.send")
    )
      fail(
        "MAIL_SCOPE",
        "Google 未授予发送邮件权限，请重新授权 Gmail 发送权限",
        403,
      );
    return body;
  }
  async function status(request: Request): Promise<GmailStatus> {
    let cfg: Configuration;
    const canManage = Boolean(
      text(options.env.MAIL_OPERATOR_EMAIL) &&
        text(request.headers.get("oai-authenticated-user-id")) &&
        text(
          request.headers.get("oai-authenticated-user-email"),
        ).toLowerCase() === text(options.env.MAIL_OPERATOR_EMAIL).toLowerCase(),
    );
    try {
      cfg = config(options.env);
    } catch (error) {
      return {
        configured: false,
        connected: false,
        senderEmail: "",
        canManage,
        message:
          error instanceof GmailError
            ? error.message
            : "Gmail 自动发送尚未配置",
      };
    }
    if (!canManage)
      return {
        configured: true,
        connected: false,
        senderEmail: "",
        canManage: false,
        message:
          "请使用已配置的站点操作者账号登录；演示 HR 账号不能连接或发送真实邮件。",
      };
    try {
      origin(request, cfg);
      await tables();
      const row = await settings();
      const connected = Boolean(
        row &&
          row.operator_email === cfg.operatorEmail &&
          row.operator_id ===
            text(request.headers.get("oai-authenticated-user-id")),
      );
      if (connected)
        await decryptToken(
          row!.refresh_token_enc,
          cfg.key,
          settingsContext(row!),
        );
      return {
        configured: true,
        connected,
        senderEmail: connected ? row!.sender_email : "",
        canManage: true,
        message: connected
          ? "Gmail 已连接，可由本站操作者发送候选人资料核对邮件。"
          : "请连接 Gmail 并授予发送权限；连接后系统才能自动发送邮件。",
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        senderEmail: "",
        canManage: true,
        message:
          error instanceof GmailError
            ? error.message
            : "无法读取邮箱连接状态，请稍后重试。",
      };
    }
  }
  async function action(
    request: Request,
    input: Record<string, unknown>,
  ): Promise<Response> {
    const who = operator(request, options.env),
      cfg = config(options.env);
    origin(request, cfg);
    await tables();
    if (input.action === "connect") {
      const rawState = randomToken(),
        rawCookie = randomToken(),
        verifier = randomToken(),
        stateHash = await hash(rawState);
      await db()
        .prepare(
          "DELETE FROM oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL",
        )
        .bind(now())
        .run();
      await db()
        .prepare(
          "INSERT INTO oauth_states (state_hash,cookie_hash,operator_email,operator_id,verifier_enc,expires_at,used_at) VALUES (?,?,?,?,?,?,NULL)",
        )
        .bind(
          stateHash,
          await hash(rawCookie),
          who.email,
          who.id,
          await encryptToken(verifier, cfg.key, `gmail-pkce:${stateHash}`),
          now() + OAUTH_TTL,
        )
        .run();
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      Object.entries({
        client_id: cfg.clientId,
        redirect_uri: new URL(CALLBACK_PATH, cfg.base).href,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent select_account",
        state: rawState,
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      return Response.json(
        { authorizationUrl: url.href },
        { headers: { ...headers, "set-cookie": cookieValue(cfg, rawCookie) } },
      );
    }
    if (input.action === "disconnect") {
      const row = await settings();
      await db().batch([
        db().prepare("DELETE FROM mail_settings WHERE id = 'gmail'"),
        db()
          .prepare("DELETE FROM oauth_states WHERE operator_email = ?")
          .bind(who.email),
      ]);
      let revoked = false;
      if (row) {
        try {
          const token = await decryptToken(
            row.refresh_token_enc,
            cfg.key,
            settingsContext(row),
          );
          const response = await fetcher(
            "https://oauth2.googleapis.com/revoke",
            {
              method: "POST",
              redirect: "manual",
              signal: AbortSignal.timeout(12000),
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token }),
            },
          );
          revoked = response.ok;
        } catch {
          /* Local disconnection is authoritative even when provider revocation is unavailable. */
        }
      }
      return Response.json(
        {
          disconnected: true,
          message:
            !row || revoked
              ? "Gmail 已断开，网站不再使用该邮箱发送邮件。"
              : "网站已断开 Gmail；Google 侧撤销未能确认，可在 Google 账号设置中撤销应用权限。",
        },
        { headers: { ...headers, "set-cookie": cookieValue(cfg, "", true) } },
      );
    }
    return fail("MAIL_ACTION", "不支持的 Gmail 操作");
  }
  function callbackRedirect(
    cfg: Configuration,
    result: string,
    code?: string,
  ): Response {
    const url = new URL("/mail-connect", cfg.base);
    url.searchParams.set("gmail", result);
    if (code) url.searchParams.set("code", code);
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        location: url.href,
        "set-cookie": cookieValue(cfg, "", true),
      },
    });
  }
  async function callback(request: Request): Promise<Response> {
    const cfg = config(options.env);
    try {
      const who = operator(request, options.env);
      // Google returns by top-level cross-site navigation; the state cookie is the CSRF binding.
      if (new URL(request.url).origin !== cfg.base.origin)
        fail("MAIL_ORIGIN", "回调地址不匹配", 403);
      const url = new URL(request.url),
        rawState = text(url.searchParams.get("state")),
        rawCookie = cookie(request);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(rawState) ||
        !/^[A-Za-z0-9_-]{43}$/.test(rawCookie)
      )
        fail("MAIL_OAUTH_STATE", "授权状态无效，请重新连接 Gmail", 403);
      await tables();
      const stateHash = await hash(rawState);
      const row = await db()
        .prepare(
          "UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND cookie_hash = ? AND operator_email = ? AND operator_id = ? AND expires_at > ? AND used_at IS NULL RETURNING *",
        )
        .bind(now(), stateHash, await hash(rawCookie), who.email, who.id, now())
        .first<OAuthRow>();
      if (!row)
        fail("MAIL_OAUTH_STATE", "授权已过期或已使用，请重新连接 Gmail", 403);
      if (url.searchParams.has("error"))
        fail("MAIL_OAUTH_DENIED", "Google 邮箱授权未完成，请重新连接", 403);
      const code = text(url.searchParams.get("code"));
      if (!code || code.length > 8192 || /[\r\n]/.test(code))
        fail("MAIL_OAUTH_CODE", "Google 授权码无效，请重新连接", 403);
      const verifier = await decryptToken(
        row.verifier_enc,
        cfg.key,
        `gmail-pkce:${stateHash}`,
      );
      const granted = await tokenRequest(cfg, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: new URL(CALLBACK_PATH, cfg.base).href,
      });
      if (typeof granted.refresh_token !== "string" || !granted.refresh_token)
        fail(
          "MAIL_REFRESH_REQUIRED",
          "Google 未返回离线授权，请重新连接并同意授权",
          403,
        );
      const response = await fetcher(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        {
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
          headers: { authorization: `Bearer ${granted.access_token}` },
        },
      );
      if (!response.ok)
        fail("MAIL_IDENTITY", "无法确认 Google 发件邮箱，请重新连接", 403);
      const identity = (await response.json()) as {
        email?: unknown;
        email_verified?: unknown;
      };
      const sender = text(identity.email).toLowerCase();
      if (identity.email_verified !== true || !EMAIL.test(sender))
        fail(
          "MAIL_IDENTITY",
          "Google 发件邮箱未经验证，请更换 Gmail 账号",
          403,
        );
      const setting = { operator_email: who.email, sender_email: sender };
      // Disconnect deletes this state, including states whose token exchange is still in flight.
      const saved = await db()
        .prepare(
          "INSERT INTO mail_settings (id,operator_email,operator_id,sender_email,refresh_token_enc,connection_id,updated_at) SELECT 'gmail',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM oauth_states WHERE state_hash=? AND operator_email=? AND operator_id=? AND used_at=? AND expires_at>?) ON CONFLICT(id) DO UPDATE SET operator_email=excluded.operator_email,operator_id=excluded.operator_id,sender_email=excluded.sender_email,refresh_token_enc=excluded.refresh_token_enc,connection_id=excluded.connection_id,updated_at=excluded.updated_at",
        )
        .bind(
          who.email,
          who.id,
          sender,
          await encryptToken(
            granted.refresh_token,
            cfg.key,
            settingsContext(setting),
          ),
          crypto.randomUUID(),
          now(),
          stateHash,
          who.email,
          who.id,
          row.used_at,
          now(),
        )
        .run();
      if (saved.meta.changes !== 1)
        fail(
          "MAIL_OAUTH_CANCELLED",
          "邮箱连接已取消或过期，请重新连接 Gmail",
          409,
        );
      return callbackRedirect(cfg, "connected");
    } catch (error) {
      return callbackRedirect(
        cfg,
        "error",
        error instanceof GmailError ? error.code : "MAIL_OAUTH_FAILED",
      );
    }
  }
  function delivery(row: JobRow): MailDelivery {
    return {
      status: row.status,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      ...(row.sent_at ? { sentAt: row.sent_at } : {}),
      reason: row.reason,
    };
  }
  async function readDelivery(id: string): Promise<MailResult | null> {
    if (!validId(id)) return null;
    const table = await db()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_jobs'",
      )
      .first();
    if (!table) return null;
    const row = await db()
      .prepare("SELECT * FROM mail_jobs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    if (row?.status === "sending" && row.updated_at <= now() - STALE_SEND_MS)
      return {
        status: "unknown",
        reason:
          "上次发送过程已中断，是否已发送无法确认；请核对 Gmail 已发送邮件，系统不会自动重发。",
      };
    return row ? delivery(row) : null;
  }
  async function existingJob(id: string): Promise<MailDelivery | null> {
    let row = await db()
      .prepare("SELECT * FROM mail_jobs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    if (row?.status === "sending" && row.updated_at <= now() - STALE_SEND_MS) {
      await db()
        .prepare(
          "UPDATE mail_jobs SET status='unknown', reason=?, updated_at=? WHERE id=? AND status='sending' AND updated_at <= ?",
        )
        .bind(
          "上次发送过程已中断，是否已发送无法确认；请核对 Gmail 已发送邮件，系统不会自动重发。",
          now(),
          id,
          now() - STALE_SEND_MS,
        )
        .run();
      row = await db()
        .prepare("SELECT * FROM mail_jobs WHERE id = ?")
        .bind(id)
        .first<JobRow>();
    }
    return row ? delivery(row) : null;
  }
  async function saveDelivery(id: string, value: MailDelivery) {
    const result = await db()
      .prepare(
        "UPDATE mail_jobs SET status=?, message_id=?, sent_at=?, reason=?, updated_at=? WHERE id=? AND status='sending'",
      )
      .bind(
        value.status,
        value.messageId ?? null,
        value.sentAt ?? null,
        value.reason,
        now(),
        id,
      )
      .run();
    return result.meta.changes === 1
      ? value
      : ((await existingJob(id)) ?? {
          status: "unknown" as const,
          reason:
            "邮件发送记录未能确认，请核对 Gmail 已发送邮件；系统不会自动重发。",
        });
  }
  async function send(
    request: Request,
    mail: ReviewEmail,
  ): Promise<MailDelivery> {
    let claimed = false,
      posted = false,
      providerId: string | undefined;
    try {
      const who = operator(request, options.env),
        cfg = config(options.env);
      origin(request, cfg);
      if (!validId(mail.id)) fail("INVALID_MAIL_ID", "邮件邀请标识无效");
      await tables();
      const old = await existingJob(mail.id);
      if (old) return old;
      const claim = await db()
        .prepare(
          "INSERT OR IGNORE INTO mail_jobs (id,status,reason,created_at,updated_at) VALUES (?,'sending',?,?,?)",
        )
        .bind(mail.id, "邮件正在提交 Gmail，请勿重复发送。", now(), now())
        .run();
      if (claim.meta.changes !== 1)
        return (
          (await existingJob(mail.id)) ?? {
            status: "unknown",
            reason: "发送记录正在更新，请稍后查看；系统不会重复发送。",
          }
        );
      claimed = true;
      const row = await settings();
      if (
        !row ||
        row.operator_email !== who.email ||
        row.operator_id !== who.id
      )
        fail(
          "MAIL_NOT_CONNECTED",
          "请先由站点操作者连接 Gmail，邮件尚未发送",
          503,
        );
      const raw = emailMime(
        mail,
        row.sender_email,
        cfg.base.hostname,
        new Date(now()),
      );
      const refresh = await decryptToken(
        row.refresh_token_enc,
        cfg.key,
        settingsContext(row),
      );
      const renewed = await tokenRequest(cfg, {
        grant_type: "refresh_token",
        refresh_token: refresh,
      });
      if (typeof renewed.refresh_token === "string" && renewed.refresh_token)
        await db()
          .prepare(
            "UPDATE mail_settings SET refresh_token_enc=?, updated_at=? WHERE id='gmail' AND connection_id=?",
          )
          .bind(
            await encryptToken(
              renewed.refresh_token,
              cfg.key,
              settingsContext(row),
            ),
            now(),
            row.connection_id,
          )
          .run();
      const current = await settings();
      if (!current || current.connection_id !== row.connection_id)
        fail(
          "MAIL_DISCONNECTED",
          "邮箱连接已变化，邮件尚未发送，请重新生成邀请",
          409,
        );
      posted = true;
      const response = await fetcher(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
          headers: {
            authorization: `Bearer ${renewed.access_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
      if (!response.ok) {
        const redirected = response.status >= 300 && response.status < 400;
        const unknown = redirected || response.status >= 500;
        return await saveDelivery(mail.id, {
          status: unknown ? "unknown" : "failed",
          reason: redirected
            ? "Gmail返回重定向，未继续请求；发送结果无法确认，请核对已发送邮件，系统不会自动重发。"
            : unknown
              ? "Gmail 返回服务器错误，发送结果无法确认；请核对已发送邮件，系统不会自动重发。"
              : response.status === 429
                ? "Gmail 发送额度或速率受限，本次请求被拒绝；请稍后核对后重新生成邀请。"
                : "Gmail 拒绝了发送请求，请检查邮箱权限或授权后重新生成邀请。",
        });
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id || body.id.length > 200)
        return await saveDelivery(mail.id, {
          status: "unknown",
          reason:
            "Gmail 未返回可核实的邮件标识，发送结果未知；请核对已发送邮件，系统不会自动重发。",
        });
      providerId = body.id;
      return await saveDelivery(mail.id, {
        status: "sent",
        messageId: body.id,
        sentAt: new Date(now()).toISOString(),
        reason: "Gmail 已接受并发送邮件；此状态不代表候选人已收到或阅读。",
      });
    } catch (error) {
      const result: MailDelivery = {
        status: posted ? "unknown" : "failed",
        ...(providerId ? { messageId: providerId } : {}),
        reason: posted
          ? "邮件提交后连接中断或记录未能完成，发送结果无法确认；请核对 Gmail 已发送邮件，系统不会自动重发。"
          : error instanceof GmailError
            ? error.message
            : "邮件发送服务暂时不可用，邮件尚未提交 Gmail。",
      };
      if (claimed) {
        try {
          await saveDelivery(mail.id, result);
        } catch {
          /* Keep the existing claim: a later request will see unknown, never resend. */
        }
      }
      return result;
    }
  }
  return { status, action, callback, send, readDelivery };
}
