import { env } from "cloudflare:workers";
import type { AppState, User } from "./domain.ts";
import { applyAction, BusinessError, projectState } from "./engine.ts";
import { createSeed, DEMO_USERS } from "./seed.ts";

const COOKIE = "recruitment_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
// Public demo password is verified by a digest; neither sessions nor the state store hold plaintext passwords.
const DEMO_PASSWORD_HASH =
  "9aa06636a970197980fd91eb654ce6a7362be5a3ca6968c309702a9a04afb2b1";
function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding)
    throw new BusinessError(
      "DATABASE_UNAVAILABLE",
      "数据库尚未连接，请检查 D1 绑定",
      503,
    );
  return binding;
}
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function tokenFrom(request: Request): string {
  const cookies = request.headers.get("cookie") || "";
  return (
    cookies
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || ""
  );
}
function cookieHeader(request: Request, token: string, clear = false): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new BusinessError(
      "INVALID_ORIGIN",
      "请求来源不匹配，请从系统页面重新操作",
      403,
    );
}
export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 6 * 1024 * 1024)
    throw new BusinessError(
      "REQUEST_TOO_LARGE",
      "请求内容过大，CSV 上限为 5 MiB",
      413,
    );
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new BusinessError(
      "INVALID_JSON",
      "请求内容必须为有效 JSON 对象",
      400,
    );
  }
}
export async function loadState(): Promise<AppState> {
  const db = database();
  const get = () =>
    db
      .prepare("SELECT revision, payload FROM recruitment_state WHERE id = ?")
      .bind("main")
      .first<{ revision: number; payload: string }>();
  let row = await get();
  if (!row) {
    const initial = createSeed();
    await db
      .prepare(
        "INSERT OR IGNORE INTO recruitment_state (id, revision, payload) VALUES (?, ?, ?)",
      )
      .bind("main", initial.revision, JSON.stringify(initial))
      .run();
    row = await get();
  }
  if (!row)
    throw new BusinessError(
      "DATABASE_UNAVAILABLE",
      "初始化演示数据失败，请刷新后重试",
      503,
    );
  const state = JSON.parse(row.payload) as AppState;
  state.revision = row.revision;
  return state;
}
export async function getUser(
  request: Request,
  required = false,
): Promise<User | null> {
  const token = tokenFrom(request);
  let user: User | null = null;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const session = await database()
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .bind(await hash(token))
      .first<{ user_id: string; expires_at: number }>();
    if (session && session.expires_at > Date.now())
      user =
        DEMO_USERS.find((account) => account.id === session.user_id) || null;
  }
  if (required && !user)
    throw new BusinessError("UNAUTHORIZED", "请先登录演示账号", 401);
  return user;
}
export async function login(request: Request, body: Record<string, unknown>) {
  checkOrigin(request);
  const user = DEMO_USERS.find((account) => account.id === body.userId);
  const password = typeof body.password === "string" ? body.password : "";
  if (
    !user ||
    (await hash(`recruitment-demo-v1:${password}`)) !== DEMO_PASSWORD_HASH
  )
    throw new BusinessError("INVALID_CREDENTIALS", "账号或演示密码不正确", 401);
  const db = database(),
    oldToken = tokenFrom(request);
  if (oldToken)
    await db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hash(oldToken))
      .run();
  await db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .bind(Date.now())
    .run();
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(await hash(token), user.id, Date.now() + SESSION_MS)
    .run();
  return Response.json(
    { user, users: DEMO_USERS },
    {
      headers: {
        "set-cookie": cookieHeader(request, token),
        "cache-control": "no-store",
      },
    },
  );
}
export async function logout(request: Request) {
  checkOrigin(request);
  const token = tokenFrom(request);
  if (token)
    await database()
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hash(token))
      .run();
  return Response.json(
    { user: null, users: DEMO_USERS },
    {
      headers: {
        "set-cookie": cookieHeader(request, "", true),
        "cache-control": "no-store",
      },
    },
  );
}
export async function recruitmentSnapshot(request: Request) {
  const user = (await getUser(request, true))!;
  const state = await loadState();
  return Response.json(
    { user, state: projectState(state, user) },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function recruitmentAction(
  request: Request,
  input: Record<string, unknown>,
) {
  checkOrigin(request);
  const user = (await getUser(request, true))!,
    current = await loadState();
  const next = applyAction(current, user, input);
  const payload = JSON.stringify(next);
  if (new TextEncoder().encode(payload).length > 1900000)
    throw new BusinessError(
      "DEMO_STORAGE_LIMIT",
      "演示库数据已接近容量限制，请缩小导入内容或恢复演示数据",
      413,
    );
  // Compare-and-swap ensures two requests with the same revision cannot both write.
  const result = await database()
    .prepare(
      "UPDATE recruitment_state SET revision = ?, payload = ? WHERE id = ? AND revision = ?",
    )
    .bind(next.revision, payload, "main", current.revision)
    .run();
  if (result.meta.changes !== 1)
    throw new BusinessError(
      "REVISION_CONFLICT",
      "数据已被其他操作更新，请刷新后重试",
      409,
    );
  return Response.json(
    { user, state: projectState(next, user) },
    { headers: { "cache-control": "no-store" } },
  );
}
export function errorResponse(error: unknown) {
  if (error instanceof BusinessError)
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  console.error(
    "Recruitment API error",
    error instanceof Error ? error.message : "Unknown error",
  );
  return Response.json(
    { error: "SERVER_ERROR", message: "服务暂时不可用，请稍后重试" },
    { status: 500 },
  );
}
