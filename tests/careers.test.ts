import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppState } from "../lib/domain.ts";
import { BusinessError, projectState } from "../lib/engine.ts";
import { createSeed } from "../lib/seed.ts";
import { publicJobs, submitCareerApplication } from "../lib/careers.ts";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const seed = () => createSeed(NOW);
const fields = {
  name: "合成应聘者",
  email: "public-applicant@example.com",
  phone: "19988880001",
  school: "演示大学",
  major: "计算机科学",
  education: "bachelor",
  graduationYear: 2027,
  skills: ["TypeScript", "SQL"],
  resume: "合成简历，仅用于演示。曾参与 TypeScript 和 SQL 相关实践项目。",
  availability: "两周内",
};
const form = () => ({
  requestId: crypto.randomUUID(),
  jobId: "job_1",
  candidate: { ...fields },
  consent: true,
});
async function rejects(state: AppState, input: Record<string, unknown>, code: string) {
  const before = JSON.stringify(state);
  await assert.rejects(
    submitCareerApplication(state, input, NOW),
    (error: unknown) => error instanceof BusinessError && error.code === code,
  );
  assert.equal(JSON.stringify(state), before);
}

test("public jobs include only open positions and the explicit applicant-facing fields", () => {
  const state = seed();
  const jobs = publicJobs(state);
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every((job) => state.jobs.find((item) => item.id === job.id)!.status === "open"));
  assert.deepEqual(Object.keys(jobs[0]).sort(), ["id", "title", "department", "location", "type", "batch", "graduationYears", "description", "skills", "createdAt"].sort());
  for (const key of ["users", "candidates", "applications", "ownerId", "managerId", "screeningPolicy", "dimensions"])
    assert.ok(!JSON.stringify(jobs).includes(`"${key}"`));
  jobs[0].skills.push("MUTATION");
  assert.ok(!state.jobs[0].skills.includes("MUTATION"));
});

test("public applications reach the HR new pipeline with an independent profile and minimal receipt", async () => {
  const state = seed(), before = JSON.stringify(state);
  const result = await submitCareerApplication(state, form(), NOW);
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(result.state.candidates.length, state.candidates.length + 1);
  const app = result.state.applications.at(-1)!;
  assert.equal(app.stage, "new");
  assert.equal(app.status, "active");
  assert.equal(app.ownerId, state.jobs[0].ownerId);
  assert.equal(app.source, "候选人自助投递");
  assert.deepEqual(app.snapshot.skills, fields.skills);
  assert.equal(app.snapshot.resume, fields.resume);
  assert.equal(app.selection, undefined);
  assert.equal(result.state.events.at(-1)!.applicationId, app.id);
  assert.deepEqual(Object.keys(result.receipt).sort(), ["reference", "jobTitle", "submittedAt"].sort());
  assert.equal(result.receipt.jobTitle, state.jobs[0].title);
  assert.equal(result.receipt.submittedAt, NOW.toISOString());
  assert.equal(result.replayed, false);
  const hrView = projectState(result.state, state.users.find((user) => user.id === "hr")!);
  assert.equal(hrView.applications.at(-1)!.id, app.id);
  assert.equal(hrView.careerSubmissions, undefined);
});

test("an existing contact on another job never merges, overwrites or copies a private profile", async () => {
  const state = seed();
  const existing = state.candidates[0];
  const prior = structuredClone(existing);
  existing.resume = "EXISTING_PRIVATE_RESUME";
  const oldApplications = JSON.stringify(state.applications);
  const result = await submitCareerApplication(state, {
    ...form(), jobId: "job_3", candidate: { ...fields, email: existing.email },
  }, NOW);
  assert.deepEqual(result.state.candidates.find((candidate) => candidate.id === existing.id), { ...prior, resume: "EXISTING_PRIVATE_RESUME" });
  const created = result.state.applications.at(-1)!;
  assert.notEqual(created.candidateId, existing.id);
  assert.equal(created.snapshot.name, fields.name);
  assert.equal(created.snapshot.resume, fields.resume);
  assert.equal(JSON.stringify(result.state.applications.slice(0, -1)), oldApplications);
  assert.ok(!JSON.stringify(result.receipt).includes("EXISTING_PRIVATE_RESUME"));
});

test("same request retries return the original receipt without changing state, even after a job closes", async () => {
  const input = form();
  const first = await submitCareerApplication(seed(), input, NOW);
  first.state.jobs[0].status = "closed";
  const before = JSON.stringify(first.state);
  const retry = await submitCareerApplication(first.state, input, new Date("2026-10-21T08:00:00Z"));
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(JSON.stringify(retry.state), before);
  retry.receipt.reference = "MUTATION";
  assert.equal(JSON.stringify(first.state), before);
});

test("request ids cannot be reused with changed candidate data or another position", async () => {
  const input = form();
  const first = await submitCareerApplication(seed(), input, NOW);
  await rejects(first.state, { ...input, candidate: { ...fields, resume: "修改过的合成简历" } }, "REQUEST_CONFLICT");
  await rejects(first.state, { ...input, jobId: "job_2" }, "REQUEST_CONFLICT");
});

test("same-job duplicates are rejected generically for matching normalized email or phone, including closed applications", async () => {
  const state = seed();
  const existing = state.candidates[0];
  for (const candidate of [
    { ...fields, email: ` ${existing.email.toUpperCase()} ` },
    { ...fields, phone: `+${existing.phone.slice(0, 3)} ${existing.phone.slice(3)}` },
  ]) {
    await rejects(state, { ...form(), candidate }, "ALREADY_APPLIED");
  }
  const first = await submitCareerApplication(state, form(), NOW);
  first.state.applications.at(-1)!.status = "closed";
  await rejects(first.state, form(), "ALREADY_APPLIED");
});

test("unknown and non-open jobs cannot accept new submissions", async () => {
  const state = seed();
  for (const status of ["draft", "pending", "paused", "closed"] as const) {
    state.jobs[0].status = status;
    await rejects(state, form(), "JOB_UNAVAILABLE");
  }
  await rejects(state, { ...form(), jobId: "missing" }, "JOB_UNAVAILABLE");
});

test("consent, UUID, strict input fields and candidate validation are enforced before any write", async () => {
  const state = seed();
  for (const input of [{ ...form(), consent: false }, { ...form(), consent: "true" }])
    await rejects(state, input, "CONSENT_REQUIRED");
  await rejects(state, { ...form(), requestId: "not-a-uuid" }, "INVALID_REQUEST_ID");
  await rejects(state, { ...form(), ownerId: "interviewer" }, "INVALID_FIELDS");
  await rejects(state, { ...form(), candidate: { ...fields, stage: "joined" } }, "INVALID_FIELDS");
  for (const [patch, code] of [
    [{ name: "" }, "REQUIRED"],
    [{ email: "" }, "REQUIRED"],
    [{ email: "invalid" }, "INVALID_EMAIL"],
    [{ phone: "abc" }, "INVALID_PHONE"],
    [{ phone: "-------" }, "INVALID_PHONE"],
    [{ education: "invented" }, "INVALID_EDUCATION"],
    [{ graduationYear: "2027" }, "INVALID_YEAR"],
    [{ graduationYear: 2101 }, "INVALID_YEAR"],
    [{ skills: ["x".repeat(61)] }, "INVALID_SKILLS"],
    [{ skills: Array(31).fill("SQL") }, "INVALID_SKILLS"],
    [{ resume: "  " }, "REQUIRED"],
    [{ resume: "x".repeat(100001) }, "INVALID_FIELDS"],
    [{ resume: "resume\u0000" }, "INVALID_RESUME"],
    [{ school: "x".repeat(121) }, "INVALID_FIELDS"],
    [{ name: {} }, "INVALID_FIELDS"],
  ] as [Record<string, unknown>, string][])
    await rejects(state, { ...form(), candidate: { ...fields, ...patch } }, code);
});

test("optional fields remain unknown instead of inferring education or graduation eligibility", async () => {
  const result = await submitCareerApplication(seed(), {
    ...form(), jobId: "job_5", candidate: { name: fields.name, email: fields.email, resume: fields.resume },
  }, NOW);
  const candidate = result.state.candidates.at(-1)!;
  assert.equal(candidate.phone, "");
  assert.equal(candidate.education, "unknown");
  assert.equal(candidate.graduationYear, null);
  assert.deepEqual(candidate.skills, []);
  assert.equal(result.state.applications.at(-1)!.stage, "new");
});

test("the full 100,000-character resume is retained without the parser's shorter review preview limit", async () => {
  const resume = `合成${"x".repeat(99998)}`;
  const result = await submitCareerApplication(seed(), {
    ...form(), candidate: { ...fields, resume },
  }, NOW);
  assert.equal(result.state.candidates.at(-1)!.resume, resume);
  assert.equal(result.state.applications.at(-1)!.snapshot.resume, resume);
});

test("recomputing against the winner of a concurrent CAS prevents duplicate records", async () => {
  const original = seed(), input = form();
  const [first, competing] = await Promise.all([
    submitCareerApplication(original, input, NOW),
    submitCareerApplication(original, input, NOW),
  ]);
  assert.equal(first.state.revision, competing.state.revision);
  const retried = await submitCareerApplication(first.state, input, NOW);
  assert.equal(retried.replayed, true);
  assert.equal(retried.state.applications.length, original.applications.length + 1);
  assert.deepEqual(retried.receipt, first.receipt);
  await rejects(first.state, { ...input, requestId: crypto.randomUUID() }, "ALREADY_APPLIED");
});
