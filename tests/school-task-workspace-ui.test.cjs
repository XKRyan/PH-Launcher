'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('My courses remembers timetable on re-entry and a fresh renderer; explicit notifications still open tasks', async()=>{
 const ui=harness();await ui.open();ui.click('[data-course-tab="timetable"]');await settle();await settle();
 assert.equal(ui.snapshot().preferences.courseView.tab,'timetable');
 await ui.window.schoolUI.open('courses');await settle();
 assert.equal(ui.document.querySelector('[data-course-tab="timetable"]').getAttribute('aria-current'),'page');
 const fresh=harness();fresh.setSnapshot(JSON.parse(JSON.stringify(ui.snapshot())));
 fresh.window.schoolUI.open('courses');await settle();await settle();
 assert.equal(fresh.document.querySelector('[data-course-tab="timetable"]').getAttribute('aria-current'),'page');
 fresh.window.schoolUI.openTasks();await settle();
 assert.equal(fresh.document.querySelector('[data-course-tab="tasks"]').getAttribute('aria-current'),'page');
});
test('course detail section restores on restart and a changed account does not reopen the old class', async()=>{
 const ui=harness();await ui.open();ui.click('[data-course-tab="courses"]');ui.click('[data-school-action="course"][data-id="21"]');await settle();ui.click('[data-tab="files"]');await settle();await settle();
 const saved=JSON.parse(JSON.stringify(ui.snapshot()));assert.equal(saved.preferences.courseView.section,'files');
 for(const changed of [false,true]){
   const next=harness();const snapshot=JSON.parse(JSON.stringify(saved));if(changed)snapshot.managebac.accountKey='other';next.setSnapshot(snapshot);
   next.window.schoolUI.open('courses');await settle();await settle();
   if(changed){assert.equal(next.calls.course.length,0);assert.ok(next.document.querySelector('.school-course-card'));}
   else{assert.equal(next.document.querySelector('[data-tab="files"]').getAttribute('aria-current'),'page');assert.equal(next.calls.course[0],'21');}
 }
});

test('unified Tasks displays event details without a submission request and keeps all types together', async () => {
  const ui = harness();
  ui.snapshot().managebac.tasks = [
    { id:'21:11', courseId:'21', title:'Exam upload', category:'Assessment', submissionRequired:true },
    { id:'21:12', courseId:'21', title:'Read chapter', category:'Coursework', submissionRequired:false },
    { id:'managebac:event:21:13', courseId:'21', title:'Assembly', kind:'event', category:'Event', start:'2099-01-01', dueAt:'2099-01-01T00:00:00+08:00', submissionRequired:false, description:'Main hall' }
  ];
  await ui.open();
  assert.equal(ui.document.querySelectorAll('.school-task-row').length,3);
  assert.equal(ui.document.querySelector('[data-course-tab="tasks"]').textContent,'任务');
  ui.window.i18n.apply('en');
  assert.equal(ui.document.querySelector('[data-course-tab="tasks"]').textContent,'Tasks');
  assert.match(ui.document.querySelector('#schoolPage').textContent,/Assessment.*Submission required/);
  assert.match(ui.document.querySelector('#schoolPage').textContent,/Coursework.*No submission required/);
  ui.click('[data-school-action="calendar-task"]');
  assert.match(ui.document.querySelector('dialog').textContent,/Main hall/);
  assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]'),null);
  assert.equal(ui.calls.task.length,0);
  ui.click('dialog [data-school-action="close"]');
  assert.equal(ui.document.querySelectorAll('.school-task-row').length,3);
});
test('no-upload and unknown task details do not offer an unsupported file picker', async () => {
  for (const submissionRequired of [false, null]) {
    const ui=harness({task:async()=>({title:'Read chapter',submissionRequired,uploadAvailable:false,attachments:[]})});
    await ui.open(); await ui.openTask();
    assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]'),null);
    assert.equal(ui.calls.prepare.length,0);
  }
});

function harness(overrides = {}) {
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  const document = window.document;
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.setSelectionRange = function (start, end) { this.selectionStart = start; this.selectionEnd = end; };
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const courses = [{ id: '21', name: '保存', grade: '6' }, { id: '22', name: 'Biology', grade: '5' }];
  const tasks = ['not submitted', 'unsubmitted', 'incomplete', 'not yet completed', 'Submit', 'Submitted', 'Completed', 'Graded', '未提交', '已完成'].map((status, index) => ({
    id: `21:${index + 1}`, courseId: '21', course: '保存', title: `Task ${index + 1}`, status,
    dueAt: new Date(Date.now() + (index === 0 || index === 5 ? -1 : 1) * 86400000).toISOString()
  }));
  tasks.push({ id: '22:90', courseId: '22', course: 'Biology', title: 'Cells', status: 'Pending' });
  let snapshot = { managebac: { courses, tasks, accountKey: 'synthetic-a', fetchedAt: new Date().toISOString() }, edupage: null, preferences: {}, accounts: { managebac: { saved: true } }, epochs: { managebac: 1 }, status: {} };
  const calls = { prepare: [], submit: [], cancel: [], course: [], task: [] };
  const detail = (courseId, taskId) => ({ uploadAvailable: true, submissionRequired: true, courseId, taskId, title: '关闭', status: 'not submitted', description: '保存\n\nSecond paragraph <script>unsafe()</script>', attachments: [{ name: '<img src=x onerror=unsafe()>', url: 'https://shph.managebac.cn/files/42?name="quoted"' }, { name: 'Original attachment', url: 'https://shph.managebac.cn/student/classes/21/tasks/1', originalPage: true }], url: `https://shph.managebac.cn/student/classes/${courseId}/tasks/${taskId}` });
  const school = {
    timetable:overrides.timetable,
    get: async () => snapshot, sync: async () => snapshot,
    preferences: async (change) => { snapshot.preferences = { ...snapshot.preferences, ...change }; return snapshot; },
    task: async (courseId, taskId) => { calls.task.push([courseId, taskId]); return overrides.task ? overrides.task(courseId, taskId) : detail(courseId, taskId); },
    course: async id => { calls.course.push(id); if (overrides.course) return overrides.course(id); return { id, name: '保存', tasks, files: [], events: [], url: `https://shph.managebac.cn/student/classes/${id}` }; },
    prepareTaskUpload: async (courseId, taskId) => { calls.prepare.push([courseId, taskId]); return overrides.prepare ? overrides.prepare(courseId, taskId) : { token: 'synthetic-token', filename: '保存 <draft>.pdf', size: 1200, courseId, taskId }; },
    submitTaskUpload: async token => { calls.submit.push(token); return overrides.submit ? overrides.submit(token) : { verification: 'unverified', courseId: '21', taskId: '1', url: detail('21', '1').url }; },
    cancelTaskUpload: async token => { calls.cancel.push(token); }
  };
  window.ph = { school, system: { openUrl: async () => {} } };
  const context = { window, document, Intl, Date, URL, setInterval: () => 0, queueMicrotask, console, ...(overrides.clock || {}) };
  for (const file of ['school-selection-inference.js', 'school-tasks.js', 'school-ui.js', 'locales/en.js', 'i18n.js']) vm.runInNewContext(fs.readFileSync(require.resolve(`../src/${file}`), 'utf8'), context);
  const click = selector => { const node = document.querySelector(selector); assert.ok(node, `missing ${selector}`); node.dispatchEvent(new window.Event('click', { bubbles: true })); };
  const field = (name, value, type = 'change') => { const node = document.querySelector(`[data-school-field="${name}"]`); Object.defineProperty(node, 'value', { configurable: true, writable: true, value }); node.focus(); node.dispatchEvent(new window.Event(type, { bubbles: true })); };
  const open = async () => { window.schoolUI.open('courses'); await settle(); click('[data-course-tab="tasks"]'); await settle(); };
  const openTask = async (id = '1') => { click(`[data-school-action="task"][data-id="${id}"]`); await settle(); };
  return { window, document, calls, click, field, open, openTask, detail, snapshot: () => snapshot, setSnapshot: value => { snapshot = value; } };
}

test('task completion rejects negation and action labels; completed late work is not overdue', async () => {
  const ui = harness(); await ui.open();
  const statusOf = id => ui.document.querySelector(`[data-school-action="task"][data-id="${id}"]`).closest('article').dataset.taskStatus;
  assert.equal(statusOf('1'), 'overdue');
  for (const id of ['2', '3', '4', '5', '9']) assert.equal(statusOf(id), 'pending');
  for (const id of ['6', '7', '8', '10']) assert.equal(statusOf(id), 'completed');
  assert.equal(ui.document.querySelector('[data-id="6"] .is-overdue'), null);
});

test('task overview filters urgent work and notification navigation clears unrelated filters', async () => {
  const ui = harness();
  ui.snapshot().managebac.tasks.push({ id: '22:91', courseId: '22', title: 'Urgent', status: 'Pending', dueAt: new Date(Date.now() + 3600000).toISOString() });
  await ui.open();
  ui.click('[data-school-action="task-filter"][data-status="soon"]');
  assert.ok(ui.document.querySelector('[data-id="91"]'));
  assert.equal(ui.document.querySelector('[data-school-action="task"][data-id="1"]'), null);
  ui.field('query', 'does not exist', 'input');
  ui.window.schoolUI.openTasks(); await settle();
  assert.ok(ui.document.querySelector('[data-id="91"]'));
  assert.equal(ui.document.querySelector('[data-school-field="query"]').value, '');
});
test('reminder dialog saves user choices and English interface labels', async () => {
  const ui = harness(); await ui.open();
  ui.click('[data-school-action="task-reminders"]');
  const dialog = ui.document.querySelector('dialog');
  assert.ok(dialog.querySelector('[name="task-new"]').hasAttribute('checked'));
  dialog.querySelector('[name="task-new"]').checked = false;
  dialog.querySelector('[name="task-deadline"]').checked = false;
  ui.click('[data-school-action="save-task-reminders"]'); await settle();
  assert.equal(ui.snapshot().preferences.taskReminders.newTasks, false);
  assert.equal(ui.snapshot().preferences.taskReminders.deadlines, false);
  ui.click('[data-school-action="task-reminders"]');
  ui.window.i18n.apply('en');
  assert.match(dialog.textContent, /Task reminders/);
  assert.match(dialog.textContent, /Checks every 10 minutes/);
});

test('unknown and negated statuses stay pending while submitted ungraded work stays completed', async () => {
  const ui = harness();
  const statuses = ['not yet submitted', 'not completed', 'not graded', 'not assessed', 'ungraded', '未完成', 'unknown', '', 'Submitted, not graded', 'Submitted / Ungraded'];
  ui.snapshot().managebac.tasks = statuses.map((status, index) => ({ id: `21:${index}`, courseId: '21', title: 'Status example', status }));
  await ui.open();
  for (const [index] of statuses.entries()) {
    const row = ui.document.querySelector(`[data-school-action="task"][data-id="${index}"]`).closest('article');
    assert.equal(row.dataset.taskStatus, index >= 8 ? 'completed' : 'pending', statuses[index]);
  }
});

test('older unresolved synced work remains searchable and Chinese composition keeps its input', async () => {
  const ui = harness();
  ui.snapshot().managebac.tasks.push({ id: '21:old', courseId: '21', title: '旧作业', status: 'not submitted', dueAt: '2020-01-01' });
  await ui.open();
  assert.ok(ui.document.querySelector('[data-school-action="task"][data-id="old"]'));
  const input = ui.document.querySelector('[data-school-field="query"]'); input.focus(); input.value = '旧';
  const composing = new ui.window.Event('input', { bubbles: true }); composing.isComposing = true;
  input.dispatchEvent(composing); assert.equal(ui.document.querySelector('[data-school-field="query"]'), input);
  input.value = '旧作业'; input.dispatchEvent(new ui.window.Event('compositionend', { bubbles: true }));
  assert.equal(ui.document.querySelectorAll('.school-task-row').length, 1);
  assert.equal(ui.document.activeElement.value, '旧作业');
});

test('course, status and search filters compose, clear and preserve focus through refresh', async () => {
  const ui = harness(); await ui.open();
  ui.field('task-course', '21'); ui.field('task-status', 'overdue');
  assert.equal(ui.document.querySelectorAll('.school-task-row').length, 1);
  ui.field('query', 'Task 1', 'input');
  const input = ui.document.querySelector('[data-school-field="query"]'); input.setSelectionRange(2, 5);
  await ui.window.schoolUI.refresh();
  assert.equal(ui.document.activeElement.dataset.schoolField, 'query');
  assert.equal(ui.document.activeElement.selectionStart, 2); assert.equal(ui.document.activeElement.selectionEnd, 5);
  ui.click('[data-school-action="clear-task-filters"]');
  assert.equal(ui.document.querySelectorAll('.school-task-row').length, 11);
  ui.field('task-course', '22'); assert.equal(ui.document.querySelectorAll('.school-task-row').length, 1);
  assert.match(ui.document.querySelector('.school-task-row').textContent, /Cells/);
});

test('requirements preserve paragraphs and escaped attachments; English UI preserves school text', async () => {
  const ui = harness(); await ui.open(); await ui.openTask();
  const dialog = ui.document.querySelector('dialog');
  assert.match(dialog.querySelector('.school-prewrap').textContent, /保存\n\nSecond paragraph <script>/);
  assert.equal(dialog.querySelector('script, img'), null);
  const attachments = dialog.querySelectorAll('.school-file-row'); assert.equal(attachments.length, 2);
  assert.equal(attachments[0].querySelector('button').dataset.url, 'https://shph.managebac.cn/files/42?name="quoted"');
  assert.equal(attachments[1].querySelector('button').textContent, '在原网页查看');
  ui.window.i18n.apply('en');
  assert.match(dialog.textContent, /Task requirements/);
  assert.equal(dialog.querySelector('h2').textContent, '关闭');
  assert.match(dialog.querySelector('.school-prewrap').textContent, /^保存/);
  assert.equal(ui.document.querySelector('[data-school-field="task-course"] option[value="21"]').textContent, '保存');
});

test('choosing a file only prepares it; final confirmation uploads once and stays unverified', async () => {
  const upload = deferred(); const ui = harness({ submit: () => upload.promise });
  await ui.open(); await ui.openTask(); ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  assert.equal(ui.calls.submit.length, 0);
  const confirm = ui.document.querySelector('.school-upload-confirm');
  assert.match(confirm.textContent, /保存 <draft>.pdf/); assert.match(confirm.textContent, /1,200 bytes/);
  ui.click('[data-school-action="confirm-task-upload"]');
  assert.deepEqual(ui.calls.submit, ['synthetic-token']);
  assert.equal(ui.document.querySelector('[data-school-action="reset-task-upload"]'), null);
  assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]').disabled, true);
  upload.resolve({ verification: 'unverified' }); await settle();
  assert.match(ui.document.querySelector('.school-upload-notice').textContent, /尚未核实/);
  assert.equal(ui.document.querySelector('dialog .school-task-state').textContent, '待处理');
  assert.equal(ui.calls.submit.length, 1);
  ui.click('[data-school-action="refresh-task-detail"]'); await settle();
  assert.equal(ui.calls.task.length, 2); assert.match(ui.document.querySelector('.school-upload-notice').textContent, /尚未核实/);
  ui.window.i18n.apply('en'); assert.match(ui.document.querySelector('.school-upload-notice').textContent, /Upload result unverified/);
});

test('cancel selection and closing a prepared task cancel tokens without uploading', async () => {
  const ui = harness(); await ui.open(); await ui.openTask();
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  ui.click('[data-school-action="cancel-task-upload"]'); assert.deepEqual(ui.calls.cancel, ['synthetic-token']);
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  ui.click('dialog [data-school-action="close"]');
  assert.equal(ui.calls.cancel.length, 2); assert.equal(ui.calls.submit.length, 0);
});

test('native picker cancellation does not create a confirmation or upload', async () => {
  const ui = harness({ prepare: async () => ({ canceled: true }) }); await ui.open(); await ui.openTask();
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  assert.equal(ui.document.querySelector('.school-upload-confirm'), null);
  assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]').disabled, false);
  assert.equal(ui.calls.submit.length, 0);
});

test('late picker result is canceled after back navigation and cannot replace course detail', async () => {
  const selection = deferred(); const ui = harness({ prepare: () => selection.promise });
  await ui.open(); await ui.openTask(); ui.click('[data-school-action="prepare-task-upload"]');
  ui.click('dialog [data-school-action="course"]'); await settle();
  selection.resolve({ token: 'late', filename: 'old.pdf', size: 1, courseId: '21', taskId: '1' }); await settle();
  assert.deepEqual(ui.calls.cancel, ['late']); assert.deepEqual(ui.calls.course, ['21']);
  assert.equal(ui.document.querySelector('.school-upload-confirm'), null);
  assert.equal(ui.document.querySelector('dialog').open, false);
  assert.equal(ui.document.querySelector('.school-class-header h1').textContent, '保存');
});

test('an old detail response cannot replace a newer task, or reopen a closed dialog', async () => {
  const first = deferred(); const ui = harness({ task: (course, id) => id === '1' ? first.promise : { title: 'New task', attachments: [], description: 'Latest' } });
  await ui.open(); await ui.openTask(); await ui.openTask('2');
  first.resolve({ title: 'Stale task', attachments: [] }); await settle();
  assert.equal(ui.document.querySelector('dialog h2').textContent, 'New task');
  ui.click('dialog [data-school-action="close"]'); await settle();
  assert.equal(ui.document.querySelector('dialog').open, false);
});

test('account change cancels prepared files and invalidates a pending picker', async () => {
  const ui = harness(); await ui.open(); await ui.openTask();
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  ui.setSnapshot({ ...ui.snapshot(), managebac: null, epochs: { managebac: 2 } }); await ui.window.schoolUI.refresh();
  assert.deepEqual(ui.calls.cancel, ['synthetic-token']); assert.equal(ui.document.querySelector('dialog').open, false);
  assert.equal(ui.calls.submit.length, 0);
  const late = deferred(); const another = harness({ prepare: () => late.promise }); await another.open(); await another.openTask();
  another.click('[data-school-action="prepare-task-upload"]');
  another.setSnapshot({ ...another.snapshot(), managebac: null, epochs: { managebac: 2 } }); await another.window.schoolUI.refresh();
  late.resolve({ token: 'old-account', courseId: '21', taskId: '1' }); await settle();
  assert.deepEqual(another.calls.cancel, ['old-account']); assert.equal(another.document.querySelector('dialog').open, false);
});

test('a failed upload is not retried or called submitted, including after reopening', async () => {
  const ui = harness({ submit: async () => { throw new Error('Connection interrupted'); } }); await ui.open(); await ui.openTask();
  ui.click('[data-school-action="prepare-task-upload"]'); await settle(); ui.click('[data-school-action="confirm-task-upload"]'); await settle();
  assert.match(ui.document.querySelector('.school-upload-notice').textContent, /Connection interrupted/);
  ui.click('dialog [data-school-action="close"]'); await ui.openTask();
  assert.equal(ui.calls.submit.length, 1); assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]').disabled, true);
  assert.equal(ui.document.querySelector('dialog .school-task-state').textContent, '待处理');
});

test('reopening an in-flight upload receives its final unverified state without another request', async () => {
  const result = deferred(); const ui = harness({ submit: () => result.promise });
  await ui.open(); await ui.openTask(); ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  ui.click('[data-school-action="confirm-task-upload"]'); ui.click('dialog [data-school-action="close"]');
  await ui.openTask(); assert.match(ui.document.querySelector('.school-upload-notice').textContent, /正在上传/);
  result.resolve({ verification: 'unverified' }); await settle();
  assert.match(ui.document.querySelector('.school-upload-notice').textContent, /尚未核实/);
  assert.equal(ui.document.querySelector('[data-school-action="refresh-task-detail"]').disabled, false);
  assert.equal(ui.calls.submit.length, 1);
});

test('a deliberate checked-site reset allows a new selection but still requires final confirmation', async () => {
  let sequence = 0;
  const ui = harness({ prepare: async (courseId, taskId) => ({ token: `file-${++sequence}`, filename: 'replacement.pdf', size: 1234, courseId, taskId }) });
  await ui.open(); await ui.openTask();
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  ui.click('[data-school-action="confirm-task-upload"]'); await settle();
  assert.deepEqual(ui.calls.submit, ['file-1']);
  assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]').disabled, true);
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  assert.equal(ui.calls.prepare.length, 1);
  ui.window.i18n.apply('en');
  assert.equal(ui.document.querySelector('[data-school-action="reset-task-upload"]').textContent, 'I checked the school site; choose another file');
  ui.click('[data-school-action="reset-task-upload"]');
  assert.equal(ui.calls.prepare.length, 1); assert.deepEqual(ui.calls.submit, ['file-1']);
  assert.equal(ui.document.querySelector('[data-school-action="prepare-task-upload"]').disabled, false);
  ui.click('[data-school-action="prepare-task-upload"]'); await settle();
  assert.ok(ui.document.querySelector('.school-upload-confirm'));
  assert.equal(ui.calls.prepare.length, 2); assert.deepEqual(ui.calls.submit, ['file-1']);
  ui.click('[data-school-action="confirm-task-upload"]'); await settle();
  assert.deepEqual(ui.calls.submit, ['file-1', 'file-2']);
  assert.match(ui.document.querySelector('.school-upload-notice').textContent, /unverified/i);
});

test('notification list deduplicates tasks and removes submitted work on refresh', async () => {
  const ui = harness(); await ui.open();
  ui.snapshot().managebac.tasks.push({ ...ui.snapshot().managebac.tasks[0] });
  ui.click('[data-course-tab="notifications"]');
  assert.equal(ui.document.querySelectorAll('[data-school-action="task"][data-id="1"]').length, 1);
  assert.equal(ui.document.querySelector('[data-school-action="task"][data-id="6"]'), null);
  ui.snapshot().managebac.tasks[0].status = 'Submitted';
  ui.snapshot().managebac.tasks.at(-1).status = 'Submitted';
  await ui.window.schoolUI.refresh();
  assert.equal(ui.document.querySelector('[data-school-action="task"][data-id="1"]'), null);
});
test('course detail switches sections without refetching and returns to the filtered list', async () => {
  const ui = harness(); await ui.open(); ui.click('[data-course-tab="courses"]');
  ui.field('course-query', 'Biology', 'input');
  assert.equal(ui.document.querySelectorAll('.school-course-card').length, 1);
  ui.click('[data-school-action="course"]'); await settle();
  assert.ok(ui.document.querySelector('[data-school-action="course-detail-tab"][data-tab="tasks"]'));
  ui.click('[data-school-action="course-detail-tab"][data-tab="files"]');
  assert.match(ui.document.querySelector('.school-course-panel').textContent, /暂未识别到文件/);
  ui.click('[data-school-action="course-detail-tab"][data-tab="tasks"]');
  assert.equal(ui.calls.course.length, 1);
  assert.equal(ui.document.querySelector('[data-school-action="class-task-filter"][data-filter="pending"]').getAttribute('aria-pressed'), 'true');
  ui.click('[data-school-action="course-list"]');
  assert.equal(ui.document.querySelector('[data-school-field="course-query"]').value, 'Biology');
});

test('class navigation ignores old requests when switching classes or returning to all classes', async () => {
  const first = deferred();
  const ui = harness({ course: id => id === '21' ? first.promise : Promise.resolve({id, name:'Biology',tasks:[],files:[],events:[]}) });
  await ui.open(); ui.click('[data-course-tab="courses"]');
  ui.click('[data-school-action="course"][data-id="21"]');
  ui.field('class-switch', '22'); await settle();
  assert.equal(ui.document.querySelector('.school-class-header h1').textContent, 'Biology');
  first.resolve({id:'21',name:'Stale course',tasks:[],files:[],events:[]}); await settle();
  assert.equal(ui.document.querySelector('.school-class-header h1').textContent, 'Biology');
  ui.click('[data-school-action="course-list"]');
  assert.equal(ui.document.querySelector('.school-class-header'), null);
  assert.equal(ui.document.querySelectorAll('.school-course-card').length, 2);
});
test('closing assignment details preserves class section and task filters', async () => {
  const ui = harness(); await ui.open(); ui.click('[data-course-tab="courses"]');
  ui.click('[data-school-action="course"][data-id="21"]'); await settle();
  ui.click('[data-school-action="course-detail-tab"][data-tab="tasks"]');
  ui.click('[data-school-action="class-task-filter"][data-filter="completed"]');
  ui.field('class-query', 'Task 6', 'input');
  await ui.openTask('6'); ui.click('dialog [data-school-action="close"]');
  assert.equal(ui.document.querySelector('[data-school-field="class-query"]').value, 'Task 6');
  assert.equal(ui.document.querySelector('[data-school-action="class-task-filter"][data-filter="completed"]').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.calls.course.length, 1);
});
test('class page and pending requests clear on account switch', async () => {
  const pending = deferred(); const ui = harness({ course: () => pending.promise });
  await ui.open(); ui.click('[data-course-tab="courses"]'); ui.click('[data-school-action="course"]');
  ui.setSnapshot({ ...ui.snapshot(), managebac: null, epochs:{managebac:2} });
  await ui.window.schoolUI.refresh();
  pending.resolve({id:'21',name:'Old account',tasks:[],files:[],events:[]}); await settle();
  assert.equal(ui.document.querySelector('.school-class-header'), null);
  assert.doesNotMatch(ui.document.querySelector('#schoolPage').textContent,/Old account/);
});


test('unreadable class tasks show cached work and retry preserves section and filters', async () => {
  let attempt = 0;
  const ui = harness({course: async id => ({id, tasks:[], tasksStatus: ++attempt === 1 ? 'error' : 'empty'})});
  await ui.open(); ui.click('[data-course-tab="courses"]'); ui.click('[data-school-action="course"][data-id="21"]'); await settle();
  ui.click('[data-school-action="course-detail-tab"][data-tab="tasks"]');
  assert.ok(ui.document.querySelector('.school-task-cache-label'));
  assert.match(ui.document.querySelector('.school-course-panel').textContent,/未能完整读取/);
  ui.click('[data-school-action="class-task-filter"][data-filter="all"]');
  ui.field('class-query','Task','input');
  ui.click('[data-school-action="retry-course"]'); await settle();
  assert.equal(ui.document.querySelector('[data-school-field="class-query"]').value,'Task');
  assert.equal(ui.document.querySelector('[data-filter="all"]').getAttribute('aria-pressed'),'true');
  assert.equal(ui.document.querySelector('.school-task-cache-label'),null);
  assert.equal(ui.document.querySelector('[data-school-action="retry-course"]'),null);
});

test('unreadable class with no cache never says there are no matching assignments', async () => {
  const ui=harness({course:async id=>({id,tasks:[],tasksStatus:'error'})});
  ui.snapshot().managebac.tasks=[];
  await ui.open();ui.click('[data-course-tab="courses"]');ui.click('[data-school-action="course"]');await settle();
  ui.click('[data-school-action="course-detail-tab"][data-tab="tasks"]');
  assert.match(ui.document.querySelector('.school-course-panel').textContent,/不能确认是否为空/);
  ui.window.i18n.apply('en');
  assert.match(ui.document.querySelector('.school-course-panel').textContent,/Tasks have not loaded/);
});


test('unified course tabs open timetable and a matched lesson opens its assignments', async () => {
 const ui=harness(); const date=new Date(); date.setDate(date.getDate()-((date.getDay()+6)%7));
 const week=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
 ui.snapshot().edupage={accountKey:'edu',weekStart:week,fetchedAt:new Date().toISOString(),lessons:[{id:'lesson',groupKey:'g',course:'Biology',date:week,start:'08:00',end:'08:40',groups:[],teacher:'',room:''}],options:[]};
 ui.snapshot().preferences={accountKey:'edu',groups:['g']};
 await ui.open();ui.click('[data-course-tab="timetable"]');await settle();
 assert.ok(ui.document.querySelector('[data-school-action="lesson"]'));
 ui.click('[data-school-action="lesson"]');await settle();
 assert.deepEqual(ui.calls.course,['22']);
 assert.equal(ui.document.querySelector('[data-tab="tasks"]').getAttribute('aria-current'),'page');
 ui.window.i18n.apply('en'); assert.match(ui.document.querySelector('.school-course-tabs').textContent,/Schedule/);
 ui.click('[data-course-tab="timetable"]');await settle();assert.ok(ui.document.querySelector('[data-school-action="lesson"]'));
});


test('saved course association survives a new renderer and is ignored for another account', async () => {
 for (const changed of [false,true]) {
  const ui=harness();const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));const week=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  ui.snapshot().edupage={accountKey:'edu',weekStart:week,fetchedAt:new Date().toISOString(),lessons:[{id:'lesson',groupKey:'g',course:'Ambiguous subject',date:week,start:'08:00',end:'08:40',groups:[]}],options:[]};
  ui.snapshot().preferences=JSON.parse(JSON.stringify({accountKey:'edu',groups:['g'],courseLinks:{edupageAccount:'edu',managebacAccount:changed?'other':'synthetic-a',items:{g:'22'}}}));
  await ui.open();ui.click('[data-course-tab="timetable"]');await settle();ui.click('[data-school-action="lesson"]');await settle();
  assert.equal(ui.calls.course.length,changed?0:1);
  if(!changed)assert.equal(ui.calls.course[0],'22');
  else assert.ok(ui.document.querySelector('[data-school-action="linked-course"]'));
 }
});


test('slow course reads leave navigation and cache usable; timeout ignores late results', async()=>{
 let expire;const request=deferred();
 const ui=harness({course:()=>request.promise,clock:{setTimeout:cb=>{expire=cb;return 1},clearTimeout:()=>{}}});
 await ui.open();ui.click('[data-course-tab="courses"]');ui.click('[data-school-action="course"][data-id="21"]');await settle();
 assert.ok(ui.document.querySelector('[data-school-action="course-list"]'));
 ui.click('[data-tab="tasks"]');assert.ok(ui.document.querySelector('.school-task-cache-label'));
 expire();await settle();assert.match(ui.document.querySelector('.school-error').textContent,/超时/);
 assert.ok(ui.document.querySelector('[data-school-action="retry-course"]'));
 request.resolve({id:'21',name:'Late result',tasks:[]});await settle();assert.doesNotMatch(ui.document.querySelector('h1').textContent,/Late result/);
});

test('session timetable slots automatically link an unnamed course; conflicts never guess',async()=>{
 for(const conflict of [false,true]){
 const ui=harness({timetable:async()=>({slots:[{courseId:'21',date:week,start:'08:00',end:'08:40'},...(conflict?[{courseId:'22',date:week,start:'08:00',end:'08:40'}]:[])],fetchedAt:new Date().toISOString()})});
 const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));const week=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
 ui.snapshot().edupage={accountKey:'edu',weekStart:week,lessons:[{id:'lesson',groupKey:'g',course:'Unmatched title',date:week,start:'08:00',end:'08:40',groups:[]}],options:[]};ui.snapshot().preferences={accountKey:'edu',groups:['g']};
 await ui.open();ui.click('[data-course-tab="timetable"]');await settle();ui.click('[data-school-action="lesson"]');await settle();await settle();
 assert.equal(ui.calls.course.length,conflict?0:1);if(!conflict)assert.equal(ui.calls.course[0],'21');
 }
});

test('structured units render as separate cards; old flattened cache cannot leak into the page',async()=>{
 for(const legacy of [false,true]){
 const ui=harness({course:async id=>({id,name:'A long class name '.repeat(12),units:legacy?'Units Weekly Planner List View 0 Lessons 0 Tasks':[{id:'1',title:'Exploring truth',level:'SL',start:'Starts W1 Sep',duration:'3 Weeks',state:'current',tasks:0,lessons:0,url:'https://shph.managebac.cn/student/classes/21/units/1/presentations'},{id:'2',title:'Writing project',state:'completed'}],tasks:[],files:[],events:[]})});
 await ui.open();ui.click('[data-course-tab="courses"]');ui.click('[data-school-action="course"][data-id="21"]');await settle();ui.click('[data-tab="units"]');
 assert.equal(ui.document.querySelectorAll('.school-unit-card').length,legacy?0:2);assert.ok(!ui.document.querySelector('#schoolPage').textContent.includes('Weekly Planner'));
 if(!legacy){ui.window.i18n.apply('en');assert.match(ui.document.querySelector('.school-unit-list').textContent,/Current unit/);assert.equal(ui.document.querySelector('.school-unit-card h3').textContent,'Exploring truth');}
 }
});

test('a successful newer snapshot updates the open class task list without discarding its section',async()=>{
 const ui=harness({course:async id=>({id,name:'Biology',fetchedAt:'2026-01-01T00:00:00Z',tasks:[{id:'old',courseId:id,title:'Old task',status:'Pending'}],units:[],files:[]})});
 await ui.open();ui.click('[data-course-tab="courses"]');ui.click('[data-school-action="course"][data-id="21"]');await settle();ui.click('[data-tab="tasks"]');
 const next=JSON.parse(JSON.stringify(ui.snapshot()));next.managebac={...next.managebac,fetchedAt:new Date().toISOString(),taskSyncedCourses:['21'],tasks:[{id:'new',courseId:'21',title:'New task',status:'Pending'}]};ui.setSnapshot(next);await ui.window.schoolUI.refresh();await settle();
 assert.match(ui.document.querySelector('.school-course-panel').textContent,/New task/);assert.ok(!ui.document.querySelector('.school-course-panel').textContent.includes('Old task'));
});
