import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../lib/seed.ts";
import {
  importState,
  stateDigest,
  validateState,
} from "../services/storage/scripts/import-state.mjs";

const seed = () => JSON.parse(JSON.stringify(createSeed(new Date("2026-10-19T02:00:00.000Z"))));

function database(initial?: ReturnType<typeof seed>) {
  let row = initial ? { revision: String(initial.revision), payload: structuredClone(initial) } : undefined;
  let previous: typeof row;
  const connection = {
    committed: false,
    rolledBack: false,
    corruptRead: false,
    async beginTransaction() { previous = structuredClone(row); },
    async execute(sql: string, values: unknown[]) {
      if (sql.startsWith("INSERT")) {
        if (row) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        row = { revision: String(values[1]), payload: JSON.parse(String(values[2])) };
        return [{ affectedRows: 1 }, []];
      }
      assert.ok(sql.endsWith("FOR UPDATE"));
      const read = structuredClone(row);
      if (this.corruptRead && read) read.payload.revision++;
      return [[read].filter(Boolean), []];
    },
    async commit() { this.committed = true; },
    async rollback() { row = previous; this.rolledBack = true; },
  };
  return { connection, read: () => structuredClone(row) };
}

test("import preserves all collections, private reviews and future JSON fields", async () => {
  const state = seed();
  const app = state.applications[0];
  state.reviews = [{ id: "review_1", candidateId: app.candidateId, applicationId: app.id, createdBy: "hr", tokenHash: "private-hash" }];
  state.futureCollection = [{ id: "future_1", nested: { z: 1, a: "保留" } }];
  const db = database();
  const result = await importState(db.connection, state);
  assert.deepEqual(db.read()?.payload, state);
  assert.equal(result.counts.candidates, 36);
  assert.equal(result.counts.applications, 42);
  assert.equal(result.counts.reviews, 1);
  assert.equal(result.sha256, stateDigest(state));
  assert.equal(db.connection.committed, true);
  assert.ok(!JSON.stringify(result).includes("private-hash"));
});

test("duplicate JSON with different object key order imports idempotently", async () => {
  const state = seed();
  const reordered = Object.fromEntries(Object.entries(state).reverse());
  const db = database(state);
  const result = await importState(db.connection, reordered);
  assert.equal(result.sha256, stateDigest(state));
  assert.deepEqual(db.read()?.payload, state);
  assert.equal(db.connection.committed, true);
});

test("existing different state is never overwritten even at the same revision", async () => {
  const before = seed();
  const db = database(before);
  const next = seed();
  next.candidates[0].name = "另一名合成候选人";
  await assert.rejects(importState(db.connection, next), { code: "STATE_CONFLICT_OR_VERIFICATION_FAILED" });
  assert.deepEqual(db.read()?.payload, before);
  assert.equal(db.connection.rolledBack, true);
});

test("failed readback rolls back an inserted state", async () => {
  const db = database();
  db.connection.corruptRead = true;
  await assert.rejects(importState(db.connection, seed()), { code: "STORED_STATE_INVALID" });
  assert.equal(db.read(), undefined);
  assert.equal(db.connection.committed, false);
  assert.equal(db.connection.rolledBack, true);
});

test("unsafe revisions, missing collections and restricted projections are rejected before a transaction", async () => {
  for (const mutate of [
    (state: ReturnType<typeof seed>) => { state.revision = Number.MAX_SAFE_INTEGER + 1; },
    (state: ReturnType<typeof seed>) => { state.revision = -1; },
    (state: ReturnType<typeof seed>) => { delete state.events; },
    (state: ReturnType<typeof seed>) => { state.candidates[0].restricted = true; },
  ]) {
    const state = seed();
    mutate(state);
    let started = false;
    await assert.rejects(importState({ beginTransaction() { started = true; } }, state), { code: "INVALID_STATE" });
    assert.equal(started, false);
  }
});

test("oversized states cannot bypass the Worker payload limit during import", async () => {
  const state = seed();
  state.candidates[0].resume = "a".repeat(1900000);
  let started = false;
  await assert.rejects(importState({ beginTransaction() { started = true; } }, state), { code: "STATE_TOO_LARGE" });
  assert.equal(started, false);
});

test("duplicate IDs and orphan or inconsistent references are rejected", () => {
  for (const mutate of [
    (state: ReturnType<typeof seed>) => { state.candidates.push(structuredClone(state.candidates[0])); },
    (state: ReturnType<typeof seed>) => { state.applications.push(structuredClone(state.applications[0])); },
    (state: ReturnType<typeof seed>) => { state.applications[0].candidateId = "missing"; },
    (state: ReturnType<typeof seed>) => { state.applications[0].jobId = "missing"; },
    (state: ReturnType<typeof seed>) => { state.applications[0].snapshot.id = state.candidates[1].id; },
    (state: ReturnType<typeof seed>) => { state.scorecards[0].interviewId = "missing"; },
    (state: ReturnType<typeof seed>) => { state.reviews = [{ id: "r", candidateId: state.candidates[1].id, applicationId: state.applications[0].id, createdBy: "hr" }]; },
  ]) {
    const state = seed();
    mutate(state);
    assert.throws(() => validateState(state), { code: "INVALID_STATE" });
  }
});
