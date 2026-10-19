const CACHE_TTL_SECONDS = 60;
const CACHE_TIMEOUT_MS = 200;

function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid stored integer");
  return result;
}

function validPayload(payload, revision) {
  if (typeof payload !== "string") return false;
  try {
    const state = JSON.parse(payload);
    return state !== null && typeof state === "object" &&
      !Array.isArray(state) && state.revision === revision;
  } catch {
    return false;
  }
}

export function createStore({ pool, redis = null, cacheNamespace = "talentflow" }) {
  async function cache(operation) {
    if (!redis?.isReady) return null;
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cache timeout")), CACHE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const key = (revision) => `${cacheNamespace}:state:main:${revision}`;
  const remember = (row) => cache(() =>
    redis.set(key(row.revision), row.payload, { EX: CACHE_TTL_SECONDS, NX: true }));

  return {
    async readState() {
      // The current version always comes from the primary database, never Redis.
      const [versions] = await pool.execute(
        "SELECT revision FROM recruitment_state WHERE id = ?", ["main"],
      );
      if (!versions.length) return null;
      const revision = integer(versions[0].revision);
      const cached = await cache(() => redis.get(key(revision)));
      if (validPayload(cached, revision)) return { revision, payload: cached };
      const [rows] = await pool.execute(
        "SELECT revision, CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload FROM recruitment_state WHERE id = ?",
        ["main"],
      );
      if (!rows.length) return null;
      // A writer may have committed since the revision-only query.
      const row = { revision: integer(rows[0].revision), payload: rows[0].payload };
      if (!validPayload(row.payload, row.revision))
        throw new Error("Invalid stored state");
      await remember(row);
      return row;
    },
    async initializeState(state) {
      const [result] = await pool.execute(
        "INSERT IGNORE INTO recruitment_state (id, revision, payload) VALUES (?, ?, ?)",
        ["main", state.revision, state.payload],
      );
      const inserted = result.affectedRows === 1;
      if (inserted) await remember(state);
      return inserted;
    },
    async saveState(expectedRevision, state) {
      const [result] = await pool.execute(
        "UPDATE recruitment_state SET revision = ?, payload = ? WHERE id = ? AND revision = ?",
        [state.revision, state.payload, "main", expectedRevision],
      );
      const saved = result.affectedRows === 1;
      // Cache failures cannot turn a committed write into an apparent failure.
      if (saved) await remember(state);
      return saved;
    },
    async findSession(tokenHash) {
      const [rows] = await pool.execute(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", [tokenHash],
      );
      return rows.length
        ? { user_id: rows[0].user_id, expires_at: integer(rows[0].expires_at) }
        : null;
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      await pool.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        [tokenHash, userId, expiresAt],
      );
    },
    async deleteSession(tokenHash) {
      await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    },
    async pruneSessions(expiresAt) {
      const [result] = await pool.execute(
        "DELETE FROM sessions WHERE expires_at <= ?", [expiresAt],
      );
      return result.affectedRows;
    },
  };
}
