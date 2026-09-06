const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const {
  SchoolDataClient, readUrl, safeSourceUrl, parseManageBacCourses,
  parseManageBacGrade, parseManageBacTasks, parseCourseFiles, parseTaskDetail,
  parseEduPageIdentity, parseEduPageNonce, parseEduPageEnvelope, eduRows,
} = require('../electron/school-data.cjs');

// Synthetic HTML/protocol fixtures: no student data or authenticated cookies.
const identityData = {
  userid: 'Student-42', userrow: { TriedaID: -7 },
  dbi: { subjects: { s1: { name: 'Biology HL' } }, teachers: { t1: { firstname: 'Sample', lastname: 'Teacher' } }, classrooms: { r1: { name: 'A101' } } },
};
const identityHtml = (data = identityData) => `<html><script>userhome(${JSON.stringify(data)});</script></html>`;
const lesson = (extra = {}) => ({ subjectid: 's1', classids: ['-7'], starttime: '08:00', endtime: '08:40', teacherids: ['t1'], classroomids: ['r1'], groupnames: ['G1'], type: 'lesson', uniperiod: '1', ...extra });
const classesHtml = `<div id="classes"><a href="/student/classes/21">Biology HL</a><a href="/student/classes/21/units">Units</a><a href="https://evil.test/student/classes/22">Foreign</a></div>`;
const tasksHtml = `<div class="fusion-card-item short-assignment"><h4 class="title"><a href="/student/classes/21/core_tasks/31">Ecology essay</a></h4><span class="due-date">Sep 12, 11:59 PM</span><span class="badge-label">Pending</span><div class="assessment task-score">6 / 7</div></div>`;
const fixedNow = () => new Date('2026-09-06T01:02:03Z');
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });

test('school transport allowlist rejects off-origin and write-like paths', () => {
  assert.equal(readUrl('managebac', '/student/classes/my?page=1'), 'https://shph.managebac.cn/student/classes/my?page=1');
  for (const value of ['https://shph.managebac.cn.evil.test/student/classes/my', 'http://shph.managebac.cn/student/classes/my', 'https://a:b@shph.managebac.cn/student/classes/my', '/student/classes/21/leave', '/sessions', '/student/classes/my?action=delete', '/student/classes/21/core_tasks/31?submit=1']) {
    assert.throws(() => readUrl('managebac', value), { code: 'URL_NOT_ALLOWED' });
  }
  assert.throws(() => readUrl('managebac', '/student/classes/21/units', 'POST'), { code: 'URL_NOT_ALLOWED' });
  assert.equal(safeSourceUrl('managebac', 'javascript:alert(1)'), '');
  assert.equal(safeSourceUrl('managebac', '/student/classes/21/leave'), '');
});

test('course HTML parser isolates links, never executes scripts, and ignores action labels', () => {
  global.schoolParserExecuted = false;
  const parsed = parseManageBacCourses(`${classesHtml}<script>global.schoolParserExecuted=true</script>`);
  assert.equal(global.schoolParserExecuted, false);
  assert.deepEqual(parsed.courses, [{ id: '21', name: 'Biology HL', url: 'https://shph.managebac.cn/student/classes/21/units' }]);
  delete global.schoolParserExecuted;
  assert.equal(parseManageBacCourses('<p>No classes found</p>').empty, true);
  assert.equal(parseManageBacCourses('<h1>Unexpected page</h1>').recognized, false);
  assert.throws(() => parseManageBacCourses('<input type="password">'), { code: 'LOGIN_REQUIRED' });
});

test('grade parser requires semantic label and cannot misread fourth sidebar cell', () => {
  assert.equal(parseManageBacGrade('<div class="sidebar-items-list"><div class="cell">Overall Grade <b>6</b></div></div>').grade, '6');
  assert.equal(parseManageBacGrade('<div class="sidebar-items-list"><div class="cell">Teacher</div><div class="cell">Room</div><div class="cell">Term</div><div class="cell">Students 27</div></div>').grade, null);
});

test('task parsing preserves ambiguous due dates instead of guessing a year', () => {
  const task = parseManageBacTasks(tasksHtml, { id: '21', name: 'Biology HL' }).tasks[0];
  assert.equal(task.id, 'managebac:21:31'); assert.equal(task.dueAt, '');
  assert.equal(task.dueText, 'Sep 12, 11:59 PM'); assert.equal(task.score, '6 / 7');
  assert.equal(parseManageBacTasks(tasksHtml, { id: '99' }).tasks.length, 0);
  const dated = tasksHtml.replace('<span class="due-date">', '<time datetime="2026-09-12T23:59:00+08:00"></time><span class="due-date">');
  assert.equal(parseManageBacTasks(dated, { id: '21' }).tasks[0].dueAt, '2026-09-12T15:59:00.000Z');
});

test('course files do not export temporary signed download credentials', () => {
  const files = parseCourseFiles(`<div class="row file" data-ec3-info='{"name":"Homework.pdf","download_url":"https://storage.test/a?secret=signed-token"}'></div>`, '21');
  assert.equal(files[0].name, 'Homework.pdf');
  assert.equal(files[0].url, 'https://shph.managebac.cn/student/classes/21/files');
  assert.doesNotMatch(JSON.stringify(files), /signed-token/);
});

test('task details return bounded plain text without form values', () => {
  const html = '<div class="core-task-show"><div class="fusion-card-item"><h4 class="title">Essay</h4><div class="badge-label">Pending</div></div><p>Explain biodiversity.</p><form><input value="sensitive"><textarea>private draft</textarea></form></div>';
  const parsed = parseTaskDetail(html);
  assert.equal(parsed.title, 'Essay'); assert.equal(parsed.description, 'Explain biodiversity.');
});

test('EduPage identity JSON is read without evaluating page scripts', () => {
  const parsed = parseEduPageIdentity(`${identityHtml()}<script>throw new Error('do not execute')</script>`);
  assert.equal(parsed.id, 'Student-42'); assert.equal(parsed.classId, '-7');
  assert.equal(parsed.accountKey.length, 20);
  assert.throws(() => parseEduPageIdentity('<input type=password>'), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => parseEduPageIdentity('<script>userhome({userid:(()=>steal())()})</script>'), { code: 'LOGIN_REQUIRED' });
  assert.deepEqual(parseEduPageNonce('<a href="?gpid=12&amp;gsh=nonceabc">'), { gpid: '13', gsh: 'nonceabc' });
});

test('EduPage RPC parser supports JSON nesting and rejects executable payloads', () => {
  const data = { dates: { '2026-09-07': { plan: [lesson({ note: 'braces } { and quote "' })] } } };
  assert.deepEqual(parseEduPageEnvelope(`call("Student-42",${JSON.stringify(data)},[]);`), data);
  assert.throws(() => parseEduPageEnvelope('alert(document.cookie)'), { code: 'PAGE_CHANGED' });
});

test('dated lesson normalization filters other classes and keeps cancellation/group identity', () => {
  const dates = { '2026-09-07': { plan: [lesson(), lesson({ classids: ['-99'] }), lesson({ starttime: '09:00', endtime: '09:40', removed: true, groupnames: ['G2'] }), lesson({ starttime: 'wrong' })] } };
  const parsed = eduRows(dates, parseEduPageIdentity(identityHtml()), ['2026-09-07']);
  assert.equal(parsed.lessons.length, 2); assert.equal(parsed.skipped, 1);
  assert.equal(parsed.lessons[0].teacher, 'Sample Teacher'); assert.equal(parsed.lessons[0].room, 'A101');
  assert.equal(parsed.lessons[1].cancelled, true); assert.equal(parsed.options.length, 2);
  assert.throws(() => eduRows(dates, { ...parseEduPageIdentity(identityHtml()), classId: '' }, ['2026-09-07']), { code: 'CLASS_UNKNOWN' });
});

test('transport stops login redirects and never forwards credentials to another host', async () => {
  const requests = [];
  const client = new SchoolDataClient({ fetch: async (...args) => { requests.push(args); return response('', 302, { location: 'https://evil.test/steal' }); } });
  await assert.rejects(client.request('managebac', '/student/classes/my'), { code: 'URL_NOT_ALLOWED' });
  assert.equal(requests.length, 1); assert.equal(requests[0][2].redirect, 'manual');
  const expired = new SchoolDataClient({ fetch: async () => response('', 302, { location: '/login' }) });
  await assert.rejects(expired.request('managebac', '/student/classes/my'), { code: 'LOGIN_REQUIRED' });
});

test('transport rejects every EduPage write action except fixed loadData', async () => {
  let requested = false;
  const client = new SchoolDataClient({ fetch: async () => { requested = true; return response('{}'); } });
  await assert.rejects(client.request('edupage', '/gcall', { method: 'POST', body: 'action=sendMessage&changes=%7B%7D' }), { code: 'WRITE_NOT_ALLOWED' });
  assert.equal(requested, false);
});

test('ManageBac sync uses existing injected session and emits complete bounded result', async () => {
  const requests = [];
  const client = new SchoolDataClient({ now: fixedNow, pause: async () => {}, fetch: async (site, url, init) => {
    requests.push({ site, url, init });
    if (url.endsWith('page=1')) return response(classesHtml);
    if (url.includes('page=')) return response('<p>No classes found</p>');
    if (url.endsWith('/units')) return response('<div class="sidebar-items-list"><div class="cell">Overall Grade 6</div></div>');
    return response(tasksHtml);
  } });
  const result = await client.syncManageBac();
  assert.equal(result.courses[0].grade, '6'); assert.equal(result.tasks[0].title, 'Ecology essay');
  assert.equal(result.fetchedAt, fixedNow().toISOString());
  assert.equal(requests.every((request) => request.init.method === 'GET' && request.init.credentials === 'include'), true);
  assert.equal(requests.some((request) => request.init.headers.Cookie), false);
});

test('EduPage week sync covers all seven dates even for single-day server windows', async () => {
  const requestedDates = [];
  const client = new SchoolDataClient({ now: fixedNow, pause: async () => {}, fetch: async (site, url, init) => {
    if (url.endsWith('/user')) return response(identityHtml());
    if (url.includes('eb.php')) return response('<a href="?gpid=4&gsh=nonce">');
    const form = new URLSearchParams(init.body); const day = form.get('date'); requestedDates.push(day);
    assert.equal(form.get('action'), 'loadData'); assert.equal(form.get('changes'), '{}'); assert.equal(form.get('user'), 'Student-42');
    return response(JSON.stringify({ dates: { [day]: { plan: day.endsWith('13') ? [] : [lesson()] } } }));
  } });
  const result = await client.syncEduPage({ weekStart: '2026-09-07' });
  assert.equal(requestedDates.length, 7); assert.equal(result.lessons.length, 6);
  assert.deepEqual(result.missingDates, []); assert.equal(result.options.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /nonce|Student-42|dbi/);
  await assert.rejects(client.syncEduPage({ weekStart: '2026-99-99' }), { code: 'INVALID_DATE' });
});

test('EduPage sync detects account changes instead of mixing account data', async () => {
  let identityReads = 0;
  const dates = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`2026-09-${String(7 + index).padStart(2, '0')}`, { plan: [lesson()] }]));
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url) => {
    if (url.endsWith('/user')) { identityReads += 1; return response(identityHtml(identityReads === 1 ? identityData : { ...identityData, userid: 'Student-99' })); }
    if (url.includes('eb.php')) return response('<a href="?gpid=4&gsh=nonce">');
    return response(JSON.stringify({ dates }));
  } });
  await assert.rejects(client.syncEduPage({ weekStart: '2026-09-07' }), { code: 'ACCOUNT_CHANGED' });
});

test('course/task detail paths reject arbitrary IDs before touching network', async () => {
  let calls = 0;
  const client = new SchoolDataClient({ fetch: async () => { calls += 1; return response(''); } });
  await assert.rejects(client.getCourseDetail('../sessions'), { code: 'INVALID_ID' });
  await assert.rejects(client.getTaskDetail('21', '31?submit=1'), { code: 'INVALID_ID' });
  await assert.rejects(client.getCoreOverview('private'), { code: 'INVALID_ID' });
  assert.equal(calls, 0);
});

function schoolUiHarness(initialSnapshot) {
  const { window } = parseHTML('<html><body><section id="schoolPage"></section></body></html>');
  const document = window.document;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  let snapshot = initialSnapshot;
  let syncCalls = 0;
  let preferenceWrites = 0;
  const api = {
    get: async () => snapshot,
    sync: async () => { syncCalls += 1; return snapshot; },
    preferences: async (change) => { preferenceWrites += 1; snapshot = { ...snapshot, preferences: { ...snapshot.preferences, ...change, accountKey: snapshot.edupage?.accountKey } }; return snapshot; },
  };
  const bridge = { school: api, system: { openUrl: async () => {} } };
  const context = { window: { ph: bridge, openSite: async () => {} }, document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/school-ui.js'), 'utf8'), context);
  const click = (selector) => { const node = document.querySelector(selector); assert.ok(node, `missing ${selector}`); node.dispatchEvent(new window.Event('click', { bubbles: true })); };
  return { context, document, click, api, get syncCalls() { return syncCalls; }, get preferenceWrites() { return preferenceWrites; }, setSnapshot: (value) => { snapshot = value; } };
}
const settleUi = () => new Promise((resolve) => setImmediate(resolve));
function currentMonday() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

test('school UI mounts with explicit consent, no automatic school requests, and escaped course names', async () => {
  const harness = schoolUiHarness({ edupage: null, managebac: { fetchedAt: fixedNow().toISOString(), courses: [{ id: '21', name: '<img src=x onerror=evil()>', grade: '6' }], tasks: [], warnings: [] }, preferences: {} });
  harness.context.window.schoolUI.mount(); await settleUi();
  assert.equal(harness.syncCalls, 0);
  harness.click('[data-school-action="sync"]');
  assert.match(harness.document.querySelector('dialog').textContent, /不会自动发送给 AI/);
  assert.equal(harness.syncCalls, 0);
  harness.click('[data-school-action="consent"]'); await settleUi();
  assert.equal(harness.syncCalls, 1);
  harness.click('[data-tab="courses"]');
  assert.equal(harness.document.querySelector('#schoolPage img'), null);
  assert.match(harness.document.querySelector('#schoolPage').textContent, /<img src=x onerror=evil\(\)>/);
});

test('school UI distinguishes unselected teaching groups from deliberately empty selection', async () => {
  const weekStart = currentMonday();
  const sample = { id: 'edupage:one', date: weekStart, start: '08:00', end: '08:40', course: 'Biology HL', teacher: 'Sample Teacher', room: 'A101', groups: ['G1'], groupKey: '0123456789abcdefabcd', cancelled: false };
  const snapshot = { edupage: { weekStart, accountKey: 'account1', fetchedAt: fixedNow().toISOString(), lessons: [sample], options: [{ key: sample.groupKey, label: 'Biology HL · G1' }], missingDates: [], warnings: [] }, managebac: null, preferences: {} };
  const harness = schoolUiHarness(snapshot); harness.context.window.schoolUI.mount(); await settleUi();
  assert.equal(harness.document.querySelectorAll('.school-lesson').length, 1);
  assert.match(harness.document.querySelector('#schoolPage').textContent, /尚不是你的个人课表/);
  harness.click('[data-school-action="groups"]'); harness.click('[data-school-action="save-groups"]'); await settleUi();
  assert.equal(harness.preferenceWrites, 1);
  assert.equal(harness.document.querySelectorAll('.school-lesson').length, 0);
  assert.ok(harness.document.querySelector('[data-school-action="import-plan"]').hasAttribute('disabled'));
});

test('school UI shows login-expired errors instead of treating a failed sync as no classes', async () => {
  const empty = { edupage: null, managebac: null, preferences: {} };
  const harness = schoolUiHarness(empty); harness.api.sync = async () => { throw new Error('登录已过期，请重新登录'); };
  harness.context.window.schoolUI.mount(); await settleUi();
  harness.click('[data-school-action="sync"]'); harness.click('[data-school-action="consent"]'); await settleUi();
  assert.match(harness.document.querySelector('[role="alert"]').textContent, /登录已过期/);
  assert.ok(harness.document.querySelector('[data-school-action="login"]'));
});
