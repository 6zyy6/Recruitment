import { test } from "node:test";
import assert from "node:assert/strict";
import { OperatorError, requireMailOperator, requireRecruitmentOperator } from "../lib/operator.ts";

const allowedEmail = "owner@example.com";
const config = { MAIL_OPERATOR_EMAIL: allowedEmail };
function request(headers: HeadersInit = {}, url = "https://demo.example/mail-connect") {
  return new Request(url, { headers });
}
function signedIn(email = allowedEmail, userId = "operator-1") {
  return request({ "oai-authenticated-user-id": userId, "oai-authenticated-user-email": email });
}
function rejects(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof OperatorError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(allowedEmail));
    assert.ok(!JSON.stringify(error).includes(allowedEmail));
    return true;
  });
}

test("allowed Sites identity normalizes email case and surrounding whitespace", () => {
  const value = requireMailOperator(signedIn(" OWNER@EXAMPLE.COM ", " operator-1 "), { MAIL_OPERATOR_EMAIL: " Owner@Example.COM " });
  assert.deepEqual(value, { email: allowedEmail, userId: "operator-1" });
});

test("missing or blank operator configuration fails closed before login checks", () => {
  for (const MAIL_OPERATOR_EMAIL of [undefined, "", "   "]) {
    rejects(() => requireMailOperator(signedIn(), { MAIL_OPERATOR_EMAIL }), "MAIL_OPERATOR_NOT_CONFIGURED", 503);
    rejects(() => requireMailOperator(request(), { MAIL_OPERATOR_EMAIL }), "MAIL_OPERATOR_NOT_CONFIGURED", 503);
  }
});

test("both trusted identity headers are required and sign-in return path is fixed", () => {
  const cases: HeadersInit[] = [
    {},
    { "oai-authenticated-user-id": "operator-1" },
    { "oai-authenticated-user-email": allowedEmail },
    { "oai-authenticated-user-id": " ", "oai-authenticated-user-email": allowedEmail },
    { "oai-authenticated-user-id": "operator-1", "oai-authenticated-user-email": " " },
  ];
  for (const headers of cases) {
    assert.throws(() => requireMailOperator(request(headers, "https://demo.example/mail-connect?return_to=https://untrusted.example"), config), (error: unknown) => {
      assert.ok(error instanceof OperatorError);
      assert.equal(error.code, "MAIL_SIGN_IN_REQUIRED");
      assert.equal(error.status, 401);
      assert.equal(error.signInUrl, "/signin-with-chatgpt?return_to=%2Fmail-connect");
      assert.ok(!JSON.stringify(error).includes(allowedEmail));
      return true;
    });
  }
});

test("a different authenticated account is forbidden without disclosing the allowed email", () => {
  rejects(() => requireMailOperator(signedIn("visitor@example.com"), config), "MAIL_FORBIDDEN", 403);
  assert.throws(() => requireMailOperator(signedIn("visitor@example.com"), config), (error: unknown) => {
    assert.ok(error instanceof OperatorError);
    assert.equal(error.signInUrl, undefined);
    return true;
  });
});

test("query claims, demo cookies and alternative identity headers cannot replace Sites identity", () => {
  const forged = request({
    cookie: "recruitment_session=demo-hr-session; userId=operator-1; email=owner@example.com",
    authorization: "Bearer arbitrary-demo-token",
    "x-user-id": "operator-1",
    "x-user-email": allowedEmail,
  }, "https://demo.example/mail-connect?userId=operator-1&email=owner%40example.com");
  rejects(() => requireMailOperator(forged, config), "MAIL_SIGN_IN_REQUIRED", 401);
});

test("request parameters and body cannot override a different trusted account", () => {
  const forged = new Request("https://demo.example/mail-connect?email=owner%40example.com", {
    method: "POST",
    headers: { "oai-authenticated-user-id": "visitor-1", "oai-authenticated-user-email": "visitor@example.com", cookie: "role=hr; email=owner@example.com" },
    body: JSON.stringify({ userId: "operator-1", email: allowedEmail, role: "hr" }),
  });
  rejects(() => requireMailOperator(forged, config), "MAIL_FORBIDDEN", 403);
  assert.equal(forged.bodyUsed, false);
});

test("non-live recruitment retains demo behavior without requiring operator configuration", () => {
  for (const MAIL_MODE of [undefined, "", "preview", "demo"]) {
    assert.equal(requireRecruitmentOperator(request(), { MAIL_MODE }), null);
    assert.equal(requireRecruitmentOperator(signedIn("visitor@example.com"), { MAIL_MODE, MAIL_OPERATOR_EMAIL: allowedEmail }), null);
  }
});

test("live recruitment applies every mail-operator authorization condition", () => {
  const live = { MAIL_MODE: "live", MAIL_OPERATOR_EMAIL: allowedEmail };
  assert.deepEqual(requireRecruitmentOperator(signedIn("OWNER@EXAMPLE.COM"), live), { email: allowedEmail, userId: "operator-1" });
  rejects(() => requireRecruitmentOperator(request(), { MAIL_MODE: "live" }), "MAIL_OPERATOR_NOT_CONFIGURED", 503);
  rejects(() => requireRecruitmentOperator(request(), live), "MAIL_SIGN_IN_REQUIRED", 401);
  rejects(() => requireRecruitmentOperator(signedIn("visitor@example.com"), live), "MAIL_FORBIDDEN", 403);
});

test("a configured AI key requires the designated Sites operator even while mail stays preview", () => {
  const ai = { MAIL_MODE: "preview", MAIL_OPERATOR_EMAIL: allowedEmail, DEEPSEEK_API_KEY: "test-only-key" };
  const publicDemo = request({ cookie: "recruitment_session=public-demo-hr" });
  rejects(() => requireRecruitmentOperator(publicDemo, ai), "MAIL_SIGN_IN_REQUIRED", 401);
  rejects(() => requireRecruitmentOperator(signedIn("visitor@example.com"), ai), "MAIL_FORBIDDEN", 403);
  rejects(() => requireRecruitmentOperator(signedIn(), { DEEPSEEK_API_KEY: "test-only-key" }), "MAIL_OPERATOR_NOT_CONFIGURED", 503);
  assert.deepEqual(requireRecruitmentOperator(signedIn(), ai), { email: allowedEmail, userId: "operator-1" });
  assert.equal(requireRecruitmentOperator(publicDemo, { DEEPSEEK_API_KEY: "   " }), null);
});
