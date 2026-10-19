import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import { createClient } from "redis";
import { createStore } from "./store.mjs";

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_STATE_BYTES = 1_900_000;
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const badInput = () => {
  throw new HttpError(400, "INVALID_INPUT", "Invalid request input");
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isInteger = (value) => Number.isSafeInteger(value) && value >= 0;
function keys(value, expected) {
  if (!isObject(value) || Object.keys(value).length !== expected.length ||
      expected.some((name) => !Object.hasOwn(value, name))) badInput();
}
function stateInput(value) {
  keys(value, ["revision", "payload"]);
  if (!isInteger(value.revision) || typeof value.payload !== "string") badInput();
  if (Buffer.byteLength(value.payload, "utf8") > MAX_STATE_BYTES)
    throw new HttpError(413, "DEMO_STORAGE_LIMIT", "State exceeds storage limit");
  let payload;
  try { payload = JSON.parse(value.payload); } catch { badInput(); }
  if (!isObject(payload) || payload.revision !== value.revision) badInput();
}
function checkToken(token) {
  if (typeof token !== "string" || !/^[!-~]{32,}$/.test(token))
    throw new Error("STORAGE_API_TOKEN must contain at least 32 printable ASCII characters without spaces");
}
function sessionHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) badInput();
}
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpError(413, "REQUEST_TOO_LARGE", "Request exceeds 6 MiB");
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isObject(body)) badInput();
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    badInput();
  }
}

export function createStorageServer({ store, token }) {
  checkToken(token);
  const tokenDigest = createHash("sha256").update(`Bearer ${token}`).digest();
  const routes = {
    "/v1/state/read": async (body) => {
      keys(body, []);
      return { row: await store.readState() };
    },
    "/v1/state/initialize": async (body) => {
      keys(body, ["state"]);
      stateInput(body.state);
      return { inserted: await store.initializeState(body.state) };
    },
    "/v1/state/save": async (body) => {
      keys(body, ["expectedRevision", "state"]);
      stateInput(body.state);
      if (!isInteger(body.expectedRevision) ||
          body.state.revision !== body.expectedRevision + 1) badInput();
      return { saved: await store.saveState(body.expectedRevision, body.state) };
    },
    "/v1/sessions/find": async (body) => {
      keys(body, ["tokenHash"]);
      sessionHash(body.tokenHash);
      return { session: await store.findSession(body.tokenHash) };
    },
    "/v1/sessions/create": async (body) => {
      keys(body, ["tokenHash", "userId", "expiresAt"]);
      sessionHash(body.tokenHash);
      if (typeof body.userId !== "string" || !body.userId.trim() ||
          body.userId.length > 128 || !isInteger(body.expiresAt)) badInput();
      await store.createSession(body);
      return { created: true };
    },
    "/v1/sessions/delete": async (body) => {
      keys(body, ["tokenHash"]);
      sessionHash(body.tokenHash);
      await store.deleteSession(body.tokenHash);
      return { deleted: true };
    },
    "/v1/sessions/prune": async (body) => {
      keys(body, ["expiresAt"]);
      if (!isInteger(body.expiresAt)) badInput();
      return { deletedCount: await store.pruneSessions(body.expiresAt) };
    },
  };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    try {
      const supplied = createHash("sha256").update(request.headers.authorization || "").digest();
      if (!timingSafeEqual(tokenDigest, supplied))
        throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
      if (request.method !== "POST")
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
      const handler = Object.hasOwn(routes, request.url) ? routes[request.url] : null;
      if (!handler) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint");
      response.end(JSON.stringify(await handler(await readJson(request))));
    } catch (error) {
      const known = error instanceof HttpError;
      response.statusCode = known ? error.status : 503;
      response.setHeader("connection", "close");
      response.end(JSON.stringify({
        error: known ? error.code : "STORAGE_UNAVAILABLE",
        message: known ? error.message : "Storage is temporarily unavailable",
      }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function startStorageServer(environment = process.env) {
  checkToken(environment.STORAGE_API_TOKEN);
  const pool = mysql.createPool({
    host: environment.MYSQL_HOST || "127.0.0.1",
    port: Number(environment.MYSQL_PORT || 3306),
    database: environment.MYSQL_DATABASE || "talentflow",
    user: environment.MYSQL_USER || "talentflow",
    password: environment.MYSQL_PASSWORD,
    connectionLimit: 10,
    waitForConnections: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: "utf8mb4",
  });
  let redis = null;
  if (environment.REDIS_URL) {
    redis = createClient({
      url: environment.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 100,
      socket: {
        connectTimeout: 200,
        reconnectStrategy: (retries) => Math.min(100 * (retries + 1), 1000),
      },
    });
    redis.on("error", () => {});
    void redis.connect().catch(() => {});
  }
  const store = createStore({
    pool, redis,
    cacheNamespace: `talentflow:${environment.MYSQL_HOST || "127.0.0.1"}:${environment.MYSQL_PORT || 3306}:${environment.MYSQL_DATABASE || "talentflow"}`,
  });
  const server = createStorageServer({ store, token: environment.STORAGE_API_TOKEN });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(environment.PORT || 8788), "0.0.0.0", resolve);
  });
  return { server, store, pool, redis };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStorageServer().then(({ server, pool, redis }) => {
    console.info("Storage service listening");
    const stop = async () => {
      await new Promise((resolve) => server.close(resolve));
      redis?.destroy();
      await pool.end();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }).catch(() => {
    console.error("Storage service could not start");
    process.exitCode = 1;
  });
}
