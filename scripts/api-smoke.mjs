import assert from 'node:assert/strict';

// Run against a disposable demo database: BASE_URL=http://127.0.0.1:5173 node scripts/api-smoke.mjs
// Pass --reset to replace existing demo data with the supplied seed before testing.
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const password = process.env.DEMO_PASSWORD || 'Demo2026!';
const runId = Date.now().toString(36);
let passed = 0;

class Session {
  constructor(userId) { this.userId = userId; this.cookie = ''; }

  async request(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (cookies.length) this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`${path}: HTTP ${response.status}, expected JSON; received ${raw.slice(0, 300)}`); }
    return { status: response.status, data };
  }

  async login() {
    const result = await this.request('/api/session', { userId: this.userId, password });
    assert.equal(result.status, 200, `Login ${this.userId}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.user.id, this.userId);
    assert.ok(this.cookie, `Login ${this.userId} must set a session cookie`);
    return this;
  }

  async snapshot() {
    const result = await this.request('/api/recruitment');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.user.id, this.userId);
    assert.equal(typeof result.data.state.revision, 'number');
    return result.data.state;
  }

  async action(action, fields = {}, expectedStatus = 200, expectedRevision) {
    const revision = expectedRevision ?? (await this.snapshot()).revision;
    const result = await this.request('/api/recruitment', { action, expectedRevision: revision, ...fields });
    if (expectedStatus === 'rejected') assert.ok(result.status >= 400 && result.status < 500, `${action} should reject invalid input, got ${result.status}: ${JSON.stringify(result.data)}`);
    else assert.equal(result.status, expectedStatus, `${action}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
}

const hr = new Session('hr');
const manager = new Session('manager');
const interviewer = new Session('interviewer');
const interviewer2 = new Session('interviewer2');
const admin = new Session('admin');

function check(name, task) {
  return task().then(() => { passed += 1; process.stdout.write(`PASS ${String(passed).padStart(2, '0')} ${name}\n`); });
}

function candidateFields(suffix, overrides = {}) {
  return {
    name: `验收候选人${suffix}`, email: `smoke-${runId}-${suffix}@example.com`, phone: `139${String(Date.now()).slice(-8)}`,
    school: '演示大学', major: '计算机科学', graduationYear: null, skills: ['TypeScript', 'SQL'],
    resume: '仅用于系统验收的合成简历；具备 TypeScript 和 SQL 项目经验。', availability: '两周内可到岗', ...overrides,
  };
}

async function createCandidate(jobId, fields, source = '内推') {
  const before = await hr.snapshot();
  await hr.action('createCandidate', { ...fields, jobId, source });
  const after = await hr.snapshot();
  const application = after.applications.find(item => item.jobId === jobId && !before.applications.some(previous => previous.id === item.id));
  assert.ok(application, 'Candidate creation must create an independent application');
  return { application, candidate: after.candidates.find(item => item.id === application.candidateId) };
}

async function createOpenJob(suffix, type = 'social') {
  const before = await hr.snapshot();
  await hr.action('createJob', {
    title: `验收${suffix}-${runId}`, department: '产品研发中心', location: '上海', type,
    batch: type === 'campus' ? '2027 校园招聘' : '', graduationYears: type === 'campus' ? [2027] : [],
    headcount: 2, ownerId: 'hr', managerId: 'manager',
    description: '用于验收招聘流程的合成职位。需要具备结构化分析、沟通协作与项目交付能力。',
    skills: ['TypeScript', 'SQL'], dimensions: ['专业能力', '协作沟通', '问题解决'],
  });
  let state = await hr.snapshot();
  const job = state.jobs.find(item => !before.jobs.some(previous => previous.id === item.id));
  assert.ok(job, 'Job creation must persist the new job');
  if (job.status === 'draft') await hr.action('jobStatus', { jobId: job.id, status: 'pending' });
  state = await hr.snapshot();
  if (state.jobs.find(item => item.id === job.id).status !== 'open') await manager.action('jobStatus', { jobId: job.id, status: 'open' });
  return (await hr.snapshot()).jobs.find(item => item.id === job.id);
}

function applicationOf(state, id) {
  const application = state.applications.find(item => item.id === id);
  assert.ok(application, `Missing application ${id}`);
  return application;
}

async function main() {
  process.stdout.write(`Recruitment API smoke — ${baseUrl}\nSynthetic run: ${runId}\n`);
  await check('未登录请求被拒绝', async () => {
    const result = await new Session('anonymous').request('/api/recruitment');
    assert.equal(result.status, 401);
  });
  await check('错误密码被拒绝，各角色使用独立会话', async () => {
    const invalid = await new Session('hr').request('/api/session', { userId: 'hr', password: 'incorrect-demo-password' });
    assert.equal(invalid.status, 401);
    for (const session of [hr, manager, interviewer, interviewer2, admin]) await session.login();
    for (const session of [hr, manager, interviewer, interviewer2, admin]) await session.snapshot();
    assert.equal(new Set([hr, manager, interviewer, interviewer2, admin].map(session => session.cookie)).size, 5);
  });
  if (process.argv.includes('--reset')) {
    await hr.action('reset');
    process.stdout.write('Demo seed reset before smoke test.\n');
  }

  await check('管理员不能读取候选人、投递和面试内容', async () => {
    const state = await admin.snapshot();
    for (const field of ['candidates', 'applications', 'interviews', 'scorecards', 'imports']) assert.equal(state[field].length, 0, `${field} must be empty for admin`);
    await admin.action('createJob', {}, 403);
  });

  let socialJob;
  let campusJob;
  await check('社招与校招职位创建、审批后开放', async () => {
    socialJob = await createOpenJob('社招');
    campusJob = await createOpenJob('校招', 'campus');
    assert.equal(socialJob.status, 'open');
    assert.equal(campusJob.type, 'campus');
    assert.deepEqual(campusJob.graduationYears, [2027]);
  });

  let mainApplication;
  let sharedFields;
  await check('校招生未知毕业届别可保存', async () => {
    sharedFields = candidateFields('主流程');
    const created = await createCandidate(campusJob.id, sharedFields, '校园宣讲');
    mainApplication = created.application;
    assert.equal(created.candidate.graduationYear, null);
  });

  await check('同一候选人多岗投递保持独立', async () => {
    const before = await hr.snapshot();
    await hr.action('createApplication', { candidateId: mainApplication.candidateId, jobId: socialJob.id, source: '人才库明确关联' });
    const after = await hr.snapshot();
    const second = after.applications.find(item => !before.applications.some(previous => previous.id === item.id));
    assert.ok(second);
    assert.equal(second.candidateId, mainApplication.candidateId, 'Explicit association must reuse the selected candidate');
    assert.notEqual(second.id, mainApplication.id);
    assert.equal(after.candidates.length, before.candidates.length);
    assert.equal(applicationOf(after, mainApplication.id).stage, mainApplication.stage);
  });

  await check('同岗重复关联幂等，重复联系方式不会自动合并', async () => {
    const before = await hr.snapshot();
    await hr.action('createApplication', { candidateId: mainApplication.candidateId, jobId: campusJob.id, source: '重复关联不应覆盖原投递' });
    const after = await hr.snapshot();
    assert.equal(after.applications.length, before.applications.length);
    assert.deepEqual(applicationOf(after, mainApplication.id), applicationOf(before, mainApplication.id));
    await hr.action('createCandidate', { ...sharedFields, jobId: campusJob.id, source: '官网' }, 409);
  });

  await check('缺少筛选证据时不能推进到面试', async () => {
    await hr.action('advance', { applicationId: mainApplication.id, note: '开始进行简历初筛。' });
    assert.equal(applicationOf(await hr.snapshot(), mainApplication.id).stage, 'screening');
    await hr.action('advance', { applicationId: mainApplication.id, note: '' }, 'rejected');
    assert.equal(applicationOf(await hr.snapshot(), mainApplication.id).stage, 'screening');
  });

  await check('旧 revision 请求返回 409，保留已提交变更', async () => {
    const oldRevision = (await hr.snapshot()).revision;
    await hr.action('advance', { applicationId: mainApplication.id, note: '简历包含两项可核验项目经验，达到岗位要求，进入面试。' });
    await hr.action('closeApplication', { applicationId: mainApplication.id, outcome: 'withdrawn', reason: '此请求仅用于检测并发，不应生效。' }, 409, oldRevision);
    assert.equal(applicationOf(await hr.snapshot(), mainApplication.id).stage, 'interview');
    assert.equal(applicationOf(await hr.snapshot(), mainApplication.id).status, 'active');
  });

  let interview;
  await check('安排面试并完成两位面试官独立评价', async () => {
    const before = await hr.snapshot();
    const start = new Date(Date.now() + 10 * 86_400_000); start.setUTCHours(2, 0, 0, 0);
    while (before.interviews.some(item => item.status === 'scheduled' && Date.parse(item.start) < start.getTime() + 3_600_000 && Date.parse(item.end) > start.getTime())) start.setTime(start.getTime() + 2 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    await hr.action('scheduleInterview', { applicationId: mainApplication.id, round: '综合面试', start: start.toISOString(), end: end.toISOString(), interviewerIds: ['interviewer', 'interviewer2'], location: '线上会议（演示）', confirmed: true });
    const state = await hr.snapshot();
    interview = state.interviews.find(item => !before.interviews.some(previous => previous.id === item.id));
    assert.ok(interview);
    const restricted = (await interviewer.snapshot()).candidates.find(item => item.id === mainApplication.candidateId);
    assert.ok(restricted);
    assert.equal(restricted.email, '');
    assert.equal(restricted.phone, '');
    await hr.action('interviewStatus', { interviewId: interview.id, status: 'completed' });
    for (const session of [interviewer, interviewer2]) {
      if (session === interviewer2) assert.equal((await session.snapshot()).scorecards.filter(item => item.interviewId === interview.id).length, 0, 'Peer feedback must stay hidden until own review is submitted');
      await session.action('submitScorecard', { interviewId: interview.id, ratings: Object.fromEntries(campusJob.dimensions.map(dimension => [dimension, 4])), evidence: '候选人清晰解释项目中的数据结构选择、性能瓶颈和实际改善结果，并在情境题中展示跨团队沟通方法。', recommendation: 'hire' });
    }
    const cards = (await hr.snapshot()).scorecards.filter(item => item.interviewId === interview.id && item.status === 'submitted');
    assert.equal(cards.length, 2);
    assert.equal(new Set(cards.map(item => item.userId)).size, 2);
  });

  await check('用人经理确认录用后由 HR 发 Offer', async () => {
    await hr.action('sendOffer', { applicationId: mainApplication.id, deadline: new Date(Date.now() + 20 * 86_400_000).toISOString(), reference: `DEMO-${runId}` }, 'rejected');
    await manager.action('decision', { applicationId: mainApplication.id, decision: 'hire', note: '面试结论及岗位能力证据完整，同意录用。' });
    let application = applicationOf(await hr.snapshot(), mainApplication.id);
    assert.equal(application.decision, 'hire');
    const deadline = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await hr.action('sendOffer', { applicationId: mainApplication.id, deadline, reference: `DEMO-${runId}` });
    application = applicationOf(await hr.snapshot(), mainApplication.id);
    assert.equal(application.offer.status, 'sent');
  });

  const joinDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await check('接受 Offer 进入待入职，但不计为已入职', async () => {
    await hr.action('offerResponse', { applicationId: mainApplication.id, status: 'accepted', plannedJoinDate: joinDate });
    const application = applicationOf(await hr.snapshot(), mainApplication.id);
    assert.equal(application.offer.status, 'accepted');
    assert.equal(application.stage, 'onboarding');
    assert.notEqual(application.status, 'joined');
    assert.equal(application.joinedAt, '');
  });

  await check('校招协议签署不触发实际入职', async () => {
    await hr.action('agreement', { applicationId: mainApplication.id, type: '三方协议', status: 'signed', date: new Date().toISOString().slice(0, 10), note: '合成三方协议记录，仅用于验收。' });
    const application = applicationOf(await hr.snapshot(), mainApplication.id);
    assert.equal(application.agreement.status, 'signed');
    assert.notEqual(application.status, 'joined');
    assert.equal(application.joinedAt, '');
  });

  await check('实际入职必须单独确认，并保留各阶段审计轨迹', async () => {
    await hr.action('join', { applicationId: mainApplication.id, date: new Date().toISOString().slice(0, 10) });
    const state = await hr.snapshot();
    const application = applicationOf(state, mainApplication.id);
    assert.equal(application.status, 'joined');
    assert.equal(application.stage, 'joined');
    assert.ok(application.joinedAt);
    assert.ok(state.events.filter(item => item.applicationId === mainApplication.id).length >= 6);
  });

  await check('CSV 导入部分成功，重复提交幂等', async () => {
    const before = await hr.snapshot();
    const validEmail = `smoke-${runId}-csv@example.com`;
    const validPhone = `138${String(Date.now()).slice(-8)}`;
    const csv = [
      'name,email,phone,school,major,graduationYear,skills,resume',
      `导入有效候选人,${validEmail},${validPhone},演示大学,软件工程,2027,TypeScript,合成简历用于验收`,
      '导入无效候选人,invalid-email,13812345679,演示大学,软件工程,2027,SQL,合成无效数据',
      `重复候选人,${sharedFields.email},${sharedFields.phone},演示大学,计算机科学,,SQL,重复投递不应创建`,
    ].join('\n');
    await hr.action('importPreview', { jobId: campusJob.id, csv });
    let state = await hr.snapshot();
    const preview = state.imports.find(item => !before.imports.some(previous => previous.id === item.id));
    assert.ok(preview, 'Preview must persist an import batch');
    assert.ok(preview.rows.some(item => item.status === 'error'), 'Invalid row should be visible');
    assert.ok(preview.rows.some(item => item.candidateId === mainApplication.candidateId && item.status === 'duplicate'), 'Existing contacts require explicit association at preview');
    await hr.action('importCommit', { importId: preview.id, linkDuplicates: false });
    state = await hr.snapshot();
    const committed = state.imports.find(item => item.id === preview.id);
    assert.equal(committed.rows.filter(item => item.status === 'success').length, 1);
    assert.equal(state.applications.length, before.applications.length + 1);
    const committedCount = state.applications.length;
    await hr.action('importCommit', { importId: preview.id, linkDuplicates: false });
    state = await hr.snapshot();
    assert.equal(state.applications.length, committedCount, 'Retry must not duplicate an imported application');
    assert.equal(state.candidates.filter(item => item.email === validEmail).length, 1);
  });

  process.stdout.write(`\n${passed} API scenarios passed. Synthetic smoke data remains available for review.\nThis is a focused demo smoke suite, not proof that the full Spec acceptance matrix passed.\n`);
}

main().catch(error => {
  process.stderr.write(`\nFAIL after ${passed} passed scenarios: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
