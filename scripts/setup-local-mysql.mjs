import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const envPath = new URL(".env.mysql", root);
const varsPath = new URL(".dev.vars", root);
if (!existsSync(envPath)) {
  const secret = () => randomBytes(32).toString("hex");
  writeFileSync(envPath, [
    "MYSQL_HOST=127.0.0.1", "MYSQL_PORT=13306", "MYSQL_DATABASE=talentflow",
    "MYSQL_USER=talentflow", `MYSQL_PASSWORD=${secret()}`,
    `MYSQL_ROOT_PASSWORD=${secret()}`, "REDIS_URL=redis://127.0.0.1:16379",
    `STORAGE_API_TOKEN=${secret()}`, "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
}
const token = readFileSync(envPath, "utf8").match(/^STORAGE_API_TOKEN=([a-f0-9]{64})$/m)?.[1];
if (!token) throw new Error("Existing .env.mysql is missing STORAGE_API_TOKEN; no files were overwritten.");
if (!existsSync(varsPath)) {
  writeFileSync(varsPath, `MYSQL_STORAGE_URL=http://127.0.0.1:8788\nMYSQL_STORAGE_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
} else {
  const current = readFileSync(varsPath, "utf8");
  if (!current.includes("MYSQL_STORAGE_URL=") || !current.includes("MYSQL_STORAGE_TOKEN="))
    throw new Error("Existing .dev.vars was preserved. Add MYSQL_STORAGE_URL and MYSQL_STORAGE_TOKEN from .env.mysql.");
}
console.log(`Local configuration ready in ${fileURLToPath(root)} (.env.mysql and .dev.vars; secrets hidden).`);
