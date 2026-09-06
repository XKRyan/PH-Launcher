"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const old = '2020-01-01T00:00:00.000Z';
const monday = () => {
  const value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
};

function harness(initial, { wrongWeek = false, getResult, syncError, loginResult } = {}) {
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  const document = window.document;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  let snapshot = initial;
  const calls = { get: [], sync: [], login: [], preferences: [] };
  const api = {
    get: async (options = {}) => {
      calls.get.push(options);
      if (getResult) return getResult(options, calls.get.length, snapshot);
      if (wrongWeek && options.weekStart) return { ...snapshot, edupage: { ...snapshot.edupage, weekStart: '1999-01-04' } };
      return snapshot;
    },
    sync: async (source, options) => { calls.sync.push({ source, options }); if (syncError) throw new Error(syncError); return snapshot; },
    login: async (source, options) => { calls.login.push({ source, options }); return loginResult || { ok: true, snapshot }; },
    preferences: async (change) => {
      calls.preferences.push(change);
      snapshot = { ...snapshot, preferences: { ...snapshot.preferences, ...change } };
      return snapshot;
    },
  };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, openSite: async () => {} }, document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/school-ui.js'), 'utf8'), context);
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `missing ${selector}`);
    node.dispatchEvent(new window.Event('click', { bubbles: true }));
  };
  return { context, document, calls, click };
}

test('automatic school refresh is opt-in, explicitly consented, and uses non-forced sync', async () => {
  const weekStart = monday();
  const snapshot = { edupage: { weekStart, fetchedAt: old, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: {}, status: { edupage: { state: 'stale', updatedAt: old } } };
  const ui = harness(snapshot);
  ui.context.window.schoolUI.mount(); await settle();
  assert.equal(ui.calls.sync.length, 0, 'default-off must not create school network work');
  ui.click('[data-school-action="auto-sync"]');
  assert.match(ui.document.querySelector('dialog').textContent, /不会发送给 AI/);
  ui.click('[data-school-action="auto-sync-consent"]'); await settle();
  assert.equal(ui.calls.preferences.length, 1);
  assert.equal(ui.calls.preferences[0].autoSync, true);
  assert.equal(ui.calls.sync[0].source, 'edupage');
  assert.equal(ui.calls.sync[0].options.weekStart, weekStart);
  assert.equal(ui.calls.sync[0].options.force, false);
});

test('saved automatic approval refreshes stale visible content, while manual refresh remains forced', async () => {
  const weekStart = monday();
  const snapshot = { edupage: { weekStart, fetchedAt: old, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: { autoSync: true }, status: { edupage: { state: 'stale', updatedAt: old } } };
  const ui = harness(snapshot);
  ui.context.window.schoolUI.mount(); await settle();
  assert.equal(ui.calls.sync[0].source, 'edupage');
  assert.equal(ui.calls.sync[0].options.weekStart, weekStart);
  assert.equal(ui.calls.sync[0].options.force, false);
  ui.click('[data-school-action="sync"]'); await settle();
  assert.equal(ui.calls.sync.at(-1).source, 'edupage');
  assert.equal(ui.calls.sync.at(-1).options.weekStart, weekStart);
  assert.equal(ui.calls.sync.at(-1).options.force, true);
});

test('a response for another week cannot replace the selected timetable', async () => {
  const weekStart = monday();
  const snapshot = { edupage: { weekStart, fetchedAt: old, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: {}, status: {} };
  const ui = harness(snapshot, { wrongWeek: true });
  ui.context.window.schoolUI.mount(); await settle();
  assert.match(ui.document.querySelector('#schoolPage').textContent, /把一周安排放在眼前/);
  assert.doesNotMatch(ui.document.querySelector('#schoolPage').textContent, /1999-01-04/);
});

test('a temporary refresh failure retains verified timetable content and shows a clean error', async () => {
  const weekStart = monday();
  const lesson = { id: 'lesson-1', date: weekStart, start: '08:00', end: '08:40', course: 'Biology', room: 'A101', teacher: 'T', groups: [], groupKey: 'g', cancelled: false };
  const snapshot = { edupage: { weekStart, fetchedAt: old, lessons: [lesson], options: [], missingDates: [] }, managebac: null, preferences: { groups: ['g'] }, status: { edupage: { state: 'stale', updatedAt: old, error: '网络暂时不可用' } } };
  const ui = harness(snapshot, { syncError: "Error invoking remote method 'school:sync': 网络暂时不可用" });
  ui.context.window.schoolUI.mount(); await settle();
  ui.click('[data-school-action="sync"]'); ui.click('[data-school-action="consent"]'); await settle();
  assert.equal(ui.document.querySelectorAll('.school-lesson').length, 1);
  assert.match(ui.document.querySelector('#schoolPage').textContent, /网络暂时不可用/);
  assert.match(ui.document.querySelector('.school-cache-status').textContent, /上次读取/);
});

test('authoritative null and account changes clear cached weeks', async () => {
  const firstWeek = monday();
  const secondWeek = new Date(`${firstWeek}T12:00:00Z`); secondWeek.setUTCDate(secondWeek.getUTCDate() + 7);
  const nextWeek = secondWeek.toISOString().slice(0, 10);
  const base = (weekStart, accountKey) => ({ edupage: { weekStart, accountKey, fetchedAt: old, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: {}, status: {}, epochs: { edupage: accountKey } });
  const responses = [base(firstWeek, 'a'), base(nextWeek, 'a'), base(firstWeek, 'b'), { ...base(firstWeek, 'b'), edupage: null }];
  const ui = harness(base(firstWeek, 'a'), { getResult: () => responses.shift() });
  ui.context.window.schoolUI.mount(); await settle();
  ui.click('[data-school-action="week"][data-delta="7"]'); await settle();
  ui.click('[data-school-action="week"][data-delta="-7"]'); await settle();
  ui.click('[data-school-action="week"][data-delta="7"]'); await settle();
  assert.match(ui.document.querySelector('#schoolPage').textContent, /把一周安排放在眼前/);
});

test('a fresh prior week never suppresses a missing selected-week refresh, and manual consent alone does not enable it', async () => {
  const firstWeek = monday();
  const date = new Date(`${firstWeek}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 7); const nextWeek = date.toISOString().slice(0, 10);
  const fresh = new Date().toISOString();
  const initial = { edupage: { weekStart: firstWeek, fetchedAt: fresh, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: { autoSync: true }, status: { edupage: { updatedAt: fresh } } };
  const ui = harness(initial, { getResult: (options, count, snapshot) => count === 1 ? snapshot : { ...snapshot, edupage: null } });
  ui.context.window.schoolUI.mount(); await settle();
  ui.click('[data-school-action="week"][data-delta="7"]'); await settle();
  assert.equal(ui.calls.sync.at(-1).options.weekStart, nextWeek);
  assert.equal(ui.calls.sync.at(-1).options.force, false);

  const manual = harness({ ...initial, preferences: {} });
  manual.context.window.schoolUI.mount(); await settle();
  manual.click('[data-school-action="sync"]'); manual.click('[data-school-action="consent"]'); await settle();
  manual.click('[data-school-action="week"][data-delta="7"]'); await settle();
  assert.equal(manual.calls.sync.length, 1, 'one-time manual consent must not become background refresh consent');
});

test('personal and class timetables are independent routes with distinct teaching-group scope', async () => {
  const weekStart = monday();
  const lesson = (group) => ({ id: group, date: weekStart, start: '08:00', end: '08:40', course: `Course ${group}`, room: 'A101', teacher: 'T', groups: [group], groupKey: group, cancelled: false });
  const ui = harness({
    edupage: { weekStart, accountKey: 'a', className: 'Synthetic Class', fetchedAt: old, lessons: [lesson('g1'), lesson('g2')], options: [], missingDates: [] },
    managebac: null, preferences: { accountKey: 'a', groups: ['g1'] }, status: {},
  });
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.equal(ui.document.querySelector('#schoolPage h1').textContent, '我的课表');
  assert.equal(ui.document.querySelectorAll('.school-lesson').length, 1);
  assert.equal(ui.document.querySelector('.school-course-tabs'), null);
  await ui.context.window.schoolUI.open('class-timetable');
  assert.equal(ui.document.querySelector('#schoolPage h1').textContent, '班级课表');
  assert.equal(ui.document.querySelectorAll('.school-lesson').length, 2);
  assert.match(ui.document.querySelector('.school-readonly-scope').textContent, /Synthetic Class/);
  assert.equal(ui.document.querySelector('[data-school-action="groups"]'), null);
  assert.equal(ui.document.querySelector('[data-school-action="import-plan"]'), null);
  await ui.context.window.schoolUI.open('timetable');
  assert.equal(ui.document.querySelectorAll('.school-lesson').length, 1);
  assert.equal(ui.calls.sync.length, 0, 'local route changes must not imply network consent');
  assert.equal(ui.calls.preferences.length, 0, 'class viewing cannot overwrite personal group selection');
});

test('course workspace owns its course/task/core sections without aggregate school tabs', async () => {
  const ui = harness({ edupage: null, managebac: { fetchedAt: old, courses: [{ id: '21', name: 'Biology', grade: '6' }], tasks: [], warnings: [] }, preferences: {}, status: {} });
  ui.context.window.schoolUI.open('courses'); await settle();
  assert.equal(ui.document.querySelector('#schoolPage h1').textContent, '我的课程');
  assert.equal(ui.document.querySelectorAll('[data-course-tab]').length, 3);
  assert.equal(ui.document.querySelector('.school-tabs'), null);
  assert.equal(ui.document.querySelectorAll('.school-course-card').length, 1);
  ui.click('[data-course-tab="tasks"]');
  assert.ok(ui.document.querySelector('.school-task-filters'));
  ui.click('[data-course-tab="core"]');
  assert.ok(ui.document.querySelector('[data-kind="cas"]'));
  assert.ok(ui.document.querySelector('[data-kind="ee"]'));
  assert.equal(ui.calls.sync.length, 0);
});

test('reopening the same route after account invalidation reconciles local epochs before reuse', async () => {
  const weekStart = monday();
  const snapshot = { edupage: { weekStart, fetchedAt: old, lessons: [], options: [], missingDates: [] }, managebac: null, preferences: { groups: ['configured'] }, status: {}, epochs: { edupage: 1 } };
  const ui = harness(snapshot, { getResult: (_options, count) => count === 1 ? snapshot : { ...snapshot, edupage: null, epochs: { edupage: 2 } } });
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.ok(ui.document.querySelector('.school-timetable'));
  await ui.context.window.schoolUI.open('timetable');
  assert.equal(ui.calls.get.length, 2);
  assert.equal(ui.document.querySelector('.school-timetable'), null);
  assert.match(ui.document.querySelector('.school-empty').textContent, /先登录 EduPage/);
  assert.equal(ui.calls.sync.length, 0);
});

test('school login errors show only the readable explanation, not IPC or error-class prefixes', async () => {
  const ui = harness({ edupage: null, managebac: null, preferences: {}, status: {} }, { syncError: "Error invoking remote method 'school:sync': Error: SchoolAuthError: 学校登录需要人工完成验证码，请在内置网页继续" });
  ui.context.window.schoolUI.open('timetable'); await settle();
  ui.click('[data-school-action="sync"]'); ui.click('[data-school-action="consent"]'); await settle();
  assert.equal(ui.document.querySelector('[role="alert"]').textContent, '学校登录需要人工完成验证码，请在内置网页继续');
});

test('normal onboarding offers account entry, not a required original-website login', async () => {
  const ui = harness({ edupage: null, managebac: null, preferences: {}, status: {}, accounts: { edupage: { saved: false } } });
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.match(ui.document.querySelector('.school-empty').textContent, /输入账号密码/);
  assert.equal(ui.document.querySelector('[data-school-action="login"]'), null);
  assert.equal(ui.calls.login.length, 0);
});

test('explicit approved login connects once and failure stops automatic retries while preserving its reason', async () => {
  const snapshot = { edupage: null, managebac: null, preferences: {}, status: {}, accounts: { edupage: { saved: true } } };
  const ui = harness(snapshot, { loginResult: { ok: false, error: { code: 'LOGIN_REQUIRED', message: '账号密码未通过验证' }, snapshot: { ...snapshot, preferences: { autoSync: true } } } });
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.equal(await ui.context.window.schoolUI.connect('edupage'), false);
  assert.equal(ui.calls.login.length, 0);
  assert.equal(await ui.context.window.schoolUI.connect('edupage', { approved: true }), false);
  assert.equal(ui.calls.login.length, 1);
  assert.match(ui.document.querySelector('[role="alert"]').textContent, /账号密码未通过验证/);
  await ui.context.window.schoolUI.refresh();
  assert.equal(ui.calls.sync.length, 0);
  assert.equal(ui.calls.login.length, 1);
});
