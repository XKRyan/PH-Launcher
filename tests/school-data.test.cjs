const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const {
  SchoolDataClient, readUrl, safeSourceUrl, parseManageBacCourses,
  parseManageBacGrade, parseManageBacTasks, parseCourseFiles, parseTaskDetail,
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
  // Replying is the one discussion write: POST to this exact path is allowed,
  // every other method and path stays read-only.
  assert.throws(() => readUrl('managebac', '/student/classes/21/discussions/31/replies', 'GET'), { code: 'URL_NOT_ALLOWED' });
  assert.equal(readUrl('managebac', '/student/classes/21/discussions/31/replies', 'POST'), 'https://shph.managebac.cn/student/classes/21/discussions/31/replies');
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

test('course parser reads explicit teacher labels only inside the matching course card', () => {
  const data = parseManageBacCourses('<section id="classes"><div data-class-id="21"><a href="/student/classes/21"><h3>Biology HL</h3></a><span data-teacher-name="Alex Wang"></span></div><div data-class-id="22"><a href="/student/classes/22"><h3>Geography</h3></a><span class="teacher-name">Casey Li</span></div></section>');
  assert.deepEqual(data.courses.map(course => course.teachers), [['Alex Wang'], ['Casey Li']]);
  const ambiguous = parseManageBacCourses('<section id="classes" data-class-id="21"><a href="/student/classes/21">Biology</a><a href="/student/classes/22">Geography</a><span class="teacher-name">Not assigned to either course</span></section>');
  assert.ok(ambiguous.courses.every(course => !course.teachers));
});

test('automatic course recognition prechecks unique groups, preserves manual subjects, and saves only on confirmation', async () => {
  const weekStart = currentMonday();
  const options = [
    { key: 'bio-sl', course: 'Biology SL', label: 'Biology SL · B' },
    { key: 'bio-hl', course: 'Biology HL', label: 'Biology HL · A' },
    { key: 'aa', course: 'Mathematics AA HL', label: 'Mathematics AA HL · C' },
    { key: 'geo-a', course: 'Geography', label: 'Geography · A' },
    { key: 'geo-b', course: 'Geography', label: 'Geography · B' },
  ];
  const snapshot = { edupage: { weekStart, accountKey: 'student-a', fetchedAt: new Date().toISOString(), lessons: [], options, missingDates: [], warnings: [] }, managebac: { courses: [{ name: 'Biology HL' }, { name: 'Mathematics Analysis and Approaches HL' }, { name: 'Geography' }] }, preferences: { accountKey: 'student-a', groups: ['bio-sl'] } };
  const harness = schoolUiHarness(snapshot); harness.context.window.schoolUI.mount(); await settleUi();
  harness.click('[data-school-action="auto-groups"]');
  assert.equal(harness.preferenceWrites, 0);
  const chosen = [...harness.document.querySelectorAll('[name="school-group"]:checked')].map(input => input.value);
  assert.deepEqual(chosen, ['bio-sl', 'aa']);
  assert.match(harness.document.querySelector('dialog').textContent, /geography/);
  harness.click('[data-school-action="save-groups"]'); await settleUi();
  assert.equal(harness.preferenceWrites, 1);
  assert.deepEqual(Array.from(harness.snapshot.preferences.groups), ['bio-sl', 'aa']);
});

test('course recognition cannot save a preview after switching school accounts', async () => {
  const weekStart = currentMonday();
  const data = { weekStart, accountKey: 'first', lessons: [], options: [{ key: 'bio', course: 'Biology', label: 'Biology' }], warnings: [] };
  const harness = schoolUiHarness({ edupage: data, managebac: { courses: [{ name: 'Biology' }] }, preferences: {}, epochs: { edupage: 0, managebac: 0 } });
  harness.context.window.schoolUI.mount(); await settleUi(); harness.click('[data-school-action="auto-groups"]');
  harness.setSnapshot({ edupage: { ...data, accountKey: 'second' }, managebac: null, preferences: {}, epochs: { edupage: 1, managebac: 1 } });
  await harness.context.window.schoolUI.refresh();
  harness.click('[data-school-action="save-groups"]'); await settleUi();
  assert.equal(harness.preferenceWrites, 0);
  assert.match(harness.document.querySelector('#schoolPage').textContent, /学校账号已变化/);
});

test('course recognition asks for ManageBac sync without starting a login or writing selections', async () => {
  const harness = schoolUiHarness({ edupage: { weekStart: currentMonday(), accountKey: 'first', lessons: [], options: [], warnings: [] }, managebac: null, preferences: {} });
  harness.context.window.schoolUI.mount(); await settleUi(); harness.click('[data-school-action="auto-groups"]');
  assert.match(harness.document.querySelector('dialog').textContent, /请先同步 ManageBac/);
  assert.equal(harness.syncCalls, 0); assert.equal(harness.preferenceWrites, 0);
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/school-selection-inference.js'), 'utf8'), context);
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
  assert.equal(harness.document.querySelector('[data-school-action="import-plan"]'), null, 'retired plan timetable has no import entry');
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
