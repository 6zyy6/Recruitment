import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run against a local synthetic database: BASE_URL=http://127.0.0.1:5173 node scripts/careers-smoke.mjs
// This script creates synthetic fixtures; it never resets existing records.
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const runId = Date.now().toString(36);
let passed = 0;

class Session {
  constructor(userId) { this.userId = userId; this.cookie = ''; }
  async request(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (cookies.length) this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`${path} returned HTTP ${response.status} with non-JSON content`); }
    return { status: response.status, data, headers: response.headers };
  }
  async login() {
    const response = await this.request('/api/session', { userId: this.userId, password: process.env.DEMO_PASSWORD || 'Demo2026!' });
    assert.equal(response.status, 200);
    assert.equal(response.data.user.id, this.userId);
    assert.ok(this.cookie);
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
const anonymous = new Session('anonymous');
const jobFields = ['id', 'title', 'department', 'location', 'type', 'batch', 'graduationYears', 'description', 'skills', 'createdAt'];
const fields = {
  name: `合成自主投递人-${runId}`, email: `careers-${runId}@example.com`, phone: '',
  school: '演示大学', major: '信息管理', education: 'bachelor', graduationYear: null,
  skills: ['SQL', '用户研究'], availability: '两周内可到岗',
  resume: `PRIVATE_SYNTHETIC_RESUME-${runId}：仅用于候选人入口验收的合成简历，负责一个模拟用户研究项目，整理需求、分析数据、形成方案并复盘交付结果；不对应真实个人。`,
};
let primaryJob;
let secondJob;
let closedJob;
let application;
let savedCandidate;
let submission;
let receipt;

async function check(name, task) {
  await task(); passed++;
  process.stdout.write(`PASS ${String(passed).padStart(2, '0')} ${name}\n`);
}
function keysOf(object) { return Object.keys(object).sort(); }
function rejected(result, expectedStatus) {
  if (expectedStatus) assert.equal(result.status, expectedStatus, result.data.error || 'expected rejection');
  else assert.ok(result.status >= 400 && result.status < 500, `Expected rejection, got ${result.status}`);
  assert.equal(typeof result.data.error, 'string');
  assert.equal(result.headers.get('cache-control'), 'no-store');
}
function successful(result) {
  assert.ok([200, 201].includes(result.status), result.data.error || `Unexpected HTTP ${result.status}`);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(keysOf(result.data), ['receipt']);
  assert.deepEqual(keysOf(result.data.receipt), ['jobTitle', 'reference', 'submittedAt']);
  assert.equal(typeof result.data.receipt.reference, 'string');
  assert.ok(result.data.receipt.reference.length > 0);
  assert.equal(result.data.receipt.jobTitle, primaryJob.title);
  assert.ok(Number.isFinite(Date.parse(result.data.receipt.submittedAt)));
}
async function createJob(suffix, open) {
  const before = await hr.snapshot();
  let state = await hr.action('createJob', {
    title: `候选人入口验收-${suffix}-${runId}`, department: '演示产品部', location: '上海', type: 'social',
    headcount: 1, managerId: 'manager', description: '仅用于候选人公开职位与自主投递接口验收的合成职位。',
    skills: ['SQL', '用户研究'], dimensions: ['专业能力'],
  });
  const created = state.jobs.find(item => !before.jobs.some(previous => previous.id === item.id));
  assert.ok(created);
  if (open) {
    await hr.action('jobStatus', { jobId: created.id, status: 'pending' });
    state = await manager.action('jobStatus', { jobId: created.id, status: 'open' });
  } else state = await hr.action('jobStatus', { jobId: created.id, status: 'closed' });
  return state.jobs.find(item => item.id === created.id);
}
function payload(overrides = {}) {
  return { jobId: primaryJob.id, candidate: fields, consent: true, requestId: randomUUID(), ...overrides };
}

async function main() {
  process.stdout.write(`Careers API smoke — ${baseUrl}\nSynthetic run: ${runId}\n`);
  await check('HR 和经理创建合成开放职位与已关闭对照职位', async () => {
    for (const session of [hr, manager]) await session.login();
    primaryJob = await createJob('主投递', true);
    secondJob = await createJob('跨岗对照', true);
    closedJob = await createJob('关闭对照', false);
    assert.equal(primaryJob.status, 'open');
    assert.equal(secondJob.status, 'open');
    assert.equal(closedJob.status, 'closed');
  });

  await check('匿名只读取开放职位白名单，内部招聘数据仍需登录', async () => {
    assert.equal((await anonymous.request('/api/recruitment')).status, 401);
    const result = await anonymous.request('/api/careers');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(keysOf(result.data), ['jobs']);
    const state = await hr.snapshot();
    const openJobs = state.jobs.filter(item => item.status === 'open');
    assert.deepEqual(result.data.jobs.map(item => item.id).sort(), openJobs.map(item => item.id).sort());
    for (const job of result.data.jobs) {
      assert.deepEqual(keysOf(job), [...jobFields].sort());
      const original = openJobs.find(item => item.id === job.id);
      assert.deepEqual(job, Object.fromEntries(jobFields.map(field => [field, original[field]])));
    }
    assert.ok(!result.data.jobs.some(item => item.id === closedJob.id));
    assert.equal(anonymous.cookie, '', 'Public reads must not create a business session');
  });

  await check('公开投递拒绝异常 JSON、外站来源且不修改数据', async () => {
    const before = await hr.snapshot();
    for (const body of ['{', 'null', '[]', '"text"']) {
      const response = await fetch(`${baseUrl}/api/careers`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'INVALID_JSON');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const response = await fetch(`${baseUrl}/api/careers`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' },
      body: JSON.stringify(payload()), signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 403);
    if (response.headers.get('content-type')?.includes('application/json')) assert.equal((await response.json()).error, 'INVALID_ORIGIN');
    else assert.equal((await response.text()).trim(), 'Forbidden');
    assert.equal((await hr.snapshot()).revision, before.revision);
  });

  await check('缺少同意、无效资料、无效请求号及不可投递职位均拒绝', async () => {
    const before = await hr.snapshot();
    for (const overrides of [
      { consent: false }, { consent: 'true' }, { consent: undefined },
      { jobId: `missing-${runId}` }, { jobId: closedJob.id },
      { requestId: '' }, { requestId: 'not-a-uuid' },
      { source: '内推' }, { stage: 'offer' },
      { candidate: null }, { candidate: [] },
      { candidate: { ...fields, candidateId: 'existing-candidate' } },
      ...[
        { name: '' }, { email: '' }, { email: 'not-an-email' }, { phone: '...' },
        { resume: '' }, { skills: 'SQL' }, { graduationYear: '2027' },
      ].map(change => ({ candidate: { ...fields, ...change } })),
    ]) rejected(await anonymous.request('/api/careers', payload(overrides)));
    const after = await hr.snapshot();
    assert.equal(after.revision, before.revision);
    assert.equal(after.candidates.length, before.candidates.length);
    assert.equal(after.applications.length, before.applications.length);
  });

  await check('无需登录提交简历，HR 收到待处理投递及准确来源', async () => {
    const before = await hr.snapshot();
    submission = payload();
    const result = await anonymous.request('/api/careers', submission);
    successful(result);
    receipt = result.data.receipt;
    const after = await hr.snapshot();
    assert.equal(after.applications.length, before.applications.length + 1);
    assert.equal(after.candidates.length, before.candidates.length + 1);
    application = after.applications.find(item => !before.applications.some(previous => previous.id === item.id));
    assert.ok(application);
    savedCandidate = after.candidates.find(item => item.id === application.candidateId);
    assert.ok(savedCandidate);
    assert.equal(application.jobId, primaryJob.id);
    assert.equal(application.stage, 'new');
    assert.equal(application.status, 'active');
    assert.equal(application.source, '候选人自助投递');
    for (const [key, value] of Object.entries(fields)) {
      assert.deepEqual(savedCandidate[key], value);
      assert.deepEqual(application.snapshot[key], value);
    }
    const serialized = JSON.stringify(result.data);
    for (const secret of [fields.email, fields.resume, savedCandidate.id, application.id]) assert.ok(!serialized.includes(secret));
    assert.equal(anonymous.cookie, '');
  });

  await check('同一请求重试返回原回执且不重复写入，内容变化与同岗重复拒绝', async () => {
    const before = await hr.snapshot();
    const retry = await anonymous.request('/api/careers', submission);
    successful(retry);
    assert.deepEqual(retry.data.receipt, receipt);
    assert.deepEqual(await hr.snapshot(), before);
    rejected(await anonymous.request('/api/careers', { ...submission, candidate: { ...fields, name: `${fields.name}-changed` } }), 409);
    rejected(await anonymous.request('/api/careers', payload()), 409);
    assert.deepEqual(await hr.snapshot(), before);
  });

  await check('同联系方式跨岗新建独立档案，保留既有主档和投递', async () => {
    const before = await hr.snapshot();
    const changedFields = { ...fields, name: `${fields.name}-跨岗`, school: '演示第二大学' };
    const result = await anonymous.request('/api/careers', payload({ jobId: secondJob.id, candidate: changedFields }));
    assert.ok([200, 201].includes(result.status), result.data.error || 'cross-job application failed');
    assert.deepEqual(keysOf(result.data), ['receipt']);
    assert.equal(result.data.receipt.jobTitle, secondJob.title);
    const after = await hr.snapshot();
    assert.equal(after.candidates.length, before.candidates.length + 1);
    assert.equal(after.applications.length, before.applications.length + 1);
    const other = after.applications.find(item => !before.applications.some(previous => previous.id === item.id));
    assert.ok(other);
    assert.notEqual(other.candidateId, application.candidateId);
    assert.equal(other.snapshot.school, changedFields.school);
    assert.equal(other.stage, 'new');
    assert.equal(other.source, '候选人自助投递');
    assert.deepEqual(after.candidates.find(item => item.id === savedCandidate.id), savedCandidate);
    assert.deepEqual(after.applications.find(item => item.id === application.id), application);
  });


  await check('同请求并发提交均返回同一回执且 CAS 仅保存一次', async () => {
    const before = await hr.snapshot();
    const candidate = { ...fields, name: `合成并发重试-${runId}`, email: `careers-replay-${runId}@example.com` };
    const request = payload({ candidate });
    const results = await Promise.all([
      anonymous.request('/api/careers', request),
      anonymous.request('/api/careers', request),
    ]);
    for (const result of results) successful(result);
    assert.deepEqual(results[0].data.receipt, results[1].data.receipt);
    const after = await hr.snapshot();
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.candidates.length, before.candidates.length + 1);
    assert.equal(after.applications.length, before.applications.length + 1);
    assert.equal(after.applications.filter(item => item.jobId === primaryJob.id && item.snapshot.email === candidate.email).length, 1);
  });

  await check('同联系方式双请求并发只接受一次且不生成重复投递', async () => {
    const before = await hr.snapshot();
    const candidate = { ...fields, name: `合成并发去重-${runId}`, email: `careers-dedupe-${runId}@example.com` };
    const results = await Promise.all([
      anonymous.request('/api/careers', payload({ candidate })),
      anonymous.request('/api/careers', payload({ candidate })),
    ]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    successful(results.find(item => item.status === 200));
    const duplicate = results.find(item => item.status === 409);
    rejected(duplicate, 409);
    assert.equal(duplicate.data.error, 'ALREADY_APPLIED');
    const after = await hr.snapshot();
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.candidates.length, before.candidates.length + 1);
    assert.equal(after.applications.length, before.applications.length + 1);
    assert.equal(after.applications.filter(item => item.jobId === primaryJob.id && item.snapshot.email === candidate.email).length, 1);
  });

  process.stdout.write(`\n${passed} careers API scenarios passed. Synthetic run: ${runId}.\nNo seed reset was performed; synthetic fixtures remain for review. Session cookies were not printed.\n`);
}

main().catch(error => {
  process.stderr.write(`\nFAIL after ${passed} passed scenarios (run ${runId}): ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
