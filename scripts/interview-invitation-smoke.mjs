import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run against a disposable local database seeded with demo data: BASE_URL=http://127.0.0.1:5184 node scripts/interview-invitation-smoke.mjs
// Reuses two synthetic legacy applications to avoid requesting real AI reviews. Their current contact emails are changed for these tests.
// Add --mail-disabled only for a local service with MAIL_MODE != live. Delivery is also gated by the server's mailReady=false.
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
const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const checkDisabledDelivery = process.argv.includes('--mail-disabled');
let passed = 0;

class Session {
  constructor(userId) { this.userId = userId; this.cookie = ''; }
  async request(path, body, headers = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers, ...siteHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65_000),
    });
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (cookies.length) this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {
      // Development middleware can reject foreign origins before the JSON route runs.
      if (!response.ok) data = { message: raw };
      else throw new Error(`${path.split('?')[0]} returned HTTP ${response.status} with non-JSON content`);
    }
    return { status: response.status, data };
  }
  async login() {
    const result = await this.request('/api/session', { userId: this.userId, password: process.env.DEMO_PASSWORD || 'Demo2026!' });
    assert.equal(result.status, 200, `Login ${this.userId} failed`);
    assert.equal(result.data.user.id, this.userId);
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
const interviewer = new Session('interviewer');
const admin = new Session('admin');
const anonymous = new Session('anonymous');
const meetingUrl = `https://meet.example.com/synthetic-${runId}`;
let job;
let primary;
let noEmail;

async function check(name, task) {
  await task(); passed++;
  process.stdout.write(`PASS ${String(passed).padStart(2, '0')} ${name}\n`);
}

async function inviteBody(action, interviewId, fields = {}) {
  return { action, interviewId, expectedRevision: (await hr.snapshot()).revision, ...fields };
}

async function scheduleCandidate(application, suffix, hasEmail = true) {
  let state = await hr.action('updateCandidate', { candidateId: application.candidateId, email: hasEmail ? `interview-${runId}-${suffix}@example.com` : '' });
  if (application.stage === 'screening') state = await hr.action('advance', { applicationId: application.id, note: 'HR 已核实合成履历中的岗位能力证据，安排进入面试。' });
  application = state.applications.find(item => item.id === application.id);
  assert.equal(application.stage, 'interview');
  assert.ok(application.screeningNote);
  const start = new Date(Date.now() + 14 * 86_400_000);
  start.setUTCHours(4, 0, 0, 0);
  while (state.interviews.some(item => item.status === 'scheduled' && Date.parse(item.start) < start.getTime() + 3_600_000 && Date.parse(item.end) > start.getTime())) start.setTime(start.getTime() + 2 * 3_600_000);
  const beforeSchedule = state;
  state = await hr.action('scheduleInterview', {
    applicationId: application.id, round: '合成综合面试', start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(),
    interviewerIds: ['interviewer'], location: meetingUrl,
  });
  const interview = state.interviews.find(item => !beforeSchedule.interviews.some(previous => previous.id === item.id));
  assert.ok(interview);
  assert.equal(interview.notified, false);
  assert.equal(interview.invitation, undefined);
  return { application, interview };
}

function expectStatus(result, status) {
  assert.equal(result.status, status, result.data.error || 'unexpected response status');
}

async function main() {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname), 'Run only against a disposable local demo database');
  if (checkDisabledDelivery) {
    assert.notEqual(process.env.MAIL_MODE, 'live', '--mail-disabled cannot run with MAIL_MODE=live');
  }
  process.stdout.write(`Interview invitation API smoke — ${baseUrl}\nSynthetic run: ${runId}\n`);
  await check('独立角色登录，HR 为两名已人工筛选的合成候选人安排面试', async () => {
    for (const session of [hr, manager, interviewer, admin]) await session.login();
    const state = await hr.snapshot();
    const legacy = state.applications.filter(item => {
      const candidate = state.candidates.find(person => person.id === item.candidateId);
      return /^application_\d+$/.test(item.id) && /^candidate_\d+$/.test(item.candidateId) &&
        !item.selection && item.status === 'active' && ['interview', 'screening'].includes(item.stage) &&
        candidate && /^1990000\d{4}$/.test(candidate.phone) && (!candidate.email || candidate.email.endsWith('@example.com'));
    }).sort((a, b) => Number(b.stage === 'interview') - Number(a.stage === 'interview'));
    const first = legacy[0], second = legacy.find(item => item.candidateId !== first?.candidateId);
    assert.ok(first && second, 'Expected two untouched synthetic legacy applications from the demo seed');
    job = state.jobs.find(item => item.id === first.jobId);
    assert.ok(job);
    primary = await scheduleCandidate(first, 'primary');
    noEmail = await scheduleCandidate(second, 'no-email', false);
  });

  await check('邮件预览含收件人、岗位、轮次、北京时间和会议链接，且不写入状态', async () => {
    const before = await hr.snapshot();
    const result = await hr.request('/api/interview-invitation', await inviteBody('previewInterviewInvitation', primary.interview.id));
    expectStatus(result, 200);
    const mail = result.data.mailPreview;
    assert.ok(mail);
    assert.equal(mail.to, `interview-${runId}-primary@example.com`);
    assert.ok(mail.subject.includes(job.title));
    for (const detail of ['合成综合面试', meetingUrl, '北京时间']) assert.ok(mail.text.includes(detail), `Preview must contain ${detail}`);
    const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
    for (const time of [primary.interview.start, primary.interview.end]) assert.ok(mail.text.includes(localTime.format(new Date(time))), 'Preview must show start and end times in Asia/Shanghai');
    for (const forbidden of [primary.application.snapshot.resume, primary.application.screeningNote].filter(Boolean)) assert.ok(!mail.text.includes(forbidden), 'Preview must not include private recruiting notes');
    assert.equal(typeof result.data.mailReady, 'boolean');
    if (checkDisabledDelivery) assert.equal(result.data.mailReady, false, 'Refusing send tests because server reports a live mail connection');
    assert.deepEqual(await hr.snapshot(), before);
    assert.equal(before.interviewInvitations, undefined);
    assert.ok(!JSON.stringify(result.data).includes('tokenHash'));
  });

  await check('缺少候选人邮箱时禁止预览和发送，不创建通知记录', async () => {
    const before = await hr.snapshot();
    for (const action of checkDisabledDelivery ? ['previewInterviewInvitation', 'sendInterviewInvitation'] : ['previewInterviewInvitation']) {
      const result = await hr.request('/api/interview-invitation', await inviteBody(action, noEmail.interview.id, { requestId: `invite_${randomUUID()}` }));
      expectStatus(result, 422);
    }
    assert.deepEqual(await hr.snapshot(), before);
  });

  await check('HR 补充主档邮箱后可预览新收件人，并保留本投递的原资格快照', async () => {
    const email = `interview-${runId}-corrected@example.com`;
    const originalSnapshot = (await hr.snapshot()).applications.find(item => item.id === noEmail.application.id).snapshot;
    const state = await hr.action('updateCandidate', { candidateId: noEmail.application.candidateId, email });
    assert.equal(state.candidates.find(item => item.id === noEmail.application.candidateId).email, email);
    assert.deepEqual(state.applications.find(item => item.id === noEmail.application.id).snapshot, originalSnapshot);
    const result = await hr.request('/api/interview-invitation', await inviteBody('previewInterviewInvitation', noEmail.interview.id));
    expectStatus(result, 200);
    assert.equal(result.data.mailPreview.to, email);
    assert.notEqual(result.data.mailPreview.to, originalSnapshot.email);
    assert.deepEqual(await hr.snapshot(), state);
  });

  await check('未登录和非 HR 无法预览或发信，失败不写状态', async () => {
    const before = await hr.snapshot();
    for (const action of ['previewInterviewInvitation', 'sendInterviewInvitation']) {
      const body = await inviteBody(action, primary.interview.id, { requestId: `invite_${randomUUID()}` });
      expectStatus(await anonymous.request('/api/interview-invitation', body), 401);
      for (const session of [manager, interviewer, admin]) expectStatus(await session.request('/api/interview-invitation', body), 403);
    }
    assert.deepEqual(await hr.snapshot(), before);
  });

  await check('旧 revision 的邮件预览拒绝并发覆盖', async () => {
    const before = await hr.snapshot();
    const result = await hr.request('/api/interview-invitation', { action: 'previewInterviewInvitation', interviewId: primary.interview.id, expectedRevision: before.revision - 1 });
    expectStatus(result, 409);
    assert.deepEqual(await hr.snapshot(), before);
  });

  await check('未知及格式错误令牌无需会话，GET/POST 均 Gone', async () => {
    const before = await hr.snapshot();
    for (const token of ['', 'invalid-token', 'f'.repeat(64)]) {
      expectStatus(await anonymous.request(`/api/interview-response?token=${encodeURIComponent(token)}`), 410);
      expectStatus(await anonymous.request('/api/interview-response', { token, expectedVersion: 0, response: 'confirmed' }), 410);
    }
    assert.deepEqual(await hr.snapshot(), before);
  });

  await check('邀请及候选人回复 POST 均拒绝跨域来源', async () => {
    const before = await hr.snapshot();
    const headers = { origin: 'https://other.example.com' };
    for (const action of ['previewInterviewInvitation', 'sendInterviewInvitation']) {
      const body = await inviteBody(action, primary.interview.id, { requestId: `invite_${randomUUID()}` });
      expectStatus(await hr.request('/api/interview-invitation', body, headers), 403);
    }
    expectStatus(await anonymous.request('/api/interview-response', { token: 'f'.repeat(64), expectedVersion: 0, response: 'confirmed' }, headers), 403);
    assert.deepEqual(await hr.snapshot(), before);
  });

  if (checkDisabledDelivery) {
    await check('未配置真实发信返回 503，面试不伪造已发送状态', async () => {
      const before = await hr.snapshot();
      const preview = await hr.request('/api/interview-invitation', await inviteBody('previewInterviewInvitation', primary.interview.id));
      expectStatus(preview, 200);
      assert.equal(preview.data.mailReady, false, 'Refusing send test because server reports a live mail connection');
      const result = await hr.request('/api/interview-invitation', await inviteBody('sendInterviewInvitation', primary.interview.id, { requestId: `invite_${randomUUID()}` }));
      expectStatus(result, 503);
      assert.deepEqual(await hr.snapshot(), before);
      const interview = before.interviews.find(item => item.id === primary.interview.id);
      assert.equal(interview.notified, false);
      assert.equal(interview.invitation, undefined);
    });
  } else process.stdout.write('SKIP 未配置发信检查（仅对确认关闭邮件能力的本地服务使用 --mail-disabled）\n');

  process.stdout.write(`\n${passed} interview invitation API scenarios passed. Synthetic fixtures remain for review.\nNo valid-recipient send was attempted against a mail-ready service. No token or cookie was printed.\nSuccessful delivery and candidate confirmation require separate domain or controlled mail-provider tests.\n`);
}

main().catch(error => { process.stderr.write(`\nFAIL after ${passed} passed scenarios (run ${runId}): ${error.stack || error.message}\n`); process.exitCode = 1; });
