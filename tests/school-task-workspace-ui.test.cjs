'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

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
  const detail = (courseId, taskId) => ({ courseId, taskId, title: '关闭', status: 'not submitted', description: '保存\n\nSecond paragraph <script>unsafe()</script>', attachments: [{ name: '<img src=x onerror=unsafe()>', url: 'https://shph.managebac.cn/files/42?name="quoted"' }, { name: 'Original attachment', url: 'https://shph.managebac.cn/student/classes/21/tasks/1', originalPage: true }], url: `https://shph.managebac.cn/student/classes/${courseId}/tasks/${taskId}` });
  const school = {
    get: async () => snapshot, sync: async () => snapshot,
    preferences: async (change) => { snapshot.preferences = { ...snapshot.preferences, ...change }; return snapshot; },
    task: async (courseId, taskId) => { calls.task.push([courseId, taskId]); return overrides.task ? overrides.task(courseId, taskId) : detail(courseId, taskId); },
    course: async id => { calls.course.push(id); return { id, name: '保存', tasks, files: [], events: [], url: `https://shph.managebac.cn/student/classes/${id}` }; },
    prepareTaskUpload: async (courseId, taskId) => { calls.prepare.push([courseId, taskId]); return overrides.prepare ? overrides.prepare(courseId, taskId) : { token: 'synthetic-token', filename: '保存 <draft>.pdf', size: 1200, courseId, taskId }; },
    submitTaskUpload: async token => { calls.submit.push(token); return overrides.submit ? overrides.submit(token) : { verification: 'unverified', courseId: '21', taskId: '1', url: detail('21', '1').url }; },
    cancelTaskUpload: async token => { calls.cancel.push(token); }
  };
  window.ph = { school, system: { openUrl: async () => {} } };
  const context = { window, document, Intl, Date, URL, setInterval: () => 0, queueMicrotask, console };
  for (const file of ['school-ui.js', 'locales/en.js', 'i18n.js']) vm.runInNewContext(fs.readFileSync(require.resolve(`../src/${file}`), 'utf8'), context);
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
  assert.match(dialog.textContent, /Assignment requirements/);
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
  assert.match(ui.document.querySelector('#schoolDialogTitle').textContent, /课程详情/);
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
  assert.match(ui.document.querySelector('.school-upload-notice').textContent, /尚未核实/);
});
