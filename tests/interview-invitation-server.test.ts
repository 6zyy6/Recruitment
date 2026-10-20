import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { AppState } from "../lib/domain.ts";
import type { MailDelivery, ReviewEmail } from "../lib/gmail.ts";
import { createSeed } from "../lib/seed.ts";
import { hashReviewToken } from "../lib/candidate-review.ts";

const BASE_URL = "https://recruitment.example";
const SESSION_TOKEN = "c".repeat(64);
const REQUEST_ID = "invite_d8e88cc2-ebd6-4303-b4e5-ae9f72919cff";
const SECOND_ID = "invite_975bfb77-f4b9-4309-a6e6-a542238d4001";
const environment: Record<string, unknown> = {};
let current: Harness;
const gmail = {
  async gmailStatus() {
    return { configured: current.configured, connected: current.connected, senderEmail: "operator@example.com", canManage: true, message: "mock" };
  },
  async sendReviewEmail(_request: Request, mail: ReviewEmail): Promise<MailDelivery> {
    current.calls.push(mail);
    current.order.push("send");
    const invitation = current.db.state.interviewInvitations?.find(item => item.id === mail.id);
    assert.ok(invitation, "Persist the pending invitation before calling Gmail");
    assert.equal(invitation.delivery, "pending");
    assert.equal(current.db.state.interviews[0].notified, false);
    if (current.throwOnSend) throw new Error("mock transport timeout");
    current.receipts.set(mail.id, current.result);
    return current.result;
  },
  async readReviewEmailDelivery(id: string) {
    return current.receipts.get(id) || null;
  },
};
Object.assign(globalThis, { __interviewServerEnv: environment, __interviewServerGmail: gmail });

// Only replace the two external boundaries. The real server, permission guards,
// invitation rules, token hashing and state projection run in these tests.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export const env = globalThis.__interviewServerEnv",
      shortCircuit: true,
    };
    if (specifier.endsWith("/gmail-server.ts")) return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const gmailStatus = (...args) => globalThis.__interviewServerGmail.gmailStatus(...args);" +
        "export const sendReviewEmail = (...args) => globalThis.__interviewServerGmail.sendReviewEmail(...args);" +
        "export const readReviewEmailDelivery = (...args) => globalThis.__interviewServerGmail.readReviewEmailDelivery(...args);"
      ),
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { interviewInvitationAction, recruitmentSnapshot } = await import("../lib/server.ts");

class FakeDatabase {
  state: AppState;
  sessionHash = "";
  sessionUser = "hr";
  updateAttempts = 0;
  writes = 0;
  deliveryConflicts = 0;
  interruptAfterPendingWrite = false;
  stateReadBarrier?: { reads: number; promise: Promise<void>; release: () => void };
  constructor(state: AppState) { this.state = structuredClone(state); }
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            if (sql.startsWith("SELECT user_id, expires_at FROM sessions"))
              return (values[0] === this.sessionHash ? { user_id: this.sessionUser, expires_at: Date.now() + 3600000 } : null) as T | null;
            if (sql.startsWith("SELECT revision, payload FROM recruitment_state")) {
              const row = { revision: this.state.revision, payload: JSON.stringify(this.state) };
              const barrier = this.stateReadBarrier;
              if (barrier && barrier.reads > 0) {
                barrier.reads--;
                if (!barrier.reads) barrier.release();
                await barrier.promise;
              }
              return row as T;
            }
            throw new Error(`Unexpected SELECT: ${sql}`);
          },
          run: async () => {
            assert.ok(sql.startsWith("UPDATE recruitment_state SET revision = ?"), sql);
            this.updateAttempts++;
            const [revision, payload, id, expectedRevision] = values;
            assert.equal(id, "main");
            const next = JSON.parse(String(payload)) as AppState;
            if (this.deliveryConflicts > 0 && next.interviewInvitations?.[0]?.delivery !== "pending") {
              this.deliveryConflicts--;
              this.state.revision++;
              return { meta: { changes: 0 } };
            }
            if (expectedRevision !== this.state.revision) return { meta: { changes: 0 } };
            assert.equal(revision, next.revision);
            this.state = next;
            this.writes++;
            current.order.push(`write:${next.interviewInvitations?.[0]?.delivery}`);
            if (this.interruptAfterPendingWrite && next.interviewInvitations?.[0]?.delivery === "pending") {
              this.interruptAfterPendingWrite = false;
              throw new Error("mock worker interrupted after pending commit");
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
}
interface Harness {
  db: FakeDatabase;
  configured: boolean;
  connected: boolean;
  calls: ReviewEmail[];
  order: string[];
  result: MailDelivery;
  throwOnSend: boolean;
  receipts: Map<string, MailDelivery>;
}
async function setup() {
  const now = new Date(), state = createSeed(now), app = state.applications[0];
  app.stage = "interview";
  app.status = "active";
  app.screeningNote = "HR 人工核对通过，安排专业一面。";
  delete app.selection;
  state.interviews = [{
    id: "server_invitation_interview", applicationId: app.id, round: "专业一面",
    start: new Date(now.getTime() + 86400000).toISOString(),
    end: new Date(now.getTime() + 90000000).toISOString(),
    location: "上海会议室 A", interviewerIds: ["interviewer"], status: "scheduled", notified: false,
  }];
  const db = new FakeDatabase(state);
  db.sessionHash = await hashReviewToken(SESSION_TOKEN);
  current = {
    db, configured: true, connected: true, calls: [], order: [], throwOnSend: false,
    result: { status: "sent", reason: "mock Gmail accepted", messageId: "provider_message_1", sentAt: now.toISOString() },
    receipts: new Map(),
  };
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, { DB: db, MAIL_MODE: "live", MAIL_OPERATOR_EMAIL: "operator@example.com", MAIL_BASE_URL: BASE_URL });
  return current;
}
function request(overrides: Record<string, string> = {}) {
  return new Request(`${BASE_URL}/api/interview-invitations`, {
    method: "POST",
    headers: {
      origin: BASE_URL,
      cookie: `recruitment_session=${SESSION_TOKEN}`,
      "oai-authenticated-user-id": "operator_1",
      "oai-authenticated-user-email": "operator@example.com",
      ...overrides,
    },
  });
}
function sendInput(id = REQUEST_ID) {
  return { action: "sendInterviewInvitation", interviewId: current.db.state.interviews[0].id, requestId: id, expectedRevision: current.db.state.revision };
}
function hasCode(code: string) {
  return (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
type SendResponse = { mailDelivery: MailDelivery; snapshot: { state: AppState } };

async function interruptBeforeMailClaim(harness: Harness) {
  harness.db.interruptAfterPendingWrite = true;
  await assert.rejects(interviewInvitationAction(request(), sendInput()), /interrupted after pending commit/);
  assert.equal(harness.db.state.interviewInvitations![0].delivery, "pending");
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.receipts.size, 0);
}

test("server persists pending with CAS before Gmail and returns its sent receipt with a redacted snapshot", async () => {
  const harness = await setup(), originalRevision = harness.db.state.revision;
  const response = await interviewInvitationAction(request(), sendInput());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as SendResponse;
  assert.equal(body.mailDelivery.status, "sent");
  assert.equal(body.snapshot.state.interviews[0].notified, true);
  assert.equal(body.snapshot.state.interviews[0].invitation!.delivery, "sent");
  assert.equal(body.snapshot.state.interviewInvitations, undefined);
  assert.equal(body.snapshot.state.revision, originalRevision + 2);
  assert.deepEqual(harness.order, ["write:pending", "send", "write:sent"]);
  assert.equal(harness.calls.length, 1);
  const mail = harness.calls[0], token = mail.text.match(/#token=([a-f0-9]{64})/)![1];
  assert.ok(!mail.text.includes("{{RESPONSE_URL}}"));
  assert.equal(harness.db.state.interviewInvitations![0].tokenHash, await hashReviewToken(token));
  assert.ok(!JSON.stringify(harness.db.state).includes(token));
  assert.ok(!JSON.stringify(body).includes(token));
});

test("a rejected Gmail send records failed and does not claim notification", async () => {
  const harness = await setup();
  harness.result = { status: "failed", reason: "mock Gmail rejected recipient" };
  const body = await (await interviewInvitationAction(request(), sendInput())).json() as SendResponse;
  assert.equal(body.mailDelivery.status, "failed");
  assert.equal(body.snapshot.state.interviews[0].invitation!.delivery, "failed");
  assert.equal(body.snapshot.state.interviews[0].notified, false);
  assert.deepEqual(harness.order, ["write:pending", "send", "write:failed"]);
  assert.equal(harness.calls.length, 1);
});

test("an uncertain send prevents a second request id from sending a duplicate email", async () => {
  const harness = await setup(); harness.throwOnSend = true;
  const body = await (await interviewInvitationAction(request(), sendInput())).json() as SendResponse;
  assert.equal(body.mailDelivery.status, "unknown");
  assert.equal(body.snapshot.state.interviews[0].notified, false);
  const writes = harness.db.writes;
  await assert.rejects(interviewInvitationAction(request(), sendInput(SECOND_ID)), hasCode("INVITATION_EXISTS"));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.db.writes, writes);
});

test("repeating the same request id never calls Gmail twice", async () => {
  const harness = await setup();
  await interviewInvitationAction(request(), sendInput());
  const writes = harness.db.writes;
  await assert.rejects(interviewInvitationAction(request(), sendInput()), hasCode("DUPLICATE_REQUEST"));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.db.writes, writes);
});

test("concurrent sends from the same state revision can reserve only one invitation", async () => {
  const harness = await setup();
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  harness.db.stateReadBarrier = { reads: 2, promise, release };
  const first = sendInput(), second = sendInput(SECOND_ID);
  const results = await Promise.allSettled([
    interviewInvitationAction(request(), first),
    interviewInvitationAction(request(), second),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(hasCode("REVISION_CONFLICT")(failure.reason));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.db.state.interviewInvitations!.length, 1);
  assert.equal(harness.db.state.interviews[0].invitation!.delivery, "sent");
});

test("missing Gmail connection, bad operator identity, session or public URL cannot mutate state or send", async () => {
  const scenarios: Array<{ code: string; configure: () => void; headers?: Record<string, string> }> = [
    { code: "GMAIL_NOT_CONFIGURED", configure: () => { environment.MAIL_MODE = "preview"; } },
    { code: "GMAIL_NOT_CONNECTED", configure: () => { current.connected = false; } },
    { code: "GMAIL_NOT_CONNECTED", configure: () => { current.configured = false; } },
    { code: "MAIL_FORBIDDEN", configure: () => ({}), headers: { "oai-authenticated-user-email": "other@example.com" } },
    { code: "MAIL_SIGN_IN_REQUIRED", configure: () => ({}), headers: { "oai-authenticated-user-id": "" } },
    { code: "UNAUTHORIZED", configure: () => ({}), headers: { cookie: "" } },
    { code: "FORBIDDEN", configure: () => { current.db.sessionUser = "manager"; } },
    { code: "GMAIL_NOT_CONFIGURED", configure: () => { delete environment.MAIL_BASE_URL; } },
    { code: "GMAIL_NOT_CONFIGURED", configure: () => { environment.MAIL_BASE_URL = "https://other.example"; } },
  ];
  for (const scenario of scenarios) {
    const harness = await setup(), before = JSON.stringify(harness.db.state);
    scenario.configure();
    await assert.rejects(interviewInvitationAction(request(scenario.headers), sendInput()), hasCode(scenario.code), scenario.code);
    assert.equal(harness.calls.length, 0, scenario.code);
    assert.equal(harness.db.updateAttempts, 0, scenario.code);
    assert.equal(JSON.stringify(harness.db.state), before, scenario.code);
  }
});

test("preview provides invitation text and Gmail readiness without reserving or sending", async () => {
  const harness = await setup(); harness.connected = false;
  const body = await (await interviewInvitationAction(request(), { ...sendInput(), action: "previewInterviewInvitation" })).json() as { mailReady: boolean; connectUrl: string; mailPreview: { text: string } };
  assert.equal(body.mailReady, false);
  assert.equal(body.connectUrl, "/mail-connect");
  assert.match(body.mailPreview.text, /\{\{RESPONSE_URL\}\}/);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.db.updateAttempts, 0);
});

test("a durable Gmail receipt repairs delivery after all post-send CAS attempts conflict", async () => {
  const harness = await setup(); harness.db.deliveryConflicts = 3;
  const body = await (await interviewInvitationAction(request(), sendInput())).json() as SendResponse;
  assert.equal(body.mailDelivery.status, "sent");
  assert.equal(body.snapshot.state.interviews[0].invitation!.delivery, "pending");
  assert.equal(body.snapshot.state.interviews[0].notified, false);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.receipts.get(REQUEST_ID)!.status, "sent");
  const repaired = await (await recruitmentSnapshot(request())).json() as { state: AppState };
  assert.equal(repaired.state.interviews[0].invitation!.delivery, "sent");
  assert.equal(repaired.state.interviews[0].notified, true);
  assert.equal(repaired.state.interviews[0].invitation!.providerMessageId, "provider_message_1");
  assert.equal(harness.calls.length, 1);
});

test("unchanged uncertain receipts cause no new writes or audit events on repeated snapshots", async () => {
  const harness = await setup();
  harness.result = { status: "unknown", reason: "mock Gmail receipt cannot confirm delivery" };
  await interviewInvitationAction(request(), sendInput());
  const writes = harness.db.writes, revision = harness.db.state.revision, events = harness.db.state.events.length;
  await recruitmentSnapshot(request());
  await recruitmentSnapshot(request());
  assert.equal(harness.db.writes, writes);
  assert.equal(harness.db.state.revision, revision);
  assert.equal(harness.db.state.events.length, events);
  assert.equal(harness.calls.length, 1);
});

test("an orphaned pending invitation becomes uncertain at two minutes, stays idempotent and accepts a late receipt without resending", async (context) => {
  const harness = await setup();
  await interruptBeforeMailClaim(harness);
  const createdAt = Date.parse(harness.db.state.interviewInvitations![0].createdAt);
  let clock = createdAt + 119_999;
  context.mock.method(Date, "now", () => clock);
  const before = JSON.stringify(harness.db.state), writes = harness.db.writes;
  await recruitmentSnapshot(request());
  assert.equal(JSON.stringify(harness.db.state), before);
  assert.equal(harness.db.writes, writes);

  clock++;
  const uncertain = await (await recruitmentSnapshot(request())).json() as { state: AppState };
  assert.equal(uncertain.state.interviews[0].invitation!.delivery, "unknown");
  assert.equal(uncertain.state.interviews[0].notified, false);
  assert.match(uncertain.state.interviews[0].invitation!.deliveryReason!, /尚无可确认的回执.*核查 Gmail.*不要重复发送/);
  assert.equal(harness.db.writes, writes + 1);
  const after = JSON.stringify(harness.db.state);
  await recruitmentSnapshot(request());
  await recruitmentSnapshot(request());
  assert.equal(JSON.stringify(harness.db.state), after);
  assert.equal(harness.db.writes, writes + 1);
  await assert.rejects(interviewInvitationAction(request(), sendInput(SECOND_ID)), hasCode("INVITATION_EXISTS"));
  assert.equal(harness.calls.length, 0);

  harness.receipts.set(REQUEST_ID, harness.result);
  const repaired = await (await recruitmentSnapshot(request())).json() as { state: AppState };
  assert.equal(repaired.state.interviews[0].invitation!.delivery, "sent");
  assert.equal(repaired.state.interviews[0].invitation!.providerMessageId, "provider_message_1");
  assert.equal(repaired.state.interviews[0].notified, true);
  const sent = JSON.stringify(harness.db.state), sentWrites = harness.db.writes;
  harness.receipts.delete(REQUEST_ID);
  clock += 120_000;
  await recruitmentSnapshot(request());
  harness.receipts.set(REQUEST_ID, { status: "unknown", reason: "late uncertain result" });
  await recruitmentSnapshot(request());
  assert.equal(JSON.stringify(harness.db.state), sent);
  assert.equal(harness.db.writes, sentWrites);
  assert.equal(harness.calls.length, 0);
});

test("revoking an orphaned invitation survives its late receipt and permits only an explicit replacement send", async (context) => {
  const harness = await setup();
  await interruptBeforeMailClaim(harness);
  context.mock.method(Date, "now", () => Date.parse(harness.db.state.interviewInvitations![0].createdAt) + 120_000);
  await recruitmentSnapshot(request());
  assert.equal(harness.db.state.interviews[0].invitation!.delivery, "unknown");
  await interviewInvitationAction(request(), { ...sendInput(), action: "revokeInterviewInvitation" });
  const revoked = structuredClone(harness.db.state.interviews[0].invitation!);
  assert.ok(revoked.revokedAt);
  harness.receipts.set(REQUEST_ID, harness.result);
  await recruitmentSnapshot(request());
  assert.equal(harness.db.state.interviewInvitations![0].delivery, "sent");
  assert.equal(harness.db.state.interviewInvitations![0].revokedAt, revoked.revokedAt);
  assert.deepEqual(harness.db.state.interviews[0].invitation, revoked);
  assert.equal(harness.db.state.interviews[0].notified, false);
  assert.equal(harness.calls.length, 0);

  const replacement = await (await interviewInvitationAction(request(), sendInput(SECOND_ID))).json() as SendResponse;
  assert.equal(replacement.snapshot.state.interviews[0].invitation!.id, SECOND_ID);
  assert.equal(replacement.snapshot.state.interviews[0].invitation!.delivery, "sent");
  await recruitmentSnapshot(request());
  assert.equal(harness.db.state.interviews[0].invitation!.id, SECOND_ID);
  assert.equal(harness.calls.length, 1);
});
