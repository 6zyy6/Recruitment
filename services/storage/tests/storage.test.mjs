import assert from "node:assert/strict";
import { test } from "node:test";
import { createStorageServer } from "../server.mjs";
import { createStore } from "../store.mjs";

const TOKEN = "development-storage-token-for-unit-tests";
const row = (revision, name = "候选人") => ({
  revision, payload: JSON.stringify({ revision, candidates: [{ id: "candidate_1", name }] }),
});

class MemoryPool {
  state = null;
  sessions = new Map();
  queries = [];
  async execute(sql, values) {
    this.queries.push({ sql, values });
    if (sql.startsWith("SELECT revision")) {
      return [this.state ? [sql.includes("payload") ? { ...this.state } : { revision: this.state.revision }] : []];
    }
    if (sql.startsWith("INSERT IGNORE INTO recruitment_state")) {
      if (this.state) return [{ affectedRows: 0 }];
      this.state = { revision: values[1], payload: values[2] };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE recruitment_state")) {
      if (this.state?.revision !== values[3]) return [{ affectedRows: 0 }];
      this.state = { revision: values[0], payload: values[1] };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("SELECT user_id"))
      return [[this.sessions.get(values[0])].filter(Boolean)];
    if (sql.startsWith("INSERT INTO sessions")) {
      this.sessions.set(values[0], { user_id: values[1], expires_at: values[2] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("DELETE FROM sessions WHERE token_hash")) {
      return [{ affectedRows: Number(this.sessions.delete(values[0])) }];
    }
    if (sql.startsWith("DELETE FROM sessions WHERE expires_at")) {
      let affectedRows = 0;
      for (const [hash, session] of this.sessions) {
        if (session.expires_at <= values[0]) {
          this.sessions.delete(hash);
          affectedRows++;
        }
      }
      return [{ affectedRows }];
    }
    throw new Error("Unexpected SQL");
  }
}
class MemoryRedis {
  isReady = true;
  entries = new Map();
  writes = [];
  async get(key) { return this.entries.get(key) ?? null; }
  async set(key, payload, options) {
    this.writes.push({ key, payload, options });
    if (!options.NX || !this.entries.has(key)) this.entries.set(key, payload);
    return "OK";
  }
}
const setup = () => {
  const pool = new MemoryPool(), redis = new MemoryRedis();
  return { pool, redis, store: createStore({ pool, redis, cacheNamespace: "test" }) };
};
async function http(t, overrides = {}) {
  const fixture = setup();
  const server = createStorageServer({ store: fixture.store, token: TOKEN, ...overrides });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body = {}, options = {}) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...options,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { ...fixture, request };
}

test("initialization never overwrites an existing database and a new store reads durable state", async () => {
  const { pool, store } = setup();
  assert.equal(await store.readState(), null);
  const results = await Promise.all([store.initializeState(row(1)), store.initializeState(row(1, "另一个初始化"))]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(await createStore({ pool }).readState(), row(1));
});

test("same-revision concurrent writes commit once and a refreshed writer can continue", async () => {
  const { pool, redis, store } = setup();
  await store.initializeState(row(1));
  const states = [row(2, "HR甲"), row(2, "HR乙")];
  const results = await Promise.all(states.map((state) => store.saveState(1, state)));
  assert.deepEqual([...results].sort(), [false, true]);
  const winner = states[results.indexOf(true)];
  assert.deepEqual(await store.readState(), winner);
  assert.equal(redis.writes.filter((entry) => entry.key.endsWith(":2")).length, 1);
  assert.equal(await store.saveState(2, row(3, "刷新后继续")), true);
  assert.deepEqual(await createStore({ pool }).readState(), row(3, "刷新后继续"));
});

test("cache hits still check MySQL revision and do not fetch the full payload", async () => {
  const { pool, redis, store } = setup();
  await store.initializeState(row(1));
  pool.queries.length = 0;
  const first = await store.readState();
  first.payload = "client mutation";
  assert.deepEqual(await store.readState(), row(1));
  assert.equal(pool.queries.length, 2);
  assert.ok(pool.queries.every(({ sql }) => !sql.includes("payload")));
  assert.deepEqual(redis.writes[0].options, { EX: 60, NX: true });
  pool.state = row(2, "来自其他服务实例");
  assert.deepEqual(await store.readState(), row(2, "来自其他服务实例"));
  assert.equal(redis.entries.get("test:state:main:1"), row(1).payload);
  assert.equal(redis.entries.get("test:state:main:2"), row(2, "来自其他服务实例").payload);
});

test("a writer between revision lookup and cache miss is cached under the actual returned version", async () => {
  const { pool, redis, store } = setup();
  pool.state = row(1);
  redis.get = async () => {
    pool.state = row(2, "并发提交");
    return null;
  };
  assert.deepEqual(await store.readState(), row(2, "并发提交"));
  assert.equal(redis.entries.has("test:state:main:1"), false);
  assert.equal(redis.entries.get("test:state:main:2"), row(2, "并发提交").payload);
});

test("Redis unavailable, rejected, corrupt or stalled falls back without losing committed writes", async () => {
  const { pool, redis, store } = setup();
  redis.isReady = false;
  await store.initializeState(row(1));
  assert.deepEqual(await store.readState(), row(1));
  redis.isReady = true;
  redis.get = async () => { throw new Error("cache offline"); };
  redis.set = async () => { throw new Error("cache offline"); };
  assert.equal(await store.saveState(1, row(2)), true);
  assert.deepEqual(await store.readState(), row(2));
  redis.get = async () => row(1).payload;
  assert.deepEqual(await store.readState(), row(2));
  redis.get = () => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await store.readState(), row(2));
  assert.ok(Date.now() - started < 1000, "A stalled Redis command must have a bounded wait");
  assert.deepEqual(await createStore({ pool }).readState(), row(2));
});

test("fixed routes enforce token authentication, POST and JSON object input", async (t) => {
  const { pool, request } = await http(t);
  for (const authorization of ["", "Bearer wrong-token", TOKEN]) {
    const response = await request("/v1/state/read", {}, { headers: { authorization } });
    assert.equal(response.status, 401);
  }
  assert.equal((await request("/v1/state/read", {}, { method: "GET", body: undefined })).status, 405);
  assert.equal((await request("/v1/query", { sql: "DROP TABLE sessions" })).status, 404);
  assert.equal((await request("/v1/state/read", { sql: "SELECT 1" })).status, 400);
  for (const body of ["", "{", "null", "[]", '"text"'])
    assert.equal((await request("/v1/state/read", {}, { body })).status, 400);
  assert.equal(pool.queries.length, 0);
  const response = await request("/v1/state/read");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.body, { row: null });
});

test("configuration rejects tokens that cannot safely form an internal Authorization header", () => {
  const { store } = setup();
  for (const token of [undefined, "short", "x".repeat(31), "x".repeat(32) + " ", "x".repeat(32) + "\n", "密".repeat(32)])
    assert.throws(() => createStorageServer({ store, token }), /STORAGE_API_TOKEN/);
});

test("state routes validate the envelope and enforce exact next revisions before SQL", async (t) => {
  const { request, pool } = await http(t);
  for (const state of [null, [], { ...row(1), revision: "1" }, row(-1), { revision: 1, payload: "[]" }, { revision: 1, payload: "{}" }, { revision: 1, payload: "{" }]) {
    assert.equal((await request("/v1/state/initialize", { state })).status, 400);
  }
  assert.equal(pool.queries.length, 0);
  assert.deepEqual((await request("/v1/state/initialize", { state: row(1) })).body, { inserted: true });
  assert.deepEqual((await request("/v1/state/initialize", { state: row(5) })).body, { inserted: false });
  for (const expectedRevision of [-1, "1", 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal((await request("/v1/state/save", { expectedRevision, state: row(2) })).status, 400);
  for (const revision of [1, 3])
    assert.equal((await request("/v1/state/save", { expectedRevision: 1, state: row(revision) })).status, 400);
  const results = await Promise.all(["甲", "乙"].map((name) =>
    request("/v1/state/save", { expectedRevision: 1, state: row(2, name) })));
  assert.ok(results.every(({ status }) => status === 200));
  assert.deepEqual(results.map(({ body }) => body.saved).sort(), [false, true]);
  const saved = await request("/v1/state/read");
  assert.equal(saved.body.row.revision, 2);
});

test("state storage limit counts UTF-8 bytes and accepts exactly 1,900,000 bytes", async (t) => {
  const { request, pool } = await http(t);
  const empty = JSON.stringify({ revision: 1, padding: "" });
  const exact = { revision: 1, payload: JSON.stringify({ revision: 1, padding: "x".repeat(1_900_000 - Buffer.byteLength(empty)) }) };
  assert.equal(Buffer.byteLength(exact.payload), 1_900_000);
  assert.equal((await request("/v1/state/initialize", { state: exact })).status, 200);
  const before = pool.queries.length;
  const oversized = { revision: 2, payload: JSON.stringify({ revision: 2, padding: "汉".repeat(640_000) }) };
  assert.ok(oversized.payload.length < 1_900_000);
  for (const [path, body] of [
    ["/v1/state/initialize", { state: oversized }],
    ["/v1/state/save", { expectedRevision: 1, state: oversized }],
  ]) {
    const response = await request(path, body);
    assert.equal(response.status, 413);
    assert.equal(response.body.error, "DEMO_STORAGE_LIMIT");
  }
  assert.equal(pool.queries.length, before);
  assert.deepEqual(pool.state, exact);
});

test("session routes use only hashes, persist without Redis and prune by expiration", async (t) => {
  const { pool, redis, request } = await http(t);
  const tokenHash = "a".repeat(64), secondHash = "b".repeat(64);
  const userId = "hr'; DROP TABLE sessions; --";
  assert.equal((await request("/v1/sessions/create", { tokenHash: "plaintext", userId, expiresAt: 100 })).status, 400);
  assert.equal((await request("/v1/sessions/create", { tokenHash, userId: "", expiresAt: 100 })).status, 400);
  assert.equal((await request("/v1/sessions/create", { tokenHash, userId, expiresAt: -1 })).status, 400);
  assert.deepEqual((await request("/v1/sessions/create", { tokenHash, userId, expiresAt: 100 })).body, { created: true });
  assert.deepEqual((await request("/v1/sessions/find", { tokenHash })).body, { session: { user_id: userId, expires_at: 100 } });
  assert.equal(pool.queries.some(({ sql }) => sql.includes(userId)), false);
  assert.deepEqual((await request("/v1/sessions/create", { tokenHash: secondHash, userId: "manager", expiresAt: 200 })).body, { created: true });
  assert.deepEqual((await request("/v1/sessions/prune", { expiresAt: 100 })).body, { deletedCount: 1 });
  assert.deepEqual((await request("/v1/sessions/find", { tokenHash })).body, { session: null });
  assert.deepEqual((await request("/v1/sessions/delete", { tokenHash: secondHash })).body, { deleted: true });
  assert.deepEqual((await request("/v1/sessions/find", { tokenHash: secondHash })).body, { session: null });
  assert.equal(redis.entries.size, 0);
});

test("HTTP rejects streamed bodies over 6 MiB and hides internal errors", async (t) => {
  const { request } = await http(t, { store: {
    readState() { throw new Error("mysql://secret@internal-host/database"); },
  } });
  const oversized = await request("/v1/state/read", {}, { body: "x".repeat(6 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  const failure = await request("/v1/state/read");
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: "STORAGE_UNAVAILABLE", message: "Storage is temporarily unavailable" });
  assert.ok(!JSON.stringify(failure.body).includes("secret"));
});
