import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { createClient } from "redis";
import { createStorageServer } from "../server.mjs";
import { createStore } from "../store.mjs";

test("real MySQL and Redis storage contract", {
  skip: process.env.MYSQL_INTEGRATION !== "1",
}, async (t) => {
  const database = process.env.MYSQL_DATABASE || "talentflow_test";
  const host = process.env.MYSQL_HOST || "127.0.0.1";
  assert.equal(database, "talentflow_test", "Integration tests only clean the fixed talentflow_test database");
  assert.ok(["127.0.0.1", "localhost"].includes(host), "Integration tests only connect to local MySQL");
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:16379";
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(redisUrl).hostname), "Integration tests only connect to local Redis");
  const config = {
    host, port: Number(process.env.MYSQL_PORT || 13306), database,
    user: process.env.MYSQL_USER || "talentflow",
    password: process.env.MYSQL_PASSWORD,
    connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: true,
    charset: "utf8mb4",
  };
  const pool = mysql.createPool(config);
  const redis = createClient({
    url: redisUrl, disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: false },
  });
  redis.on("error", () => {});
  const namespace = `talentflow-integration:${randomUUID()}`;
  let redisConnected = false;
  t.after(async () => {
    try {
      await pool.execute("DELETE FROM recruitment_state");
      await pool.execute("DELETE FROM sessions");
      if (redisConnected && redis.isReady)
        await redis.del([1, 2, 3, 4, 5, 6].map((revision) => `${namespace}:state:main:${revision}`));
    } finally {
      if (redis.isOpen) redis.destroy();
      await pool.end();
    }
  });
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";").filter((value) => value.trim()))
    await pool.query(statement);
  await pool.execute("DELETE FROM recruitment_state");
  await pool.execute("DELETE FROM sessions");
  await redis.connect();
  redisConnected = true;
  const store = createStore({ pool, redis, cacheNamespace: namespace });
  const row = (revision, name) => ({
    revision, payload: JSON.stringify({
      revision, candidates: [{ id: "integration_candidate", name }],
      policy: {
        minimumEducation: "bachelor", requiredSkills: ["TypeScript", "SQL"],
        graduationYears: [2027], updatedAt: "2026-10-19T00:00:00.000Z",
      },
    }),
  });
  const equalRow = (actual, expected) => {
    assert.equal(actual.revision, expected.revision);
    assert.deepEqual(JSON.parse(actual.payload), JSON.parse(expected.payload));
  };

  await t.test("parallel initialization and compare-and-swap commit once", async () => {
    assert.equal(await store.readState(), null);
    const initial = await Promise.all([
      store.initializeState(row(1, "初始甲")), store.initializeState(row(1, "初始乙")),
    ]);
    assert.deepEqual(initial.sort(), [false, true]);
    const [counts] = await pool.execute("SELECT COUNT(*) AS total FROM recruitment_state");
    assert.equal(Number(counts[0].total), 1);
    const states = [row(2, "候选人甲"), row(2, "候选人乙")];
    const saved = await Promise.all(states.map((state) => store.saveState(1, state)));
    assert.deepEqual([...saved].sort(), [false, true]);
    equalRow(await store.readState(), states[saved.indexOf(true)]);
    assert.equal(await store.saveState(2, row(3, "刷新后提交")), true);
  });

  await t.test("a new connection and new service can read persisted state", async () => {
    const freshPool = mysql.createPool(config);
    const freshStore = createStore({ pool: freshPool });
    const server = createStorageServer({ store: freshStore, token: "integration-only-token-minimum-32-characters" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/state/read`, {
        method: "POST", headers: { authorization: "Bearer integration-only-token-minimum-32-characters", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      equalRow((await response.json()).row, row(3, "刷新后提交"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await freshPool.end();
    }
  });

  await t.test("payload text and nested object key order survive cache eviction and a new connection byte for byte", async () => {
    const expected = row(3, "刷新后提交");
    assert.equal((await store.readState()).payload, expected.payload);
    await redis.del(`${namespace}:state:main:3`);
    assert.equal((await store.readState()).payload, expected.payload);
    const freshPool = mysql.createPool(config);
    try {
      const freshStore = createStore({ pool: freshPool });
      assert.equal((await freshStore.readState()).payload, expected.payload);
    } finally {
      await freshPool.end();
    }
  });

  await t.test("cached reads fetch only the database version and direct SQL changes invalidate by revision", async () => {
    equalRow(await store.readState(), row(3, "刷新后提交"));
    const ttl = await redis.ttl(`${namespace}:state:main:3`);
    assert.ok(ttl > 0 && ttl <= 60);
    const queries = [];
    const instrumented = createStore({
      redis, cacheNamespace: namespace,
      pool: { execute(sql, values) { queries.push(sql); return pool.execute(sql, values); } },
    });
    equalRow(await instrumented.readState(), row(3, "刷新后提交"));
    assert.equal(queries.length, 1);
    assert.ok(!queries[0].includes("payload"));
    const external = row(4, "其他实例已修改");
    await pool.execute("UPDATE recruitment_state SET revision = ?, payload = ? WHERE id = ?", [4, external.payload, "main"]);
    equalRow(await instrumented.readState(), external);
    equalRow(await store.readState(), external);
    assert.ok(await redis.get(`${namespace}:state:main:3`));
    assert.ok(await redis.get(`${namespace}:state:main:4`));
  });

  await t.test("Redis errors and timeouts preserve database reads and committed writes", async () => {
    const failing = createStore({
      pool, cacheNamespace: namespace,
      redis: { isReady: true, get: async () => { throw new Error("offline"); }, set: async () => { throw new Error("offline"); } },
    });
    equalRow(await failing.readState(), row(4, "其他实例已修改"));
    assert.equal(await failing.saveState(4, row(5, "Redis断开仍持久化")), true);
    equalRow(await store.readState(), row(5, "Redis断开仍持久化"));
    const stalled = createStore({
      pool, redis: { isReady: true, get: () => new Promise(() => {}), set: async () => "OK" },
    });
    const started = Date.now();
    equalRow(await stalled.readState(), row(5, "Redis断开仍持久化"));
    assert.ok(Date.now() - started < 1500);
  });

  await t.test("sessions persist, delete and prune without Redis", async () => {
    const first = "a".repeat(64), second = "b".repeat(64);
    await store.createSession({ tokenHash: first, userId: "hr", expiresAt: 100 });
    await store.createSession({ tokenHash: second, userId: "manager", expiresAt: 200 });
    assert.deepEqual(await store.findSession(first), { user_id: "hr", expires_at: 100 });
    assert.equal(await store.pruneSessions(100), 1);
    assert.equal(await store.findSession(first), null);
    assert.deepEqual(await store.findSession(second), { user_id: "manager", expires_at: 200 });
    await store.deleteSession(second);
    assert.equal(await store.findSession(second), null);
  });

  await t.test("HTTP authentication and storage response contracts use the real database", async () => {
    const token = "integration-only-token-minimum-32-characters";
    const server = createStorageServer({ store, token });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, body, authorization = `Bearer ${token}`) => {
      const response = await fetch(endpoint + path, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    try {
      assert.equal((await request("/v1/state/read", {}, "Bearer incorrect")).status, 401);
      assert.deepEqual(await request("/v1/state/save", { expectedRevision: 4, state: row(5, "不能覆盖") }), { status: 200, data: { saved: false } });
      assert.deepEqual(await request("/v1/state/save", { expectedRevision: 5, state: row(6, "HTTP已持久化") }), { status: 200, data: { saved: true } });
      equalRow((await request("/v1/state/read", {})).data.row, row(6, "HTTP已持久化"));
      assert.equal((await request("/v1/state/save", { expectedRevision: 6, state: row(8, "跳版本") })).status, 400);
      assert.equal((await request("/v1/sql", { sql: "SELECT 1" })).status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
