import { BusinessError } from "./engine.ts";

type StorageEnv = { MYSQL_STORAGE_URL?: string; MYSQL_STORAGE_TOKEN?: string };
type StoredState = { revision: number; payload: string };
type StoredSession = { user_id: string; expires_at: number };
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const PAYLOAD_LIMIT = 1900000;
const unavailable = () => new BusinessError(
  "DATABASE_UNAVAILABLE",
  "数据库服务暂时不可用，请检查 MySQL 存储服务连接",
  503,
);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const stateRow = (value: unknown): value is StoredState =>
  object(value) && integer(value.revision) && typeof value.payload === "string" &&
  new TextEncoder().encode(value.payload).length <= PAYLOAD_LIMIT;
const sessionRow = (value: unknown): value is StoredSession =>
  object(value) && typeof value.user_id === "string" && value.user_id.length > 0 &&
  integer(value.expires_at);

export function createMySqlStorage(
  env: StorageEnv,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
) {
  let origin: string;
  try {
    if (typeof env.MYSQL_STORAGE_URL !== "string" ||
      typeof env.MYSQL_STORAGE_TOKEN !== "string" ||
      !/^[\x21-\x7e]{32,}$/.test(env.MYSQL_STORAGE_TOKEN)) throw new Error();
    const url = new URL(env.MYSQL_STORAGE_URL);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || /[?#]/.test(env.MYSQL_STORAGE_URL) ||
      url.pathname !== "/") throw new Error();
    origin = url.origin;
  } catch {
    throw unavailable();
  }
  const token = env.MYSQL_STORAGE_TOKEN;
  async function post(path: string, input: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(unavailable());
      }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetcher(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(input),
          // Workers supports manual redirects; a non-2xx response is rejected below.
          redirect: "manual",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected ||
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw unavailable();
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) throw unavailable();
        if (!response.body) throw unavailable();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const chunks: string[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw unavailable();
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        const result: unknown = JSON.parse(chunks.join(""));
        if (!object(result)) throw unavailable();
        return result;
      })()]);
    } catch {
      controller.abort();
      void reader?.cancel().catch(() => {});
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async readState(): Promise<StoredState | null> {
      const result = await post("/v1/state/read", {});
      if (result.row !== null && !stateRow(result.row)) throw unavailable();
      return result.row;
    },
    async initializeState(state: StoredState): Promise<boolean> {
      const result = await post("/v1/state/initialize", { state });
      if (typeof result.inserted !== "boolean") throw unavailable();
      return result.inserted;
    },
    async saveState(expectedRevision: number, state: StoredState): Promise<boolean> {
      const result = await post("/v1/state/save", { expectedRevision, state });
      if (typeof result.saved !== "boolean") throw unavailable();
      return result.saved;
    },
    async findSession(tokenHash: string): Promise<StoredSession | null> {
      const result = await post("/v1/sessions/find", { tokenHash });
      if (result.session !== null && !sessionRow(result.session)) throw unavailable();
      return result.session;
    },
    async createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
      const result = await post("/v1/sessions/create", { tokenHash, userId, expiresAt });
      if (result.created !== true) throw unavailable();
    },
    async deleteSession(tokenHash: string): Promise<void> {
      const result = await post("/v1/sessions/delete", { tokenHash });
      if (result.deleted !== true) throw unavailable();
    },
    async pruneSessions(expiresAt: number): Promise<void> {
      const result = await post("/v1/sessions/prune", { expiresAt });
      if (!integer(result.deletedCount)) throw unavailable();
    },
  };
}
