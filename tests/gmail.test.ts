import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  authorizeGmailRequest,
  createGmailService,
  decryptToken,
  emailMime,
  encryptToken,
  GmailError,
  pkceChallenge,
  tokenKey,
  type GmailEnvironment,
  type ReviewEmail,
} from "../lib/gmail.ts";
import { readGmailRequest } from "../lib/gmail-request.ts";

const BASE = "https://recruitment.example.com";
const KEY = Buffer.alloc(32, 7).toString("base64");
const OWNER = "owner@example.com";
const SENDER = "sender@gmail.com";
const REFRESH = "synthetic-refresh-token-never-real";
const SCOPES = "https://www.googleapis.com/auth/gmail.send openid email";
const MAIL: ReviewEmail = {
  id: "review_one",
  to: "candidate@example.com",
  subject: "请核对您的候选人资料",
  text: "您好，\n请检查姓名与联系方式。",
};
const ENV: GmailEnvironment = {
  GMAIL_CLIENT_ID: "synthetic-client-id",
  GMAIL_CLIENT_SECRET: "synthetic-client-secret",
  GMAIL_TOKEN_KEY: KEY,
  MAIL_OPERATOR_EMAIL: OWNER,
  MAIL_BASE_URL: BASE,
};

function request(path = "/api/gmail", headers: HeadersInit = {}) {
  return new Request(`${BASE}${path}`, {
    headers: {
      "oai-authenticated-user-id": "site-owner",
      "oai-authenticated-user-email": OWNER,
      origin: BASE,
      ...headers,
    },
  });
}
function database() {
  const sqlite = new DatabaseSync(":memory:");
  const faults: { fail: (sql: string) => boolean } = { fail: () => false };
  function prepare(sql: string, values: SQLInputValue[] = []) {
    function execute() {
      if (faults.fail(sql)) throw new Error("Synthetic database failure");
      const result = sqlite.prepare(sql).run(...values);
      return {
        success: true,
        meta: { changes: Number(result.changes) },
        results: [],
      };
    }
    return {
      bind: (...bound: SQLInputValue[]) => prepare(sql, bound),
      first: async () => {
        if (faults.fail(sql)) throw new Error("Synthetic database failure");
        return sqlite.prepare(sql).get(...values) ?? null;
      },
      run: async () => execute(),
      execute,
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite, faults };
}
function fixture(env: GmailEnvironment = ENV) {
  const storage = database();
  const calls: { url: string; init?: RequestInit }[] = [];
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const provider = {
    scope: SCOPES,
    refresh: REFRESH,
    verified: true,
    refreshFails: false,
    revokeFails: false,
    beforeIdentity: undefined as (() => Promise<void>) | undefined,
    send: async () => Response.json({ id: "gmail-message-one" }),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "refresh_token" && provider.refreshFails)
        return Response.json(
          { error: "invalid_grant", error_description: "MUST_NOT_LEAK" },
          { status: 400 },
        );
      return Response.json({
        access_token: "synthetic-access-token",
        scope: provider.scope,
        ...(params.get("grant_type") === "authorization_code" &&
        provider.refresh
          ? { refresh_token: provider.refresh }
          : {}),
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
      if (provider.beforeIdentity) await provider.beforeIdentity();
      return Response.json({
        email: SENDER,
        email_verified: provider.verified,
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke")
      return new Response(null, { status: provider.revokeFails ? 503 : 200 });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
      return provider.send();
    throw new Error(
      "Unexpected external request: tests must never use the network",
    );
  };
  const service = createGmailService({
    env,
    db: storage.db,
    fetcher,
    now: () => clock,
  });
  async function begin() {
    const response = await service.action(request(), {
      action: "connect",
      returnTo: "https://untrusted.example",
    });
    const { authorizationUrl } = (await response.json()) as {
      authorizationUrl: string;
    };
    const url = new URL(authorizationUrl);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { response, url, cookie, state: url.searchParams.get("state")! };
  }
  function callback(
    start: Awaited<ReturnType<typeof begin>>,
    extra = "&code=synthetic-authorization-code",
    headers: HeadersInit = {},
  ) {
    return new Request(
      `${BASE}/api/gmail/callback?state=${start.state}${extra}`,
      {
        headers: {
          "oai-authenticated-user-id": "site-owner",
          "oai-authenticated-user-email": OWNER,
          cookie: start.cookie,
          "sec-fetch-site": "cross-site",
          ...headers,
        },
      },
    );
  }
  async function connect() {
    const start = await begin();
    const response = await service.callback(callback(start));
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      `${BASE}/mail-connect?gmail=connected`,
    );
    return start;
  }
  return {
    ...storage,
    calls,
    service,
    provider,
    begin,
    callback,
    connect,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    sendCount: () =>
      calls.filter((call) => call.url.endsWith("/messages/send")).length,
  };
}

test("AES-GCM tokens require a 32-byte key, random nonce and matching row context", async () => {
  assert.equal(tokenKey(KEY).length, 32);
  for (const value of [
    "",
    "password",
    Buffer.alloc(16).toString("base64"),
    "_".repeat(43) + "=",
  ])
    assert.throws(() => tokenKey(value), GmailError);
  const first = await encryptToken(REFRESH, KEY, "row-one");
  const second = await encryptToken(REFRESH, KEY, "row-one");
  assert.notEqual(first, second);
  assert.ok(!first.includes(REFRESH));
  assert.equal(await decryptToken(first, KEY, "row-one"), REFRESH);
  await assert.rejects(decryptToken(first, KEY, "row-two"), GmailError);
  await assert.rejects(
    decryptToken(first, Buffer.alloc(32, 8).toString("base64"), "row-one"),
    GmailError,
  );
  await assert.rejects(
    decryptToken(first.slice(0, -4) + "AAAA", KEY, "row-one"),
    GmailError,
  );
});

test("PKCE challenge matches the RFC 7636 S256 vector", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("public demo cookies, foreign Sites users and foreign origins cannot manage or send", async () => {
  const f = fixture();
  const demo = new Request(`${BASE}/api/gmail`, {
    headers: {
      cookie: "recruitment_session=hr; role=hr",
      authorization: "Bearer fake",
    },
  });
  await assert.rejects(
    f.service.action(demo, { action: "connect" }),
    (error) => error instanceof GmailError && error.status === 401,
  );
  await assert.rejects(
    f.service.action(
      request("/api/gmail", {
        "oai-authenticated-user-email": "visitor@example.com",
      }),
      { action: "connect" },
    ),
    (error) => error instanceof GmailError && error.status === 403,
  );
  await assert.rejects(
    f.service.action(
      request("/api/gmail", { origin: "https://untrusted.example" }),
      { action: "connect" },
    ),
    (error) => error instanceof GmailError && error.code === "MAIL_ORIGIN",
  );
  await assert.rejects(
    f.service.action(
      request("/api/gmail", { "sec-fetch-site": "cross-site" }),
      { action: "connect" },
    ),
    GmailError,
  );
  assert.equal((await f.service.send(demo, MAIL)).status, "failed");
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mail_jobs'")
      .get()!.n,
    0,
  );
});

test("configuration and status fail closed without leaking credentials or sender to visitors", async () => {
  const f = fixture({ ...ENV, GMAIL_TOKEN_KEY: "bad-key" });
  const disabled = await f.service.status(request());
  assert.equal(disabled.configured, false);
  assert.equal(disabled.connected, false);
  assert.ok(!JSON.stringify(disabled).includes("bad-key"));
  const valid = fixture();
  await valid.connect();
  const visitor = await valid.service.status(new Request(`${BASE}/api/gmail`));
  assert.equal(visitor.configured, true);
  assert.equal(visitor.connected, false);
  assert.equal(visitor.senderEmail, "");
  assert.equal(visitor.canManage, false);
  assert.equal(
    (
      await valid.service.status(
        request("/api/gmail", {
          "oai-authenticated-user-id": "different-owner-id",
        }),
      )
    ).connected,
    false,
  );
  const owner = await valid.service.status(request());
  assert.equal(owner.connected, true);
  assert.equal(owner.senderEmail, SENDER);
  assert.equal(
    valid.calls.length,
    2,
    "Status must never refresh OAuth credentials or send mail",
  );
  for (const MAIL_BASE_URL of [
    "http://public.example.com",
    "https://public.example.com/path",
    "https://public.example.com?redirect=evil",
    "https://user:password@public.example.com",
  ])
    assert.equal(
      (await fixture({ ...ENV, MAIL_BASE_URL }).service.status(request()))
        .configured,
      false,
    );
});

test("OAuth initiation pins redirect, uses only send plus identity scopes and hashes state/cookie", async () => {
  const f = fixture();
  const start = await f.begin();
  assert.equal(start.url.origin, "https://accounts.google.com");
  assert.equal(start.url.pathname, "/o/oauth2/v2/auth");
  assert.equal(
    start.url.searchParams.get("redirect_uri"),
    `${BASE}/api/gmail/callback`,
  );
  assert.equal(start.url.searchParams.get("scope"), SCOPES);
  assert.equal(start.url.searchParams.get("access_type"), "offline");
  assert.equal(start.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(start.state.length, 43);
  assert.match(
    start.response.headers.get("set-cookie")!,
    /Path=\/api\/gmail\/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
  );
  assert.equal(start.response.headers.get("cache-control"), "no-store");
  assert.ok(!start.url.href.includes(ENV.GMAIL_CLIENT_SECRET!));
  const row = f.sqlite.prepare("SELECT * FROM oauth_states").get()!;
  assert.notEqual(row.state_hash, start.state);
  assert.notEqual(row.cookie_hash, start.cookie.split("=")[1]);
  const verifier = await decryptToken(
    String(row.verifier_enc),
    KEY,
    `gmail-pkce:${row.state_hash}`,
  );
  assert.equal(
    await pkceChallenge(verifier),
    start.url.searchParams.get("code_challenge"),
  );
  assert.equal(
    f.calls.length,
    0,
    "Opening the connect page does not itself send any external request",
  );
});

test("callback accepts Google cross-site navigation once and stores only encrypted refresh token", async () => {
  const f = fixture();
  const start = await f.connect();
  const row = f.sqlite.prepare("SELECT * FROM mail_settings").get()!;
  assert.equal(row.sender_email, SENDER);
  assert.equal(row.operator_id, "site-owner");
  assert.ok(!String(row.refresh_token_enc).includes(REFRESH));
  assert.equal(
    await decryptToken(
      String(row.refresh_token_enc),
      KEY,
      `gmail-refresh:v1:${OWNER}:${SENDER}`,
    ),
    REFRESH,
  );
  assert.ok(!JSON.stringify(row).includes("synthetic-access-token"));
  const tokenCall = f.calls[0];
  const params = new URLSearchParams(String(tokenCall.init?.body));
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("redirect_uri"), `${BASE}/api/gmail/callback`);
  assert.equal(
    await pkceChallenge(params.get("code_verifier")!),
    start.url.searchParams.get("code_challenge"),
  );
  const replay = await f.service.callback(f.callback(start));
  assert.match(
    replay.headers.get("location")!,
    /gmail=error&code=MAIL_OAUTH_STATE/,
  );
  assert.equal(
    f.calls.length,
    2,
    "Replayed state cannot exchange the authorization code twice",
  );
  assert.match(replay.headers.get("set-cookie")!, /Max-Age=0/);
});

test("OAuth state binds cookie, operator identity and ten-minute expiry", async () => {
  for (const variant of ["cookie", "identity", "expired"] as const) {
    const f = fixture();
    const start = await f.begin();
    if (variant === "expired") f.advance(600000);
    const headers: HeadersInit =
      variant === "cookie"
        ? { cookie: "talentflow_gmail_oauth=" + "A".repeat(43) }
        : variant === "identity"
          ? { "oai-authenticated-user-id": "other-id" }
          : {};
    const response = await f.service.callback(
      f.callback(start, "&code=fake", headers),
    );
    assert.match(
      response.headers.get("location")!,
      /gmail=error&code=MAIL_OAUTH_STATE/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.service.status(request())).connected, false);
  }
});

test("denial consumes OAuth state and rejected identity, scopes or offline grant never connect", async () => {
  const denied = fixture();
  const start = await denied.begin();
  const response = await denied.service.callback(
    denied.callback(start, "&error=access_denied"),
  );
  assert.match(response.headers.get("location")!, /code=MAIL_OAUTH_DENIED/);
  assert.match(
    (await denied.service.callback(denied.callback(start))).headers.get(
      "location",
    )!,
    /code=MAIL_OAUTH_STATE/,
  );
  assert.equal(denied.calls.length, 0);
  for (const variant of ["identity", "scope", "refresh"] as const) {
    const f = fixture();
    const pending = await f.begin();
    if (variant === "identity") f.provider.verified = false;
    if (variant === "scope") f.provider.scope = "openid email";
    if (variant === "refresh") f.provider.refresh = "";
    const failed = await f.service.callback(f.callback(pending));
    assert.match(failed.headers.get("location")!, /gmail=error/);
    assert.ok(
      !failed.headers.get("location")!.includes("synthetic-authorization-code"),
    );
    assert.equal((await f.service.status(request())).connected, false);
  }
});

test("UTF-8 MIME uses the verified sender, one recipient and rejects header injection", () => {
  const raw = emailMime(
    MAIL,
    SENDER,
    "recruitment.example.com",
    new Date("2026-10-20T10:00:00Z"),
  );
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(decoded, /From: sender@gmail.com\r\nTo: candidate@example.com/);
  assert.match(decoded, /Message-ID: <tf-review_one@recruitment.example.com>/);
  assert.ok(
    decoded.includes(
      `Subject: =?UTF-8?B?${Buffer.from(MAIL.subject).toString("base64")}?=`,
    ),
  );
  assert.equal(
    Buffer.from(
      decoded.split("\r\n\r\n")[1].replace(/\s/g, ""),
      "base64",
    ).toString("utf8"),
    MAIL.text.replace(/\n/g, "\r\n"),
  );
  for (const to of [
    "a@example.com,b@example.com",
    "Candidate <a@example.com>",
    "a@example.com\n",
    "a@example.com\r\nBcc: evil@example.com",
  ])
    assert.throws(
      () =>
        emailMime(
          { ...MAIL, to },
          SENDER,
          "recruitment.example.com",
          new Date(),
        ),
      GmailError,
    );
  assert.throws(
    () =>
      emailMime(
        { ...MAIL, id: "review_one\n" },
        SENDER,
        "recruitment.example.com",
        new Date(),
      ),
    GmailError,
  );
  for (const subject of ["", "Hi\r\nBcc: evil@example.com", "x".repeat(201)])
    assert.throws(
      () =>
        emailMime(
          { ...MAIL, subject },
          SENDER,
          "recruitment.example.com",
          new Date(),
        ),
      GmailError,
    );
});

test("Gmail success requires 2xx plus message id and duplicate invitation never sends again", async () => {
  const f = fixture();
  await f.connect();
  const first = await f.service.send(request(), MAIL);
  assert.equal(first.status, "sent");
  assert.equal(first.messageId, "gmail-message-one");
  assert.ok(first.sentAt);
  assert.deepEqual(
    await f.service.send(request(), { ...MAIL, to: "different@example.com" }),
    first,
  );
  assert.deepEqual(await f.service.readDelivery(MAIL.id), first);
  assert.equal(f.sendCount(), 1);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/token")).length, 2);
  const dispatch = f.calls.find((call) => call.url.endsWith("/messages/send"))!;
  assert.equal(dispatch.init?.method, "POST");
  assert.equal(
    new Headers(dispatch.init?.headers).get("authorization"),
    "Bearer synthetic-access-token",
  );
  const body = JSON.parse(String(dispatch.init?.body)) as { raw: string };
  assert.match(
    Buffer.from(body.raw, "base64url").toString("utf8"),
    /To: candidate@example.com/,
  );
});

test("concurrent requests atomically claim one invitation before calling Google", async () => {
  const f = fixture();
  await f.connect();
  const results = await Promise.all([
    f.service.send(request(), MAIL),
    f.service.send(request(), MAIL),
  ]);
  assert.equal(f.sendCount(), 1);
  assert.ok(results.some((result) => result.status === "sent"));
  assert.ok(
    results.every(
      (result) => result.status === "sent" || result.status === "sending",
    ),
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM mail_jobs").get()!.n,
    1,
  );
});

test("pre-dispatch validation, disconnected mailbox and failed refresh never call Gmail send", async () => {
  const disconnected = fixture();
  assert.equal(
    (await disconnected.service.send(request(), MAIL)).status,
    "failed",
  );
  assert.equal(disconnected.sendCount(), 0);
  const f = fixture();
  await f.connect();
  const invalid = await f.service.send(request(), {
    ...MAIL,
    id: "invalid_recipient",
    to: "bad\nBcc: evil@example.com",
  });
  assert.equal(invalid.status, "failed");
  f.provider.refreshFails = true;
  const failed = await f.service.send(request(), MAIL);
  assert.equal(failed.status, "failed");
  assert.ok(!failed.reason.includes("MUST_NOT_LEAK"));
  assert.equal(f.sendCount(), 0);
  const calls = f.calls.length;
  assert.deepEqual(await f.service.send(request(), MAIL), failed);
  assert.equal(f.calls.length, calls);
});

test("server error, network interruption and unverifiable 2xx become unknown without blind retry", async () => {
  for (const variant of [
    "server",
    "network",
    "missing_id",
    "malformed_json",
  ] as const) {
    const f = fixture();
    await f.connect();
    f.provider.send = async () => {
      if (variant === "network")
        throw new Error("synthetic timeout MUST_NOT_LEAK");
      if (variant === "server")
        return new Response("MUST_NOT_LEAK", { status: 503 });
      if (variant === "missing_id") return Response.json({});
      return new Response("<invalid json>");
    };
    const result = await f.service.send(request(), MAIL);
    assert.equal(result.status, "unknown");
    assert.ok(!result.reason.includes("MUST_NOT_LEAK"));
    assert.deepEqual(await f.service.send(request(), MAIL), result);
    assert.equal(f.sendCount(), 1);
  }
});

test("explicit provider rejection is failed and never retried with the same invitation", async () => {
  for (const status of [400, 401, 403, 429]) {
    const f = fixture();
    await f.connect();
    f.provider.send = async () =>
      new Response("private provider diagnostics", { status });
    const result = await f.service.send(request(), MAIL);
    assert.equal(result.status, "failed");
    assert.ok(!result.reason.includes("private provider diagnostics"));
    assert.deepEqual(await f.service.send(request(), MAIL), result);
    assert.equal(f.sendCount(), 1);
  }
});

test("post-dispatch database failure returns unknown and retained sending claim blocks retry", async () => {
  const f = fixture();
  await f.connect();
  f.provider.send = async () => {
    f.faults.fail = (sql) => sql.startsWith("UPDATE mail_jobs SET status=?");
    return Response.json({ id: "accepted-before-db-failed" });
  };
  const result = await f.service.send(request(), MAIL);
  assert.equal(result.status, "unknown");
  assert.equal(result.messageId, "accepted-before-db-failed");
  assert.equal(
    f.sqlite.prepare("SELECT status FROM mail_jobs").get()!.status,
    "sending",
  );
  assert.equal((await f.service.send(request(), MAIL)).status, "sending");
  f.advance(120000);
  assert.equal((await f.service.readDelivery(MAIL.id))!.status, "unknown");
  assert.equal(
    f.sqlite.prepare("SELECT status FROM mail_jobs").get()!.status,
    "sending",
    "Reading delivery does not mutate records",
  );
  f.faults.fail = () => false;
  assert.equal((await f.service.send(request(), MAIL)).status, "unknown");
  assert.equal(
    f.sqlite.prepare("SELECT status FROM mail_jobs").get()!.status,
    "unknown",
  );
  assert.equal(f.sendCount(), 1);
});

test("delivery lookup is local-only and empty deployments return null without schema writes", async () => {
  const f = fixture();
  assert.equal(await f.service.readDelivery("not_created"), null);
  assert.equal(await f.service.readDelivery("invalid/id"), null);
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mail_jobs'")
      .get()!.n,
    0,
  );
  assert.equal(f.calls.length, 0);
});

test("disconnect removes credentials and pending grants, preserves prior receipts and tolerates revoke failure", async () => {
  const f = fixture();
  await f.connect();
  await f.service.send(request(), MAIL);
  const pending = await f.begin();
  f.provider.revokeFails = true;
  const response = await f.service.action(request(), { action: "disconnect" });
  const body = (await response.json()) as {
    disconnected: boolean;
    message: string;
  };
  assert.equal(body.disconnected, true);
  assert.match(body.message, /撤销未能确认/);
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM mail_settings").get()!.n,
    0,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n,
    0,
  );
  assert.equal((await f.service.status(request())).connected, false);
  assert.match(
    (await f.service.callback(f.callback(pending))).headers.get("location")!,
    /code=MAIL_OAUTH_STATE/,
  );
  assert.equal((await f.service.send(request(), MAIL)).status, "sent");
  assert.equal(f.sendCount(), 1);
  await assert.rejects(
    f.service.action(request(), { action: "send", to: "evil@example.com" }),
    (error) => error instanceof GmailError && error.code === "MAIL_ACTION",
  );
});

test("disconnect cancels an already-consumed OAuth callback while Google response is in flight", async () => {
  const f = fixture();
  const start = await f.begin();
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.provider.beforeIdentity = async () => {
    reached();
    await blocked;
  };
  const callback = f.service.callback(f.callback(start));
  await waiting;
  assert.notEqual(
    f.sqlite.prepare("SELECT used_at FROM oauth_states").get()!.used_at,
    null,
  );
  await f.service.action(request(), { action: "disconnect" });
  const requestsAtDisconnect = f.calls.length;
  release();
  const completed = await callback;
  assert.match(
    completed.headers.get("location")!,
    /gmail=error&code=MAIL_OAUTH_CANCELLED/,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM mail_settings").get()!.n,
    0,
  );
  assert.equal((await f.service.status(request())).connected, false);
  assert.equal(
    f.calls.length,
    requestsAtDisconnect,
    "Canceled callback performs no further network request",
  );
});

test("Gmail action body parser counts UTF-8 bytes and accepts the exact 2 KiB limit", async () => {
  const body = JSON.stringify({ text: "x".repeat(2048 - 11) });
  assert.equal(Buffer.byteLength(body), 2048);
  assert.equal(
    (
      await readGmailRequest(
        new Request(`${BASE}/api/gmail`, { method: "POST", body }),
      )
    ).text,
    "x".repeat(2048 - 11),
  );
  const oversized = JSON.stringify({ text: "汉".repeat(1000) });
  assert.ok(oversized.length < 2048);
  await assert.rejects(
    readGmailRequest(
      new Request(`${BASE}/api/gmail`, { method: "POST", body: oversized }),
    ),
    (error) => error instanceof GmailError && error.status === 413,
  );
});

test("oversized Gmail action streams cancel upstream before buffering the remaining body", async () => {
  let chunks = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(1024));
      if (chunks === 20) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request(`${BASE}/api/gmail`, {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readGmailRequest(req),
    (error) => error instanceof GmailError && error.status === 413,
  );
  assert.equal(cancelled, true);
  assert.ok(chunks < 6);
  let declaredCancelled = false;
  const declared = new ReadableStream<Uint8Array>({
    cancel() {
      declaredCancelled = true;
    },
  });
  await assert.rejects(
    readGmailRequest(
      new Request(`${BASE}/api/gmail`, {
        method: "POST",
        headers: { "content-length": "1000000" },
        body: declared,
        duplex: "half",
      } as RequestInit),
    ),
    (error) => error instanceof GmailError && error.status === 413,
  );
  assert.equal(declaredCancelled, true);
});

test("authorization can reject anonymous Gmail POST before reading its body", () => {
  const req = new Request(`${BASE}/api/gmail`, {
    method: "POST",
    body: "x".repeat(500000),
  });
  assert.throws(
    () => authorizeGmailRequest(req, ENV),
    (error) => error instanceof GmailError && error.status === 401,
  );
  assert.equal(req.bodyUsed, false);
});

test("Gmail action bodies reject malformed UTF-8, JSON primitives and arrays", async () => {
  for (const body of [
    "",
    "{",
    "null",
    "[]",
    '"string"',
    "42",
    new Uint8Array([0xff]),
  ]) {
    await assert.rejects(
      readGmailRequest(
        new Request(`${BASE}/api/gmail`, { method: "POST", body }),
      ),
      (error) => error instanceof GmailError && error.code === "MAIL_REQUEST",
    );
  }
});
