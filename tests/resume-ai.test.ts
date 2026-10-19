import { test } from "node:test";
import assert from "node:assert/strict";
import { generateResumeReview, ResumeAIError } from "../lib/resume-ai.ts";
import { createSeed } from "../lib/seed.ts";

const NOW = "2026-10-20T06:00:00.000Z";
const state = createSeed(new Date(NOW));
const job = { ...state.jobs[0], title: "产品经理", description: "负责产品规划、SQL 数据分析与用户研究。" };
const candidate = {
  ...state.candidates[0],
  name: "王小明", email: "xiaoming@example.com", phone: "13812345678", school: "复旦大学",
  resume: "姓名：王小明，邮箱：xiaoming@example.com，手机：138 1234 5678。\n复旦大学，本科，计算机专业。\n负责产品规划，使用 SQL 分析转化漏斗，推动转化率提升 12%。\n参与用户研究，完成 20 次访谈。",
};
const config = { DEEPSEEK_API_KEY: "test-secret-key" };
const review = () => ({
  summary: "简历提供了产品规划、数据分析和用户研究的项目线索，个人负责范围仍需人工核实。",
  evidence: [
    { label: "产品规划", status: "matched", quote: "负责产品规划", reason: "提供了与岗位职责相关的行为描述。" },
    { label: "SQL 数据分析", status: "matched", quote: "使用 SQL 分析转化漏斗", reason: "提供了 SQL 的具体使用场景。" },
    { label: "跨团队协作", status: "unknown", quote: "", reason: "简历没有提供协作场景。" },
  ],
  gaps: ["跨团队协作经历尚待核实"],
  questions: ["请说明转化漏斗分析中由你负责的具体工作。"],
});
function providerResponse(value: unknown = review(), extra: Record<string, unknown> = {}) {
  return Response.json({ model: "deepseek-flash", choices: [
    { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } },
  ], ...extra });
}
const returns = (response: Response): typeof fetch => async () => response;
const isError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ResumeAIError);
  assert.equal(error.code, code);
  assert.ok(!error.message.includes(config.DEEPSEEK_API_KEY));
  return true;
};

test("requests a DeepSeek JSON review and retains verified evidence without numeric scores", async () => {
  let called = false;
  const result = await generateResumeReview(job, candidate, config, NOW, async (url, options) => {
    called = true;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options?.method, "POST");
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${config.DEEPSEEK_API_KEY}`);
    assert.ok(options?.signal instanceof AbortSignal);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.max_tokens, 4000);
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: "disabled" });
    for (const field of ["store", "text", "max_output_tokens", "instructions", "input"])
      assert.equal(Object.hasOwn(body, field), false);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.match(body.messages[0].content, /不可信数据/);
    assert.match(body.messages[0].content, /不推断年龄、性别、健康/);
    assert.match(body.messages[0].content, /不得作出录用、淘汰/);
    const example = JSON.parse(body.messages[0].content.split("\n").at(-1));
    assert.equal(example.evidence.length, 3);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.job.title, job.title);
    assert.equal(input.job.description, job.description);
    assert.deepEqual(input.job.policy.requiredSkills, job.screeningPolicy?.requiredSkills ?? job.skills);
    return providerResponse();
  });
  assert.equal(called, true);
  assert.equal(result.mode, "llm");
  assert.equal(result.model, "deepseek-flash");
  assert.equal(result.createdAt, NOW);
  assert.equal(result.score, null);
  assert.equal(result.maxScore, null);
  assert.equal(result.evidence[0].quote, "负责产品规划");
  assert.equal(result.evidence[2].quote, "简历未提供相关依据");
  assert.equal(result.questions?.length, 1);
  assert.match(result.disclaimer, /最终结论由 HR 确认/);
});

test("outbound data excludes known contact details and non-required school, including fields embedded in text", async () => {
  const contaminatedJob = { ...job, description: `${job.description} 联系人：${candidate.name}；${candidate.email}` };
  const contaminatedCandidate = { ...candidate, major: `计算机 ${candidate.email}`, skills: ["SQL", candidate.name] };
  await generateResumeReview(contaminatedJob, contaminatedCandidate, config, NOW, async (_url, options) => {
    const body = String(options?.body);
    for (const secret of [candidate.name, candidate.email, candidate.phone, "138 1234 5678", candidate.school])
      assert.ok(!body.includes(secret), secret);
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    for (const field of ["name", "email", "phone", "school", "id", "createdAt", "availability"])
      assert.equal(Object.hasOwn(input.candidate, field), false);
    assert.ok(input.candidate.resume.includes("使用 SQL 分析转化漏斗"));
    return providerResponse();
  });
});

test("a school is retained in resume text only when explicitly named in job requirements", async () => {
  await generateResumeReview({ ...job, description: "复旦大学相关研究项目经历。" }, candidate, config, NOW, async (_url, options) => {
    const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
    assert.ok(input.candidate.resume.includes(candidate.school));
    return providerResponse();
  });
});

test("missing key or resume stops before any provider request", async () => {
  const noFetch: typeof fetch = async () => { assert.fail("provider must not be called"); };
  await assert.rejects(generateResumeReview(job, candidate, {}, NOW, noFetch), isError("AI_NOT_CONFIGURED"));
  const legacyConfig = { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: "legacy-key-must-not-authenticate" };
  await assert.rejects(generateResumeReview(job, candidate, legacyConfig, NOW, noFetch), isError("AI_NOT_CONFIGURED"));
  await assert.rejects(generateResumeReview(job, { ...candidate, resume: " " }, config, NOW, noFetch), isError("AI_RESUME_REQUIRED"));
});

test("invented or absent matched evidence and untraceable quotes in any status are rejected", async () => {
  for (const [status, quote] of [["matched", "主导千万级项目"], ["matched", ""], ["unknown", "未在原文出现的推断"], ["info", "[已隐藏]"]]) {
    const value = review();
    value.evidence[0] = { ...value.evidence[0], status, quote };
    await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(providerResponse(value))), isError("AI_UNVERIFIED_EVIDENCE"));
  }
});

test("invalid schemas, fabricated numeric fields and incomplete or refused responses never become reports", async () => {
  const missing = review() as Record<string, unknown>;
  delete missing.questions;
  const tooFew = { ...review(), evidence: review().evidence.slice(0, 1) };
  const invalid = [missing, tooFew, { ...review(), score: 98 }, { ...review(), evidence: [{ ...review().evidence[0], status: "hire" }, ...review().evidence.slice(1)] }];
  for (const value of invalid)
    await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(providerResponse(value))), isError("AI_INVALID_RESPONSE"));
  for (const [finish_reason, code] of [["length", "AI_INCOMPLETE"], ["content_filter", "AI_REFUSED"], ["tool_calls", "AI_INVALID_RESPONSE"], ["unknown", "AI_INVALID_RESPONSE"]])
    await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(providerResponse(review(), { choices: [{ finish_reason, message: { content: null } }] }))), isError(code));
  for (const content of [null, "", "  ", "not JSON"])
    await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(providerResponse(review(), { choices: [{ finish_reason: "stop", message: { content } }] }))), isError("AI_INVALID_RESPONSE"));
  await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(new Response("not JSON"))), isError("AI_INVALID_RESPONSE"));
  await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(Response.json({ output_text: JSON.stringify(review()) }))), isError("AI_INVALID_RESPONSE"));
});

test("provider authentication, quota, server, network and timeout errors expose only sanitized messages", async () => {
  for (const [status, code] of [[401, "AI_AUTH_FAILED"], [403, "AI_AUTH_FAILED"], [402, "AI_QUOTA_EXCEEDED"], [429, "AI_RATE_LIMITED"], [500, "AI_UNAVAILABLE"], [503, "AI_UNAVAILABLE"]] as const) {
    const response = new Response(`private provider detail ${config.DEEPSEEK_API_KEY}`, { status });
    await assert.rejects(generateResumeReview(job, candidate, config, NOW, returns(response)), (error) => {
      isError(code)(error);
      assert.ok(!(error as Error).message.includes("private provider detail"));
      return true;
    });
  }
  const broken: typeof fetch = async () => { throw new Error(`private provider detail ${config.DEEPSEEK_API_KEY}`); };
  await assert.rejects(generateResumeReview(job, candidate, config, NOW, broken), isError("AI_UNAVAILABLE"));
  const timedOut: typeof fetch = async () => { throw new DOMException(config.DEEPSEEK_API_KEY, "TimeoutError"); };
  await assert.rejects(generateResumeReview(job, candidate, config, NOW, timedOut), isError("AI_TIMEOUT"));
});

test("configured model is used and recorded when the provider omits a model identifier", async () => {
  const result = await generateResumeReview(job, candidate, { ...config, DEEPSEEK_MODEL: "custom-model" }, NOW, async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).model, "custom-model");
    return providerResponse(review(), { model: undefined });
  });
  assert.equal(result.model, "custom-model");
});
