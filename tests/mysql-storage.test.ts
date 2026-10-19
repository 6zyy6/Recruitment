import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { BusinessError } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { createMySqlStorage } from "../lib/mysql-storage.ts";

const config = {
  MYSQL_STORAGE_URL: "https://storage.example.com",
  MYSQL_STORAGE_TOKEN: "test-storage-token-with-at-least-32-characters",
};
const unavailable = (error: unknown) => error instanceof BusinessError &&
  error.code === "DATABASE_UNAVAILABLE" && error.status === 503 &&
  !error.message.includes("PRIVATE");

test("missing or unsafe MySQL service configuration fails closed", () => {
  for (const invalid of [
    {},
    { ...config, MYSQL_STORAGE_TOKEN: "short" },
    { ...config, MYSQL_STORAGE_TOKEN: "x".repeat(32) + "\n" },
    { ...config, MYSQL_STORAGE_URL: "not a URL" },
    { ...config, MYSQL_STORAGE_URL: "http://storage.example.com" },
    { ...config, MYSQL_STORAGE_URL: "https://user:password@storage.example.com" },
    { ...config, MYSQL_STORAGE_URL: "https://storage.example.com/?token=PRIVATE" },
    { ...config, MYSQL_STORAGE_URL: "https://storage.example.com/#secret" },
    { ...config, MYSQL_STORAGE_URL: "https://storage.example.com/?" },
    { ...config, MYSQL_STORAGE_URL: "https://storage.example.com/#" },
    { ...config, MYSQL_STORAGE_URL: "https://storage.example.com/another-path" },
  ]) assert.throws(() => createMySqlStorage(invalid), unavailable);
  for (const url of ["http://localhost:3307", "http://127.0.0.1:3307", config.MYSQL_STORAGE_URL]) {
    assert.doesNotThrow(() => createMySqlStorage({ ...config, MYSQL_STORAGE_URL: url }));
  }
});

test("storage uses fixed POST endpoints, bearer authentication and typed results", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const values = [
    { row: { revision: 2, payload: "{}" } }, { row: null },
    { inserted: false }, { inserted: true }, { saved: true }, { saved: false },
    { session: { user_id: "hr", expires_at: 123 } }, { session: null },
    { created: true }, { deleted: true }, { deletedCount: 2 },
  ];
  const storage = createMySqlStorage(config, async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${config.MYSQL_STORAGE_TOKEN}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return Response.json(values.shift());
  });
  assert.deepEqual(await storage.readState(), { revision: 2, payload: "{}" });
  assert.equal(await storage.readState(), null);
  assert.equal(await storage.initializeState({ revision: 1, payload: "{}" }), false);
  assert.equal(await storage.initializeState({ revision: 1, payload: "{}" }), true);
  assert.equal(await storage.saveState(1, { revision: 2, payload: "{}" }), true);
  assert.equal(await storage.saveState(1, { revision: 2, payload: "{}" }), false);
  assert.deepEqual(await storage.findSession("hash"), { user_id: "hr", expires_at: 123 });
  assert.equal(await storage.findSession("hash"), null);
  await storage.createSession("hash", "hr", 123);
  await storage.deleteSession("hash");
  await storage.pruneSessions(123);
  assert.deepEqual(requests, [
    { path: "/v1/state/read", body: {} }, { path: "/v1/state/read", body: {} },
    { path: "/v1/state/initialize", body: { state: { revision: 1, payload: "{}" } } },
    { path: "/v1/state/initialize", body: { state: { revision: 1, payload: "{}" } } },
    { path: "/v1/state/save", body: { expectedRevision: 1, state: { revision: 2, payload: "{}" } } },
    { path: "/v1/state/save", body: { expectedRevision: 1, state: { revision: 2, payload: "{}" } } },
    { path: "/v1/sessions/find", body: { tokenHash: "hash" } },
    { path: "/v1/sessions/find", body: { tokenHash: "hash" } },
    { path: "/v1/sessions/create", body: { tokenHash: "hash", userId: "hr", expiresAt: 123 } },
    { path: "/v1/sessions/delete", body: { tokenHash: "hash" } },
    { path: "/v1/sessions/prune", body: { expiresAt: 123 } },
  ]);
});

test("network, remote HTTP, redirects and body-stream errors do not expose remote details", async () => {
  const failures: typeof fetch[] = [
    async () => { throw new Error("PRIVATE mysql connection details"); },
    async () => new Response("PRIVATE backend failure", { status: 500 }),
    async () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE")); } }), { headers: { "content-type": "application/json" } }),
  ];
  for (const fetcher of failures) await assert.rejects(createMySqlStorage(config, fetcher).readState(), unavailable);
});

test("fetch and response reading share a bounded timeout", async () => {
  const pendingFetch: typeof fetch = async () => new Promise<Response>(() => {});
  await assert.rejects(createMySqlStorage(config, pendingFetch, 10).readState(), unavailable);
  let cancelled = false;
  const pendingBody: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  await assert.rejects(createMySqlStorage(config, pendingBody, 10).readState(), unavailable);
  assert.equal(cancelled, true);
});

test("malformed, oversized or incorrectly typed responses fail closed", async () => {
  for (const body of [null, [], {}, { row: [] }, { row: { revision: "1", payload: "{}" } },
    { row: { revision: -1, payload: "{}" } }, { row: { revision: 1.5, payload: "{}" } },
    { row: { revision: 1, payload: {} } }, { row: { revision: 1, payload: "x".repeat(1900001) } }]) {
    await assert.rejects(createMySqlStorage(config, async () => Response.json(body)).readState(), unavailable);
  }
  for (const response of [
    new Response("{bad json", { headers: { "content-type": "application/json" } }),
    new Response("{\"row\":null}", { headers: { "content-type": "text/html" } }),
    new Response("", { headers: { "content-type": "application/json", "content-length": "9000000" } }),
    new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ]) await assert.rejects(createMySqlStorage(config, async () => response).readState(), unavailable);
  const bad = createMySqlStorage(config, async () => Response.json({ saved: "false", inserted: 1, session: { user_id: 1, expires_at: "later" }, created: false, deleted: false, deletedCount: -1 }));
  await assert.rejects(bad.saveState(1, { revision: 2, payload: "{}" }), unavailable);
  await assert.rejects(bad.initializeState({ revision: 1, payload: "{}" }), unavailable);
  await assert.rejects(bad.findSession("hash"), unavailable);
  await assert.rejects(bad.createSession("hash", "hr", 123), unavailable);
  await assert.rejects(bad.deleteSession("hash"), unavailable);
  await assert.rejects(bad.pruneSessions(123), unavailable);
});

test("a failed MySQL compare-and-swap still returns the server's revision conflict", async (context) => {
  const workerModule = `data:text/javascript,${encodeURIComponent(`export const env = ${JSON.stringify(config)}`)}`;
  const loader = `export function resolve(specifier, context, nextResolve) { return specifier === "cloudflare:workers" ? { url: ${JSON.stringify(workerModule)}, shortCircuit: true } : nextResolve(specifier, context); }`;
  register(`data:text/javascript,${encodeURIComponent(loader)}`);
  const server = await import("../lib/server.ts");
  const state = createSeed();
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/sessions/find") return Response.json({ session: { user_id: "hr", expires_at: Date.now() + 60000 } });
    if (path === "/v1/state/read") return Response.json({ row: { revision: state.revision, payload: JSON.stringify(state) } });
    if (path === "/v1/state/save") return Response.json({ saved: false });
    throw new Error(`Unexpected request ${path}`);
  });
  const request = new Request("https://talentflow.example/api/recruitment", {
    method: "POST", headers: { cookie: `recruitment_session=${"a".repeat(64)}`, origin: "https://talentflow.example" },
  });
  try {
    await server.recruitmentAction(request, { action: "advance", applicationId: "application_1", expectedRevision: state.revision });
    assert.fail("stale state must not be reported as saved");
  } catch (error) {
    assert.ok(error instanceof BusinessError);
    assert.equal(error.code, "REVISION_CONFLICT");
    const response = server.errorResponse(error);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, "REVISION_CONFLICT");
  }
});
