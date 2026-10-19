import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { BusinessError } from "../lib/engine.ts";

// The request helpers do not use D1; supply only the Workers module binding in Node.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = {}", shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { readBody, checkOrigin, errorResponse } = await import("../lib/server.ts");
const URL = "https://recruitment.example/api/recruitment";
const LIMIT = 6 * 1024 * 1024;

test("request bodies must be JSON objects", async () => {
  for (const body of ["", "{", "null", "[]", '"text"', "42"]) {
    await assert.rejects(readBody(new Request(URL, { method: "POST", body })),
      (error: unknown) => error instanceof BusinessError && error.code === "INVALID_JSON" && error.status === 400);
  }
  assert.deepEqual(await readBody(new Request(URL, { method: "POST", body: '{"action":"probe"}' })), { action: "probe" });
});

test("request size counts UTF-8 bytes and accepts the exact limit", async () => {
  const body = JSON.stringify({ text: "x".repeat(LIMIT - 11) });
  assert.equal(new TextEncoder().encode(body).length, LIMIT);
  assert.equal((await readBody(new Request(URL, { method: "POST", body }))).text, "x".repeat(LIMIT - 11));
  const oversized = JSON.stringify({ text: "汉".repeat(LIMIT / 3) });
  await assert.rejects(readBody(new Request(URL, { method: "POST", body: oversized })),
    (error: unknown) => error instanceof BusinessError && error.code === "REQUEST_TOO_LARGE" && error.status === 413);
});

test("oversized streams stop reading immediately instead of buffering the full upload", async () => {
  let chunks = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (chunks === 20) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const request = new Request(URL, { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(readBody(request),
    (error: unknown) => error instanceof BusinessError && error.code === "REQUEST_TOO_LARGE");
  assert.ok(chunks < 20, "Do not consume the remaining oversized upload");
  assert.equal(cancelled, true);
});

test("same-origin writes and non-browser callers pass while foreign origins fail", () => {
  checkOrigin(new Request(URL));
  checkOrigin(new Request(URL, { headers: { origin: "https://recruitment.example" } }));
  for (const origin of ["https://untrusted.example", "null", "http://recruitment.example"]) {
    assert.throws(() => checkOrigin(new Request(URL, { headers: { origin } })),
      (error: unknown) => error instanceof BusinessError && error.code === "INVALID_ORIGIN" && error.status === 403);
  }
});

test("known API failures preserve their status and prohibit caching", async () => {
  const response = errorResponse(new BusinessError("REVISION_CONFLICT", "请刷新", 409));
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "REVISION_CONFLICT", message: "请刷新" });
});
