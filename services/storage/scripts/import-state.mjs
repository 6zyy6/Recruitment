import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

const COLLECTIONS = [
  "users", "jobs", "candidates", "applications", "interviews",
  "scorecards", "events", "imports",
];
const MAX_STATE_BYTES = 1900000;

export class StateImportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireValue(condition) {
  if (!condition) throw new StateImportError("INVALID_STATE");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") return requireValue(Number.isFinite(value));
  requireValue(Array.isArray(value) || object(value));
  for (const item of Object.values(value)) jsonValue(item);
}

// Validate references without rebuilding the state: optional and future fields survive.
export function validateState(state) {
  requireValue(object(state));
  jsonValue(state);
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES)
    throw new StateImportError("STATE_TOO_LARGE");
  requireValue(Number.isSafeInteger(state.revision) && state.revision >= 0);
  requireValue(text(state.seededAt) && Number.isFinite(Date.parse(state.seededAt)));
  const indexes = {};
  for (const key of [...COLLECTIONS, ...(state.reviews === undefined ? [] : ["reviews"])]) {
    requireValue(Array.isArray(state[key]));
    const index = new Map();
    for (const item of state[key]) {
      requireValue(object(item) && text(item.id) && !index.has(item.id));
      index.set(item.id, item);
    }
    indexes[key] = index;
  }
  const reference = (collection, id) => requireValue(text(id) && indexes[collection].has(id));
  const candidate = (item) => {
    requireValue(object(item) && item.restricted !== true);
    for (const key of ["name", "email", "phone", "school", "major", "resume", "availability", "createdAt"])
      requireValue(typeof item[key] === "string");
    requireValue(Array.isArray(item.skills) && item.skills.every((skill) => typeof skill === "string"));
    requireValue(item.graduationYear === null || Number.isSafeInteger(item.graduationYear));
  };
  for (const item of state.candidates) candidate(item);
  for (const item of state.users)
    requireValue(["hr", "manager", "interviewer", "admin"].includes(item.role));
  for (const item of state.jobs) {
    reference("users", item.ownerId);
    reference("users", item.managerId);
  }
  for (const item of state.applications) {
    reference("candidates", item.candidateId);
    reference("jobs", item.jobId);
    reference("users", item.ownerId);
    requireValue(Number.isSafeInteger(item.version) && item.version >= 0);
    requireValue(["new", "screening", "interview", "offer", "onboarding", "joined"].includes(item.stage));
    requireValue(["active", "closed", "joined"].includes(item.status));
    candidate(item.snapshot);
    requireValue(item.snapshot.id === item.candidateId);
  }
  for (const item of state.interviews) {
    reference("applications", item.applicationId);
    requireValue(Array.isArray(item.interviewerIds));
    item.interviewerIds.forEach((id) => reference("users", id));
  }
  for (const item of state.scorecards) {
    reference("interviews", item.interviewId);
    reference("users", item.userId);
  }
  for (const item of state.events) {
    reference("applications", item.applicationId);
    reference("users", item.actorId);
  }
  for (const item of state.imports) {
    reference("jobs", item.jobId);
    requireValue(Array.isArray(item.rows));
    for (const row of item.rows) {
      requireValue(object(row) && typeof row.candidateId === "string" && typeof row.applicationId === "string");
      if (row.candidateId) reference("candidates", row.candidateId);
      if (row.applicationId) {
        reference("applications", row.applicationId);
        requireValue(indexes.applications.get(row.applicationId).candidateId === row.candidateId);
      }
    }
  }
  for (const item of state.reviews || []) {
    reference("candidates", item.candidateId);
    reference("applications", item.applicationId);
    reference("users", item.createdBy);
    requireValue(indexes.applications.get(item.applicationId).candidateId === item.candidateId);
  }
  return state;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function stateDigest(state) {
  return createHash("sha256").update(JSON.stringify(canonical(state))).digest("hex");
}

function storedState(row) {
  try {
    const value = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    requireValue(object(value));
    requireValue(String(row.revision) === String(value.revision));
    return value;
  } catch {
    throw new StateImportError("STORED_STATE_INVALID");
  }
}

export async function importState(connection, state) {
  validateState(state);
  const sha256 = stateDigest(state);
  await connection.beginTransaction();
  try {
    try {
      // The primary key arbitrates racing imports; there is deliberately no UPDATE.
      await connection.execute(
        "INSERT INTO recruitment_state (id, revision, payload) VALUES (?, ?, ?)",
        ["main", state.revision, JSON.stringify(state)],
      );
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") throw error;
    }
    const [rows] = await connection.execute(
      "SELECT revision, payload FROM recruitment_state WHERE id = ? FOR UPDATE",
      ["main"],
    );
    if (rows.length !== 1 || stateDigest(storedState(rows[0])) !== sha256)
      throw new StateImportError("STATE_CONFLICT_OR_VERIFICATION_FAILED");
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
  return {
    revision: state.revision,
    counts: Object.fromEntries([...COLLECTIONS, ...(state.reviews === undefined ? [] : ["reviews"])]
      .map((key) => [key, state[key].length])),
    sha256,
  };
}

async function main() {
  let connection;
  try {
    let input = "";
    let inputBytes = 0;
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      inputBytes += Buffer.byteLength(chunk);
      if (inputBytes > MAX_STATE_BYTES) throw new StateImportError("STATE_TOO_LARGE");
      input += chunk;
    }
    let state;
    try { state = JSON.parse(input); }
    catch { throw new StateImportError("INVALID_JSON"); }
    validateState(state);
    const port = Number(process.env.MYSQL_PORT || "3306");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new StateImportError("INVALID_MYSQL_CONFIG");
    for (const key of ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"])
      if (!text(process.env[key])) throw new StateImportError("INVALID_MYSQL_CONFIG");
    connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      charset: "utf8mb4",
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    process.stdout.write(`${JSON.stringify(await importState(connection, state))}\n`);
  } catch (error) {
    // Database errors can include SQL, payloads or connection credentials.
    process.stderr.write(`${JSON.stringify({ error: error instanceof StateImportError ? error.code : "MYSQL_IMPORT_FAILED" })}\n`);
    process.exitCode = 1;
  } finally {
    if (connection) {
      try { await connection.end(); }
      catch {
        process.stderr.write('{"error":"MYSQL_DISCONNECT_FAILED"}\n');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
