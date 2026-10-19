import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { BusinessError } from "../lib/engine.ts";
import { CandidateReviewError } from "../lib/candidate-review.ts";
import { OperatorError } from "../lib/operator.ts";

// Node runs test files in separate processes. This file supplies no D1 binding
// or mail credentials and replaces Gmail entry points with a fail-fast spy.
const workersModule = `data:text/javascript,${encodeURIComponent('export const env = { MAIL_MODE: "live", MAIL_OPERATOR_EMAIL: "owner@example.com" };')}`;
const gmailModule = `data:text/javascript,${encodeURIComponent(`
  export let calls = 0;
  function unexpected() { calls++; throw new Error("Unexpected Gmail call before authorization"); }
  export { unexpected as gmailStatus, unexpected as sendReviewEmail, unexpected as readReviewEmailDelivery };
`)}`;
const gmailPath = new URL("../lib/gmail-server.ts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(workersModule)}, shortCircuit: true };
    const resolved = await nextResolve(specifier, context);
    if (resolved.url === ${JSON.stringify(gmailPath)}) return { url: ${JSON.stringify(gmailModule)}, shortCircuit: true };
    return resolved;
  }
`)}`, import.meta.url);

const server = await import("../lib/server.ts");
const gmail = await import(gmailModule);
const token = "a".repeat(64);
const cookie = `recruitment_session=${"b".repeat(64)}`;
const loginBody = { userId: "hr", password: "Demo2026!" };
const calls: { name: string; run: (request: Request) => Promise<unknown> }[] = [
  { name: "getUser", run: request => server.getUser(request, true) },
  { name: "recruitmentSnapshot", run: request => server.recruitmentSnapshot(request) },
  { name: "login", run: request => server.login(request, loginBody) },
  { name: "recruitmentAction", run: request => server.recruitmentAction(request, { action: "reset", expectedRevision: 1 }) },
  { name: "createCandidateReview", run: request => server.candidateReviewAction(request, { action: "createCandidateReview", applicationId: "application_1", expectedRevision: 1, sendEmail: true }) },
  { name: "revokeCandidateReview", run: request => server.candidateReviewAction(request, { action: "revokeCandidateReview", applicationId: "application_1", expectedRevision: 1 }) },
];
function request(headers: HeadersInit = {}) {
  return new Request("https://recruitment.example/api/candidate-review", { headers });
}
async function operatorRejects(run: () => Promise<unknown>, code: string, status: number, context?: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof OperatorError, context);
    assert.equal(error.code, code, context);
    assert.equal(error.status, status, context);
    assert.ok(!error.message.includes("owner@example.com"));
    if (status === 401) assert.equal(error.signInUrl, "/signin-with-chatgpt?return_to=%2Fmail-connect");
    return true;
  });
  assert.equal(gmail.calls, 0, "Unauthorized management paths must never call Gmail");
}
async function databaseRejects(run: () => Promise<unknown>) {
  await assert.rejects(run, (error: unknown) => error instanceof BusinessError && error.code === "DATABASE_UNAVAILABLE" && error.status === 503);
  assert.equal(gmail.calls, 0);
}

test("live management APIs require real Sites identity before touching D1 or Gmail", async () => {
  for (const entry of calls) await operatorRejects(() => entry.run(request()), "MAIL_SIGN_IN_REQUIRED", 401, entry.name);
});

test("demo HR cookies and the known front-end password do not authorize live APIs", async () => {
  for (const entry of calls) {
    const forged = new Request("https://recruitment.example/api/candidate-review?userId=hr&email=owner%40example.com", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(loginBody),
    });
    await operatorRejects(() => entry.run(forged), "MAIL_SIGN_IN_REQUIRED", 401, entry.name);
  }
  await operatorRejects(() => server.getUser(request({ cookie })), "MAIL_SIGN_IN_REQUIRED", 401, "optional getUser");
});

test("another authenticated Sites account cannot use any live management API", async () => {
  for (const entry of calls) {
    const foreign = request({ cookie, "oai-authenticated-user-id": "visitor-1", "oai-authenticated-user-email": "visitor@example.com" });
    await operatorRejects(() => entry.run(foreign), "MAIL_FORBIDDEN", 403, entry.name);
  }
});

test("an allowed Sites identity still fails closed without D1 and cannot reach Gmail", async () => {
  for (const entry of calls) {
    const allowed = request({ cookie, "oai-authenticated-user-id": "owner-1", "oai-authenticated-user-email": "OWNER@EXAMPLE.COM" });
    await databaseRejects(() => entry.run(allowed));
  }
});

test("public candidate token reads bypass the live operator guard", async () => {
  await databaseRejects(() => server.candidateReviewSnapshot(new Request(`https://recruitment.example/api/candidate-review?token=${token}`)));
});

test("public candidate token submissions bypass the live operator guard", async () => {
  await databaseRejects(() => server.candidateReviewAction(request(), { token, expectedVersion: 0, confirmed: true, fields: {} }));
});

test("invalid candidate tokens return Gone rather than requesting operator sign-in", async () => {
  for (const run of [
    () => server.candidateReviewSnapshot(new Request("https://recruitment.example/api/candidate-review?token=invalid")),
    () => server.candidateReviewAction(request(), { token: "invalid", confirmed: true }),
  ]) await assert.rejects(run, (error: unknown) => error instanceof CandidateReviewError && error.code === "REVIEW_GONE" && error.status === 410);
  assert.equal(gmail.calls, 0);
});

test("live authorization API errors preserve safe sign-in guidance without exposing the operator email", async () => {
  try {
    await server.recruitmentSnapshot(request({ cookie }));
    assert.fail("Expected an operator authorization error");
  } catch (error) {
    assert.ok(error instanceof OperatorError);
    const response = server.errorResponse(error);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.ok(body !== null && typeof body === "object");
    assert.ok("error" in body && "signInUrl" in body);
    assert.equal(body.error, "MAIL_SIGN_IN_REQUIRED");
    assert.equal(body.signInUrl, "/signin-with-chatgpt?return_to=%2Fmail-connect");
    assert.ok(!JSON.stringify(body).includes("owner@example.com"));
  }
  assert.equal(gmail.calls, 0);
});
