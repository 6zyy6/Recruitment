import { GmailError } from "./gmail.ts";

const LIMIT = 2 * 1024;
export async function readGmailRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new GmailError("MAIL_REQUEST", "邮箱操作请求必须为 JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = request.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > LIMIT) {
      await reader.cancel();
      throw new GmailError("MAIL_REQUEST", "邮箱操作请求不得超过 2 KiB", 413);
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new GmailError("MAIL_REQUEST", "邮箱操作请求不得超过 2 KiB", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailError("MAIL_REQUEST", "邮箱操作请求必须为有效 UTF-8 JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new GmailError("MAIL_REQUEST", "邮箱操作请求必须为 JSON 对象");
  return input as Record<string, unknown>;
}
