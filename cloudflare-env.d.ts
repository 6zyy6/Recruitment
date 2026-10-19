declare namespace Cloudflare {
  interface Env {
    // Retained for legacy D1 export/migration tools; recruitment data and sessions use MySQL.
    DB?: D1Database;
    MYSQL_STORAGE_URL?: string;
    MYSQL_STORAGE_TOKEN?: string;
    BUCKET?: R2Bucket;
  }
}
