import assert from 'node:assert/strict';

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const testSiteUserId = process.env.TEST_SITE_USER_ID;
const testSiteUserEmail = process.env.TEST_SITE_USER_EMAIL;
const siteHeaders = {};
if (testSiteUserId !== undefined || testSiteUserEmail !== undefined) {
  assert.ok(testSiteUserId?.trim() && testSiteUserEmail?.trim(), 'TEST_SITE_USER_ID and TEST_SITE_USER_EMAIL must both be configured');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname), 'Test Sites identity headers are only allowed against a local server');
  siteHeaders['oai-authenticated-user-id'] = testSiteUserId.trim();
  siteHeaders['oai-authenticated-user-email'] = testSiteUserEmail.trim();
}
const runId = Date.now().toString(36);
let passed = 0;
let skipped = 0;
let realReviewReady = false;
let modelFailure = '尚未取得真实模型报告';

class Session {
  constructor(userId) { this.userId = userId; this.cookie = ''; }
  async request(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}), ...siteHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65_000),
    });
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (cookies.length) this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`${path.split('?')[0]} returned HTTP ${response.status} with non-JSON content`); }
    return { status: response.status, data };
  }
  async login() {
    const response = await this.request('/api/session', { userId: this.userId, password: process.env.DEMO_PASSWORD || 'Demo2026!' });
    assert.equal(response.status, 200);
    assert.equal(response.data.user.id, this.userId);
  }
  async snapshot() {
    const result = await this.request('/api/recruitment');
    assert.equal(result.status, 200);
    return result.data.state;
  }
  async action(action, fields) {
    const expectedRevision = (await this.snapshot()).revision;
    const result = await this.request('/api/recruitment', { action, expectedRevision, ...fields });
    assert.equal(result.status, 200, `${action}: ${result.data.error || 'unexpected response'}`);
    return result.data.state;
  }
}
const hr = new Session('hr');
const manager = new Session('manager');
const interviewer = new Session('interviewer');
const anonymous = new Session('anonymous');
let applicationId;
let otherApplicationId;
let candidateId;
let invitation;
let latest;
const appOf = (state, id = applicationId) => {
  const app = state.applications.find(item => item.id === id);
  assert.ok(app);
  return app;
};
async function check(name, task) {
  if ((await task()) === false) {
    skipped++;
    process.stdout.write(`SKIP ${name}（原有效真实报告及 HR 通过结论的失效检查）: ${modelFailure}\n`);
    return;
  }
  passed++;
  process.stdout.write(`PASS ${String(passed).padStart(2, '0')} ${name}\n`);
}
function tokenOf(result) {
  const token = new URL(result.reviewUrl).searchParams.get('token');
  assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Expected a 256-bit review token');
  return token;
}
async function scopedGet(token) { return anonymous.request(`/api/candidate-review?token=${encodeURIComponent(token)}`); }
async function expectError(result, status, code) {
  assert.equal(result.status, status, result.data.error || 'unexpected response status');
  assert.equal(result.data.error, code);
}
async function invite() {
  const expectedRevision = (await hr.snapshot()).revision;
  const result = await hr.request('/api/candidate-review', { action: 'createCandidateReview', applicationId, expectedRevision });
  assert.equal(result.status, 200, result.data.error || 'unexpected invitation response');
  return result.data;
}
async function job(suffix) {
  const before = await hr.snapshot();
  let state = await hr.action('createJob', { title: `资料核对验收-${suffix}-${runId}`, department: '演示产品部', location: '上海', type: 'social', headcount: 1, managerId: 'manager', description: '合成资料核对接口验收职位', skills: ['SQL'], dimensions: ['专业能力'] });
  const created = state.jobs.find(item => !before.jobs.some(previous => previous.id === item.id));
  assert.ok(created);
  await hr.action('jobStatus', { jobId: created.id, status: 'pending' });
  state = await manager.action('jobStatus', { jobId: created.id, status: 'open' });
  assert.equal(state.jobs.find(item => item.id === created.id).status, 'open');
  return created.id;
}

async function main() {
  process.stdout.write(`Candidate review API smoke — ${baseUrl}\nSynthetic run: ${runId}\n`);
  await check('独立 HR/经理/面试官会话与同人多岗合成资料', async () => {
    for (const session of [hr, manager, interviewer]) await session.login();
    const primaryJob = await job('主投递'), secondJob = await job('隔离对照');
    const before = await hr.snapshot();
    let state = await hr.action('createCandidate', { jobId: primaryJob, name: `合成核对人-${runId}`, email: `review-${runId}@example.com`, phone: '', education: 'unknown', school: '演示大学', major: '信息管理', graduationYear: null, skills: [], resume: 'PRIVATE_RESUME：仅用于验收的合成简历，负责内部沟通项目，记录业务基线、实施行动并复盘结果，相关经历仍待人工核实。', availability: '可协商', source: '核对接口验收' });
    const created = state.applications.find(item => !before.applications.some(previous => previous.id === item.id));
    applicationId = created.id; candidateId = created.candidateId;
    state = await hr.action('createApplication', { candidateId, jobId: secondJob, source: '跨岗隔离对照' });
    otherApplicationId = state.applications.find(item => item.candidateId === candidateId && item.jobId === secondJob).id;
    const selection = appOf(state).selection;
    realReviewReady = selection.resumeReview?.mode === 'llm';
    if (realReviewReady) {
      const report = selection.resumeReview;
      assert.ok(report.model?.trim());
      assert.equal(report.kind, 'resume');
      assert.equal(report.score, null);
      assert.equal(report.maxScore, null);
      assert.ok(report.evidence.length);
      assert.ok(report.evidence.every(item => item.quote.trim() &&
        (appOf(state).snapshot.resume.includes(item.quote) || (item.status !== 'matched' && item.quote === '简历未提供相关依据'))));
    }
    else {
      assert.equal(selection.resumeReview, undefined);
      assert.equal(selection.aiReview.status, 'failed');
      assert.ok(selection.aiReview.message?.trim());
      modelFailure = selection.aiReview.message;
    }
    await hr.action('confirm_screening', { applicationId, conclusion: realReviewReady ? 'pass' : 'hold', note: `PRIVATE_HR_NOTE-${runId}：已核对演示资料；真实报告未完成时保留待核实。` });
    await hr.action('assign_assessment', { applicationId, kind: 'written' });
  });

  await check('邀请只生成真实邮件预览，七天随机链接且 Snapshot 不泄露哈希', async () => {
    invitation = await invite(); latest = invitation;
    const token = tokenOf(invitation);
    assert.equal(invitation.review.delivery, 'preview');
    assert.equal(invitation.mailPreview.status, 'preview');
    assert.ok(invitation.mailPreview.text.includes(invitation.reviewUrl));
    assert.match(invitation.mailPreview.reason, /未发送邮件/);
    assert.equal(Date.parse(invitation.review.expiresAt) - Date.parse(invitation.review.createdAt), 7 * 86400000);
    const json = JSON.stringify(invitation.snapshot);
    assert.ok(!json.includes(token));
    assert.ok(!json.includes('tokenHash'));
    assert.equal(invitation.snapshot.state.reviews, undefined);
    assert.equal(appOf(invitation.snapshot.state).snapshot.review.reviewId, invitation.review.id);
  });

  await check('候选人无会话 GET 仅返回本人字段白名单、职位与期限', async () => {
    const result = await scopedGet(tokenOf(invitation));
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data).sort(), ['canSubmit', 'demoNotice', 'fields', 'job', 'review']);
    assert.deepEqual(Object.keys(result.data.fields).sort(), ['availability', 'education', 'email', 'graduationYear', 'major', 'name', 'phone', 'school', 'skills']);
    assert.deepEqual(Object.keys(result.data.review).sort(), ['expiresAt', 'id', 'status', 'version']);
    assert.deepEqual(Object.keys(result.data.job).sort(), ['title', 'type']);
    assert.equal(result.data.canSubmit, true);
    assert.match(result.data.demoNotice, /合成资料/);
    const json = JSON.stringify(result.data);
    for (const forbidden of ['PRIVATE_RESUME', 'PRIVATE_HR_NOTE', 'tokenHash', 'screeningNote', 'assessments', otherApplicationId]) assert.ok(!json.includes(forbidden));
  });

  await check('未登录不能签发，经理和面试官无邀请权限，未知令牌 Gone', async () => {
    const expectedRevision = (await hr.snapshot()).revision;
    const body = { action: 'createCandidateReview', applicationId, expectedRevision };
    await expectError(await anonymous.request('/api/candidate-review', body), 401, 'UNAUTHORIZED');
    await expectError(await manager.request('/api/candidate-review', body), 403, 'FORBIDDEN');
    await expectError(await interviewer.request('/api/candidate-review', body), 403, 'FORBIDDEN');
    await expectError(await scopedGet('f'.repeat(64)), 410, 'REVIEW_GONE');
    for (const session of [hr, manager, interviewer]) {
      const state = await session.snapshot();
      assert.equal(state.reviews, undefined);
      assert.ok(!JSON.stringify(state).includes('tokenHash'));
    }
  });

  await check('旧表单版本、未确认和额外字段拒绝提交且不写入', async () => {
    const token = tokenOf(invitation), view = (await scopedGet(token)).data, before = await hr.snapshot();
    const body = { token, expectedVersion: view.review.version, confirmed: true, fields: view.fields };
    await expectError(await anonymous.request('/api/candidate-review', { ...body, expectedVersion: -1 }), 409, 'REVIEW_VERSION_CONFLICT');
    await expectError(await anonymous.request('/api/candidate-review', { ...body, confirmed: false }), 422, 'CONFIRMATION_REQUIRED');
    await expectError(await anonymous.request('/api/candidate-review', { ...body, fields: { ...view.fields, decision: 'hire' } }), 422, 'INVALID_REVIEW_FIELDS');
    await expectError(await anonymous.request('/api/candidate-review', { ...body, fields: { ...view.fields, email: '', phone: '(((((((' } }), 422, 'INVALID_PHONE');
    assert.equal((await hr.snapshot()).revision, before.revision);
  });

  await check('明确确认后更正本投递和主档，清旧报告、保留测评且不推进', async () => {
    const token = tokenOf(invitation), view = (await scopedGet(token)).data, before = await hr.snapshot();
    const fields = { ...view.fields, name: `核对完成-${runId}`, education: 'master', school: '演示核实院校', graduationYear: 2027, skills: ['SQL', '用户研究'] };
    const result = await anonymous.request('/api/candidate-review', { token, expectedVersion: view.review.version, confirmed: true, fields, applicationId: otherApplicationId });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.review.status, 'submitted');
    const state = await hr.snapshot(), app = appOf(state), old = appOf(before);
    assert.equal(app.snapshot.name, fields.name);
    assert.equal(state.candidates.find(item => item.id === candidateId).name, fields.name);
    assert.equal(app.snapshot.resume, old.snapshot.resume);
    assert.deepEqual(appOf(state, otherApplicationId), appOf(before, otherApplicationId));
    for (const field of ['ruleReview', 'resumeReview', 'hrReview']) assert.equal(app.selection[field], undefined);
    assert.deepEqual(app.selection.assessments, old.selection.assessments);
    assert.equal(app.stage, old.stage); assert.equal(app.status, old.status); assert.equal(app.decision, old.decision);
    assert.equal(app.snapshot.review.status, 'submitted');
    if (!realReviewReady) return false;
    assert.equal(old.selection.resumeReview.mode, 'llm');
    assert.equal(old.selection.hrReview.conclusion, 'pass');
  });

  await check('已提交链接锁定，重新读取和二次提交均 Gone', async () => {
    const token = tokenOf(invitation);
    await expectError(await scopedGet(token), 410, 'REVIEW_GONE');
    await expectError(await anonymous.request('/api/candidate-review', { token, expectedVersion: 0, confirmed: true, fields: {} }), 410, 'REVIEW_GONE');
  });

  await check('重发新令牌立即撤销旧邀请，不新增候选人或投递', async () => {
    const before = await hr.snapshot();
    const previous = await invite(); latest = await invite();
    assert.ok(tokenOf(previous) !== tokenOf(latest), 'Resending must rotate the token');
    await expectError(await scopedGet(tokenOf(previous)), 410, 'REVIEW_GONE');
    assert.equal((await scopedGet(tokenOf(latest))).status, 200);
    const after = await hr.snapshot();
    assert.equal(after.candidates.length, before.candidates.length);
    assert.equal(after.applications.length, before.applications.length);
  });

  await check('HR 更正签发后资料使旧链接读写均返回版本冲突', async () => {
    const token = tokenOf(latest), view = (await scopedGet(token)).data;
    await hr.action('updateCandidate', { candidateId, school: 'HR 再次核实的院校' });
    await expectError(await scopedGet(token), 409, 'REVIEW_DATA_CHANGED');
    await expectError(await anonymous.request('/api/candidate-review', { token, expectedVersion: view.review.version, confirmed: true, fields: view.fields }), 409, 'REVIEW_DATA_CHANGED');
  });

  await check('并发签发 CAS 仅成功一次，HR 撤销后链接 Gone', async () => {
    const expectedRevision = (await hr.snapshot()).revision;
    const body = { action: 'createCandidateReview', applicationId, expectedRevision };
    const results = await Promise.all([hr.request('/api/candidate-review', body), hr.request('/api/candidate-review', body)]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    const success = results.find(item => item.status === 200).data;
    assert.equal(results.find(item => item.status === 409).data.error, 'REVISION_CONFLICT');
    const token = tokenOf(success);
    assert.equal((await scopedGet(token)).status, 200);
    const result = await hr.request('/api/candidate-review', { action: 'revokeCandidateReview', applicationId, expectedRevision: (await hr.snapshot()).revision });
    assert.equal(result.status, 200);
    assert.equal(appOf(result.data.snapshot.state).snapshot.review.status, 'revoked');
    await expectError(await scopedGet(token), 410, 'REVIEW_GONE');
  });

  process.stdout.write(`\n${passed} candidate review API scenarios passed; ${skipped} explicitly skipped. Synthetic run: ${runId}.\nNo reset, no external email delivery, and no token or cookie was printed. Synthetic fixtures remain for review.\n`);
}
main().catch(error => { process.stderr.write(`\nFAIL after ${passed} passed scenarios (run ${runId}): ${error.stack || error.message}\n`); process.exitCode = 1; });
