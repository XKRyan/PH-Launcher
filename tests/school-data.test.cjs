const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const {
  SchoolDataClient, readUrl, safeSourceUrl, parseManageBacCourses,
  parseManageBacGrade, parseManageBacTasks, parseManageBacDeadlines, parseCourseFiles, parseTaskDetail,
  parseManageBacDiscussions, parseDiscussionDetail,
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
  assert.equal(readUrl('managebac', '/student/classes/21/discussions/31'), 'https://shph.managebac.cn/student/classes/21/discussions/31');
  assert.equal(readUrl('managebac', '/student/classes/21/discussions/31/attachments/7/file.pdf'), 'https://shph.managebac.cn/student/classes/21/discussions/31/attachments/7/file.pdf');
  assert.throws(() => readUrl('managebac', '/student/classes/21/discussions/31/replies', 'POST'), { code: 'URL_NOT_ALLOWED' });
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

test('discussion parsers expose bounded plain text, replies, and school-only attachment links', () => {
  const html = `<div class="discussion" id="discussion_31"><div class="h4 title"><a>Fieldwork notes</a></div><div class="author"><a>Teacher A</a> in <a>Biology</a></div><div class="fr-view">Main &lt;safe&gt; text</div><div class="attachment"><a href="/student/classes/21/discussions/31/attachments/7/notes.pdf">notes.pdf</a><a href="https://evil.test/attachments/8">evil.pdf</a></div></div><div class="reply private" id="reply_9"><div class="header">Student B | role Posted on Sunday at 5:13 PM Reply Edit</div><div class="fr-view">A reply</div></div><script>global.discussionExecuted=true</script>`;
  global.discussionExecuted = false;
  const list = parseManageBacDiscussions(html, '21');
  assert.equal(global.discussionExecuted, false);
  assert.deepEqual(list.discussions[0].attachments, [{ name: 'notes.pdf', url: 'https://shph.managebac.cn/student/classes/21/discussions/31/attachments/7/notes.pdf' }]);
  assert.equal(list.discussions[0].preview, 'Main <safe> text');
  const detail = parseDiscussionDetail(html, '21', '31');
  assert.equal(detail.main.body, 'Main <safe> text');
  assert.equal(detail.comments[0].body, 'A reply');
  assert.equal(detail.comments[0].private, true);
  delete global.discussionExecuted;
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

test('upstream three-anchor windows cover Friday afternoon and Sunday without extra requests', async () => {
  const anchors = [];
  const dayAt = (day, delta) => new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    if (url.endsWith('/user')) return response(identityHtml());
    if (url.includes('eb.php')) return response('<a href="?gpid=4&gsh=nonce">');
    const form = new URLSearchParams(init.body); const day = form.get('date'); anchors.push(day);
    assert.equal(form.get('dateto'), dayAt(day, 2));
    return response(JSON.stringify({ dates: Object.fromEntries([-1, 0, 1].map((delta) => [dayAt(day, delta), { plan: [lesson({ starttime: '14:00', endtime: '14:40' })] }])) }));
  } });
  const result = await client.syncEduPage({ weekStart: '2026-09-07' });
  assert.deepEqual(anchors, ['2026-09-07', '2026-09-10', '2026-09-13']);
  assert.equal(result.lessons.length, 7);
  assert.ok(result.lessons.some((item) => item.date === '2026-09-11' && item.start === '14:00'));
  assert.deepEqual(result.missingDates, []);
  assert.ok(result.lessons.every((item) => item.date >= '2026-09-07' && item.date <= '2026-09-13'));
});

test('course/task detail paths reject arbitrary IDs before touching network', async () => {
  let calls = 0;
  const client = new SchoolDataClient({ fetch: async () => { calls += 1; return response(''); } });
  await assert.rejects(client.getCourseDetail('../sessions'), { code: 'INVALID_ID' });
  await assert.rejects(client.getTaskDetail('21', '31?submit=1'), { code: 'INVALID_ID' });
  await assert.rejects(client.getCoreOverview('private'), { code: 'INVALID_ID' });
  await assert.rejects(client.getCourseDiscussions('../sessions'), { code: 'INVALID_ID' });
  await assert.rejects(client.getDiscussionDetail('21', '31?reply=1'), { code: 'INVALID_ID' });
  assert.equal(calls, 0);
});

test('discussion client uses fixed read-only list and detail paths', async () => {
  const paths = [];
  const listHtml = '<div class="discussion" id="discussion_31"><div class="h4 title">Topic</div><div class="fr-view">Preview</div></div>';
  const client = new SchoolDataClient({ now: fixedNow, fetch: async (site, url, init) => { paths.push({ url, method: init.method }); return response(listHtml); } });
  const list = await client.getCourseDiscussions('21');
  const detail = await client.getDiscussionDetail('21', '31');
  assert.equal(list.discussions[0].title, 'Topic');
  assert.equal(detail.main.body, 'Preview');
  assert.deepEqual(paths, [
    { url: 'https://shph.managebac.cn/student/classes/21/discussions', method: 'GET' },
    { url: 'https://shph.managebac.cn/student/classes/21/discussions/31', method: 'GET' },
  ]);
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
  return { context, document, click, api, get snapshot() { return snapshot; }, get syncCalls() { return syncCalls; }, get preferenceWrites() { return preferenceWrites; }, setSnapshot: (value) => { snapshot = value; } };
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
  harness.context.window.schoolUI.open('courses'); await settleUi();
  assert.equal(harness.document.querySelector('#schoolPage img'), null);
  assert.match(harness.document.querySelector('#schoolPage').textContent, /<img src=x onerror=evil\(\)>/);
});

test('school UI distinguishes unselected teaching groups from deliberately empty selection', async () => {
  const weekStart = currentMonday();
  const sample = { id: 'edupage:one', date: weekStart, start: '08:00', end: '08:40', course: 'Biology HL', teacher: 'Sample Teacher', room: 'A101', groups: ['G1'], groupKey: '0123456789abcdefabcd', cancelled: false };
  const snapshot = { edupage: { weekStart, accountKey: 'account1', fetchedAt: fixedNow().toISOString(), lessons: [sample], options: [{ key: sample.groupKey, label: 'Biology HL · G1' }], missingDates: [], warnings: [] }, managebac: null, preferences: {} };
  const harness = schoolUiHarness(snapshot); harness.context.window.schoolUI.mount(); await settleUi();
  assert.equal(harness.document.querySelectorAll('.school-lesson').length, 0);
  assert.equal(harness.document.querySelector('.school-timetable'), null);
  assert.match(harness.document.querySelector('#schoolPage').textContent, /先选择你的教学组/);
  harness.click('[data-school-action="groups"]'); harness.click('[data-school-action="save-groups"]'); await settleUi();
  assert.equal(harness.preferenceWrites, 1);
  assert.equal(harness.document.querySelectorAll('.school-lesson').length, 0);
  assert.ok(harness.document.querySelector('[data-school-action="import-plan"]').hasAttribute('disabled'));
});

test('school UI aggregates three overlapping lessons and opens the full conflict list', async () => {
  const weekStart = currentMonday();
  const make = (index, start, end) => ({ id: `lesson-${index}`, date: weekStart, start, end, course: `Course ${index}`, teacher: `Teacher ${index}`, room: `R${index}`, groups: [`G${index}`], groupKey: `g${index}`, cancelled: false });
  const lessons = [make(1, '08:00', '08:40'), make(2, '08:10', '08:50'), make(3, '08:20', '09:00')];
  const snapshot = { edupage: { weekStart, accountKey: 'a', fetchedAt: fixedNow().toISOString(), lessons, options: [], missingDates: [], warnings: [] }, managebac: null, preferences: { accountKey: 'a', groups: ['g1', 'g2', 'g3'], highlights: ['g2'] } };
  const harness = schoolUiHarness(snapshot); harness.context.window.schoolUI.mount(); await settleUi();
  assert.equal(harness.document.querySelectorAll('.school-lesson').length, 1);
  assert.match(harness.document.querySelector('.school-lesson-cluster').textContent, /3 门课程/);
  harness.click('[data-school-action="lesson-cluster"]');
  const dialog = harness.document.querySelector('dialog');
  assert.equal(dialog.querySelectorAll('.school-conflict-row').length, 3);
  assert.match(dialog.textContent, /Course 1/); assert.match(dialog.textContent, /Teacher 3/);
});

test('teaching-group chooser filters by search and never selects hidden results', async () => {
  const weekStart = currentMonday();
  const snapshot = { edupage: { weekStart, accountKey: 'a', fetchedAt: fixedNow().toISOString(), lessons: [], options: [
    { key: 'bio', course: 'Biology', label: 'Biology · G1 · Teacher A' },
    { key: 'math', course: 'Mathematics', label: 'Mathematics · G2 · Teacher B' },
  ], missingDates: [], warnings: [] }, managebac: null, preferences: {} };
  const harness = schoolUiHarness(snapshot); harness.context.window.schoolUI.mount(); await settleUi();
  harness.click('[data-school-action="groups"]');
  const input = harness.document.querySelector('[data-school-field="group-query"]'); input.value = 'math'; input.dispatchEvent(new harness.document.defaultView.Event('input', { bubbles: true }));
  assert.equal(harness.document.querySelectorAll('[data-school-group-option]:not([hidden])').length, 1);
  harness.click('[data-school-action="groups-all"]'); harness.click('[data-school-action="save-groups"]'); await settleUi();
  assert.deepEqual(Array.from(harness.snapshot.preferences.groups), ['math']);
  assert.equal(harness.preferenceWrites, 1);
});

test('course detail exposes read-only discussion list, text, replies, and attachment actions', async () => {
  const snapshot = { edupage: null, managebac: { fetchedAt: fixedNow().toISOString(), courses: [{ id: '21', name: 'Biology', grade: '6' }], tasks: [], warnings: [] }, preferences: {} };
  const harness = schoolUiHarness(snapshot);
  harness.api.course = async () => ({ id: '21', name: 'Biology', grade: '6', url: 'https://shph.managebac.cn/student/classes/21/units', units: '', tasks: [], files: [], events: [], warnings: [] });
  harness.api.discussions = async () => ({ courseId: '21', url: 'https://shph.managebac.cn/student/classes/21/discussions', discussions: [{ id: '31', title: '<Topic>', author: 'Teacher', category: 'Biology', preview: '<Preview>', attachments: [] }] });
  harness.api.discussion = async () => ({ courseId: '21', discussionId: '31', title: '<Topic>', url: 'https://shph.managebac.cn/student/classes/21/discussions/31', main: { author: 'Teacher', category: 'Biology', date: 'Today', body: '<Main>', attachments: [{ name: '<file>.pdf', url: 'https://shph.managebac.cn/attachments/7/download' }] }, comments: [{ id: '9', author: 'Student', date: 'Later', body: '<Reply>', attachments: [], private: false }] });
  harness.context.window.schoolUI.open('courses'); await settleUi();
  harness.click('[data-school-action="course"]'); harness.click('[data-school-action="consent"]'); await settleUi();
  assert.ok(harness.document.querySelector('[data-school-action="course-discussions"]'));
  harness.click('[data-school-action="course-discussions"]'); await settleUi();
  assert.match(harness.document.querySelector('dialog').textContent, /<Topic>/);
  harness.click('[data-school-action="discussion"]'); await settleUi();
  const dialog = harness.document.querySelector('dialog');
  assert.match(dialog.textContent, /<Main>/); assert.match(dialog.textContent, /<Reply>/);
  assert.equal(dialog.querySelector('script'), null);
  assert.ok(dialog.querySelector('[data-school-action="original"][data-url*="attachments"]'));
  assert.equal(dialog.querySelector('textarea,form'), null);
});

test('school UI shows login-expired errors instead of treating a failed sync as no classes', async () => {
  const empty = { edupage: null, managebac: null, preferences: {} };
  const harness = schoolUiHarness(empty); harness.api.sync = async () => { throw new Error('登录已过期，请重新登录'); };
  harness.context.window.schoolUI.mount(); await settleUi();
  harness.click('[data-school-action="sync"]'); harness.click('[data-school-action="consent"]'); await settleUi();
  assert.match(harness.document.querySelector('[role="alert"]').textContent, /登录已过期/);
  assert.ok(harness.document.querySelector('[data-school-action="account"]'));
});

// --- Tasks & Deadlines aggregate page (plain-text line algorithm) ---

const ddlPage = (rows) => `<html><body><main>${rows.map((row) => `<div>${row}</div>`).join('')}</main></body></html>`;

test('readUrl allows tasks_and_deadlines only with a known view parameter', () => {
  for (const view of ['upcoming', 'past', 'overdue']) {
    assert.equal(readUrl('managebac', `/student/tasks_and_deadlines?view=${view}`), `https://shph.managebac.cn/student/tasks_and_deadlines?view=${view}`);
  }
  for (const bad of ['/student/tasks_and_deadlines', '/student/tasks_and_deadlines?view=secret', '/student/tasks_and_deadlines?view=upcoming&page=2', '/student/tasks_and_deadlines?view=upcoming&x=1']) {
    assert.throws(() => readUrl('managebac', bad), { code: 'URL_NOT_ALLOWED' });
  }
  assert.throws(() => readUrl('managebac', '/student/tasks_and_deadlines?view=upcoming', 'POST'), { code: 'URL_NOT_ALLOWED' });
});

test('parseManageBacDeadlines: title/due/course/status lines with year inference and pseudo-title filtering', () => {
  const reference = new Date(2026, 8, 15, 10, 0); // Sep 15 2026 local
  const html = ddlPage([
    'Upcoming', 'Sep 12, 11:59 PM', // pseudo title (section header) must be dropped
    'Osmosis Lab Report', 'Sep 12, 11:59 PM', 'Biology HL', 'Pending',
    'Physics Problem Set', 'Sep 18, 8:00 AM', 'Physics SL', 'Submitted',
    'Privacy', 'Sep 20, 11:59 PM', // footer pseudo title
    'Spring Review', 'Jun 1, 11:59 PM', 'History HL', 'Pending', // month < current -> next year
  ]);
  const parsed = parseManageBacDeadlines(html, { category: 'upcoming', sourceUrl: 'https://shph.managebac.cn/student/tasks_and_deadlines?view=upcoming', reference });
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.items.length, 3);
  const [first, second, third] = parsed.items;
  assert.equal(first.title, 'Osmosis Lab Report');
  assert.equal(first.course, 'Biology HL');
  assert.equal(first.status, 'Pending');
  assert.equal(first.dueText, 'Sep 12, 11:59 PM');
  assert.equal(first.dueAt, new Date(2026, 8, 12, 23, 59).toISOString());
  assert.equal(second.title, 'Physics Problem Set');
  assert.equal(second.status, 'Submitted');
  assert.equal(second.dueAt, new Date(2026, 8, 18, 8, 0).toISOString());
  assert.equal(third.title, 'Spring Review');
  assert.equal(third.dueAt, new Date(2027, 5, 1, 23, 59).toISOString()); // next year inferred
});

test('parseManageBacDeadlines: overdue view resolves earlier years', () => {
  const reference = new Date(2026, 8, 15, 10, 0);
  const html = ddlPage(['Old Assignment', 'May 1, 11:59 PM', 'Biology HL', 'Overdue']);
  const parsed = parseManageBacDeadlines(html, { category: 'overdue', reference });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].dueAt, new Date(2026, 4, 1, 23, 59).toISOString());
  assert.equal(parsed.items[0].course, 'Biology HL');
});

test('SchoolDataClient.getDeadlines merges views, dedupes and sorts by due time', async () => {
  const upcoming = ddlPage([
    'Later Task', 'Sep 21, 8:00 AM', 'Mathematics AA HL', 'Pending',
    'Shared Task', 'Sep 12, 11:59 PM', 'Biology HL', 'Pending',
  ]);
  const overdue = ddlPage([
    'Shared Task', 'Sep 12, 11:59 PM', 'Biology HL', 'Pending', // duplicate across views
    'Earlier Missing', 'Sep 10, 11:59 PM', 'Physics SL', 'Missing',
  ]);
  const client = new SchoolDataClient({
    fetch: async (site, url) => {
      assert.equal(site, 'managebac');
      if (url.includes('view=upcoming')) return response(upcoming);
      if (url.includes('view=overdue')) return response(overdue);
      throw new Error(`unexpected url ${url}`);
    },
    now: () => new Date(2026, 8, 15, 10, 0),
    pause: async () => {},
  });
  const result = await client.getDeadlines();
  assert.deepEqual(result.items.map((item) => item.title), ['Earlier Missing', 'Shared Task', 'Later Task']);
  const shared = result.items.find((item) => item.title === 'Shared Task');
  assert.equal(shared.category, 'upcoming'); // first occurrence wins
  assert.ok(result.warnings.length === 0);
});

test('syncManageBac filters tasks older than 14 days even with text-only due dates', async () => {
  const coursesPage = '<ul id=\"f-menu\"><li class=\"f-menu-submenu-item\"><a href=\"/student/classes/101\"><span class=\"f-menu-submenu-link-title\">Biology HL</span></a></li></ul>';
  const unitsPage = '<div class=\"sidebar-items-list\"><div class=\"cell\">a</div><div class=\"cell\">b</div><div class=\"cell\">c</div><div class=\"cell\">Overall\n90\n(A)</div></div>';
  const card = (title, dueText, pastDue) => [
    '<div class=\"fusion-card-item short-assignment\">',
    '<div class=\"date-badge' + (pastDue ? ' past-due' : '') + '\"><span class=\"month\">' + dueText.split(' ')[0] + '</span><span class=\"day\">' + dueText.split(' ')[1].replace(',', '') + '</span></div>',
    '<div class=\"h4 title\"><a href=\"/student/classes/101/core_tasks/9' + title.length + '\">' + title + '</a></div>',
    '<span class=\"due-date\">Due ' + dueText + '</span>',
    '</div>',
  ].join('');
  const tasksPage = [
    card('Recent Task', 'Sep 12, 11:59 PM', false),
    card('Ancient Task', 'Jan 5, 11:59 PM', true),
    card('Far Future Task', 'Jun 1, 11:59 PM', false),
    '<div>No classes found</div>',
  ].join('');
  const client = new SchoolDataClient({
    fetch: async (site, url) => {
      if (url.includes('/student/classes/my')) return response(coursesPage);
      if (url.includes('/units')) return response(unitsPage);
      if (url.includes('/core_tasks')) return response(tasksPage);
      throw new Error('unexpected ' + url);
    },
    now: () => new Date(2026, 8, 15, 10, 0),
    pause: async () => {},
  });
  const result = await client.syncManageBac();
  const titles = result.tasks.map((task) => task.title);
  assert.ok(titles.includes('Recent Task'), 'within 14 days is kept');
  assert.ok(titles.includes('Far Future Task'), 'future within a year is kept');
  assert.ok(!titles.includes('Ancient Task'), 'older than 14 days is filtered out');
});

test('tasks view hides DDL older than 14 days even from stale cached snapshots', async () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const upcoming = new Date(Date.now() + 5 * 86400000).toISOString();
  const snapshot = { edupage: null, managebac: { fetchedAt: fixedNow().toISOString(), courses: [{ id: '21', name: 'Biology HL', grade: null }], tasks: [
    { id: 't1', title: 'Ancient Homework', course: 'Biology HL', dueAt: old, dueText: 'Aug 9, 11:59 PM' },
    { id: 't2', title: 'Recent Past Homework', course: 'Biology HL', dueAt: recent, dueText: 'Sep 13, 11:59 PM' },
    { id: 't3', title: 'Upcoming Homework', course: 'Biology HL', dueAt: upcoming, dueText: 'Sep 20, 11:59 PM' },
  ], warnings: [] }, preferences: {} };
  const harness = schoolUiHarness(snapshot);
  harness.context.window.schoolUI.mount(); await settleUi();
  harness.context.window.schoolUI.open('courses'); await settleUi();
  harness.click('[data-course-tab="tasks"]'); await settleUi();
  const page = harness.document.querySelector('#schoolPage').textContent;
  assert.match(page, /Recent Past Homework/);
  assert.match(page, /Upcoming Homework/);
  assert.doesNotMatch(page, /Ancient Homework/, 'DDL older than 14 days must not render');
});
