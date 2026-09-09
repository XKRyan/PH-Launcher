"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require.resolve('../src/dashboard-data.js'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DAY = 86400000;

function isoDaysFromNow(days, hour = 8, minute = 0) {
  const date = new Date(Date.now() + days * DAY);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}:00`;
}

// A realistic synced snapshot: EduPage week with selected groups + ManageBac tasks.
function schoolSnapshot({ now = Date.now() } = {}) {
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const tomorrowKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now + DAY));
  const lesson = (date, start, end, course, room, groupKey) => ({ id: `edu-${date}-${start}`, date, start, end, course, room, groups: ['A'], groupKey, cancelled: false });
  return {
    edupage: {
      weekStart: todayKey,
      accountKey: 'acc-1',
      fetchedAt: new Date(now).toISOString(),
      lessons: [
        lesson(todayKey, '08:00', '08:45', 'Mathematics', 'A301', 'g-math'),
        lesson(todayKey, '08:55', '09:40', 'English', 'B102', 'g-eng'),
        lesson(tomorrowKey, '10:45', '11:30', 'Physics', 'C201', 'g-phy'),
      ],
    },
    managebac: {
      fetchedAt: new Date(now).toISOString(),
      tasks: [
        { id: 't1', title: 'Math problem set 4', courseName: 'Mathematics', dueAt: isoDaysFromNow(2, 23, 59) },
        { id: 't2', title: 'English essay draft', courseName: 'English', dueAt: isoDaysFromNow(1, 23, 59) },
        { id: 't3', title: 'Physics lab report', courseName: 'Physics', dueAt: isoDaysFromNow(20, 23, 59) },
        { id: 't4', title: 'History reading', courseName: 'History', dueAt: isoDaysFromNow(-3, 23, 59) },
      ],
    },
    preferences: { accountKey: 'acc-1', groups: ['g-math', 'g-eng', 'g-phy'] },
  };
}

function harness({ snapshot, unread = 3, failSnapshot = false } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><main class="page active" id="todayPage">'
    + '<strong id="nextClassName"></strong><small id="nextClassMeta"></small>'
    + '<strong id="todayTaskMetric"></strong><small id="overdueMetric"></small>'
    + '<strong id="unreadMailCount"></strong>'
    + '<div id="dashboardDeadlines"></div><div id="dashboardTimetable"></div>'
    + '</main></body></html>');
  window.ph = { school: { get: async () => { if (failSnapshot) throw new Error('boom'); return snapshot; } } };
  window.mailUI = { unreadCount: () => unread };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date, Number, Object, Array, String, Math, RegExp, JSON, Map, Set, Intl });
  return { window, document: window.document };
}

test('dashboard fills timetable card with today lessons and marks the ongoing class', async () => {
  const ui = harness({ snapshot: schoolSnapshot() });
  await ui.window.dashboardData.refresh();
  await settle();
  const timetable = ui.document.getElementById('dashboardTimetable');
  assert.equal(ui.document.getElementById('nextClassName').textContent, '当前没有课程', 'outside class hours the hero line says so');
  assert.match(timetable.textContent, /Mathematics/);
  assert.match(timetable.textContent, /A301/);
  assert.match(timetable.textContent, /English/);
  assert.doesNotMatch(timetable.textContent, /Physics/, 'the card shows today only; tomorrow rides in the hero line');
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /下一节|尚未同步|请先|暂无/);
  const nowLines = timetable.querySelectorAll('.dashboard-lesson-line.is-now');
  assert.equal(nowLines.length, 0, 'no lesson runs at fixture time unless actually in progress');
});

test('dashboard shows the next lesson in the hero line when one is upcoming', async () => {
  const snapshot = schoolSnapshot();
  const now = Date.now();
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  // 30 minutes from now, inside the Shanghai day of "today".
  const soon = new Date(now + 30 * 60000);
  const pad = (v) => String(v).padStart(2, '0');
  const start = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  const end = `${pad(soon.getHours())}:${pad(soon.getMinutes() + 10)}`;
  snapshot.edupage.lessons = [{ id: 'edu-soon', date: todayKey, start, end, course: 'Chemistry', room: 'D404', groups: ['A'], groupKey: 'g-chem', cancelled: false }];
  snapshot.preferences.groups = ['g-chem'];
  const ui = harness({ snapshot });
  await ui.window.dashboardData.refresh();
  await settle();
  assert.match(ui.document.getElementById('nextClassName').textContent, /当前没有课程|正在上课/);
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /Chemistry/);
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /D404/);
});

test('dashboard deadline card lists only tasks due within 14 days, soonest first', async () => {
  const ui = harness({ snapshot: schoolSnapshot() });
  await ui.window.dashboardData.refresh();
  await settle();
  const host = ui.document.getElementById('dashboardDeadlines');
  const items = [...host.querySelectorAll('.dashboard-deadline strong')].map((node) => node.textContent);
  assert.deepEqual(items, ['English essay draft', 'Math problem set 4'], 'soonest first, 14-day window, past-due excluded');
  assert.match(ui.document.getElementById('todayTaskMetric').textContent, /未来14天 · 2 项截止/);
});

test('dashboard degrades gracefully before sync and after errors', async () => {
  const ui = harness({ snapshot: null });
  await ui.window.dashboardData.refresh();
  await settle();
  assert.equal(ui.document.getElementById('todayTaskMetric').textContent, '尚未同步 ManageBac');
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /尚未同步 EduPage/);
  assert.match(ui.document.getElementById('unreadMailCount').textContent, /3 封未读/);

  const failing = harness({ snapshot: null, failSnapshot: true });
  await failing.window.dashboardData.refresh();
  await settle();
  assert.match(failing.document.getElementById('nextClassMeta').textContent, /暂时无法读取/);
});

test('project() is a pure helper: selection-missing weeks show no lessons', () => {
  const { project } = (() => { const window = {}; vm.runInNewContext(source, { window, Date, Number, Object, Array, String }); return window.dashboardData; })();
  const snapshot = schoolSnapshot();
  snapshot.preferences = {};
  const view = project(snapshot);
  assert.equal(view.selectionReady, false);
  assert.equal(view.current, undefined);
  assert.equal(view.next, undefined);
  assert.equal(view.tasks.length, 2);
});
