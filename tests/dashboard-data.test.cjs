"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require.resolve('../src/dashboard-data.js'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DAY = 86400000;
// A fixed clock makes every assertion independent of the runner's time zone.
// 2026-09-09T02:00:00Z is 2026-09-09 10:00 in Asia/Shanghai, a Wednesday.
const FIXED_NOW = Date.parse('2026-09-09T02:00:00Z');
const SHANGHAI_OFFSET = 8 * 3600000;

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
}

const shanghaiDate = (offsetDays = 0) => new Date(FIXED_NOW + offsetDays * DAY + SHANGHAI_OFFSET).toISOString().slice(0, 10);
const shanghaiStamp = (offsetDays, hour, minute) => `${shanghaiDate(offsetDays)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;

// A realistic synced snapshot: EduPage week with selected groups + ManageBac tasks.
function schoolSnapshot() {
  const today = shanghaiDate(0);
  const tomorrow = shanghaiDate(1);
  const lesson = (date, start, end, course, room, groupKey) => ({ id: `edu-${date}-${start}`, date, start, end, course, room, groups: ['A'], groupKey, cancelled: false });
  return {
    edupage: {
      weekStart: today,
      accountKey: 'acc-1',
      fetchedAt: new Date(FIXED_NOW).toISOString(),
      lessons: [
        // Finished, in progress (10:00 falls inside 09:30–10:30), and upcoming.
        lesson(today, '08:00', '08:45', 'Mathematics', 'A301', 'g-math'),
        lesson(today, '09:30', '10:30', 'English', 'B102', 'g-eng'),
        lesson(today, '11:00', '11:45', 'Physics', 'C201', 'g-phy'),
        lesson(tomorrow, '10:45', '11:30', 'Chemistry', 'D404', 'g-chem'),
      ],
    },
    managebac: {
      fetchedAt: new Date(FIXED_NOW).toISOString(),
      tasks: [
        { id: 't1', title: 'Math problem set 4', courseName: 'Mathematics', dueAt: shanghaiStamp(2, 23, 59) },
        { id: 't2', title: 'English essay draft', courseName: 'English', dueAt: shanghaiStamp(1, 23, 59) },
        { id: 't3', title: 'Physics lab report', courseName: 'Physics', dueAt: shanghaiStamp(20, 23, 59) },
        { id: 't4', title: 'History reading', courseName: 'History', dueAt: shanghaiStamp(-3, 23, 59) },
      ],
    },
    preferences: { accountKey: 'acc-1', groups: ['g-math', 'g-eng', 'g-phy', 'g-chem'] },
  };
}

function harness({ snapshot, unread = 3, failSnapshot = false } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><main class="page active" id="todayPage">'
    + '<strong id="nextClassName"></strong><small id="nextClassMeta"></small>'
    + '<strong id="todayTaskMetric"></strong><small id="overdueMetric"></small>'
    + '<strong id="unreadMailCount"></strong>'
    + '<div id="dashboardDeadlines"></div><div id="dashboardTimetable"></div>'
    + '</main></body></html>');
  const calls = { get: [] };
  window.ph = { school: { get: async (options) => { calls.get.push(options); if (failSnapshot) throw new Error('boom'); return snapshot; } } };
  window.mailUI = { unreadCount: () => unread };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date: FixedDate, Number, Object, Array, String, Math, RegExp, JSON, Map, Set, Intl });
  return { window, document: window.document, calls };
}

test('the dashboard asks for the current week instead of an empty snapshot', async () => {
  const ui = harness({ snapshot: schoolSnapshot() });
  await ui.window.dashboardData.refresh();
  await settle();
  assert.equal(ui.calls.get.length, 1);
  assert.equal(ui.calls.get[0].weekStart, '2026-09-07', 'the requested week is the Monday of the fixed clock');
  assert.equal(new Date(`${ui.calls.get[0].weekStart}T12:00:00Z`).getUTCDay(), 1);
});

test('dashboard lists today lessons, marks the ongoing class and shows the next one', async () => {
  const ui = harness({ snapshot: schoolSnapshot() });
  await ui.window.dashboardData.refresh();
  await settle();
  const timetable = ui.document.getElementById('dashboardTimetable');
  assert.match(timetable.textContent, /Mathematics/);
  assert.match(timetable.textContent, /A301/);
  assert.match(timetable.textContent, /English/);
  assert.match(timetable.textContent, /Physics/);
  assert.doesNotMatch(timetable.textContent, /Chemistry/, "tomorrow's lesson stays out of the today card");

  const nowLines = [...timetable.querySelectorAll('.dashboard-lesson-line.is-now')];
  assert.equal(nowLines.length, 1, 'exactly the lesson spanning the clock is marked');
  assert.match(nowLines[0].textContent, /English/);

  assert.equal(ui.document.getElementById('nextClassName').textContent, '正在上课：English');
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /下一节：Physics/);
  assert.match(ui.document.getElementById('nextClassMeta').textContent, /C201/);
});

test('the hero line reports the next lesson when nothing is in progress', async () => {
  const snapshot = schoolSnapshot();
  snapshot.edupage.lessons = snapshot.edupage.lessons.filter((lesson) => lesson.course !== 'English');
  const ui = harness({ snapshot });
  await ui.window.dashboardData.refresh();
  await settle();
  assert.equal(ui.document.getElementById('nextClassName').textContent, '当前没有课程');
  const meta = ui.document.getElementById('nextClassMeta').textContent;
  assert.match(meta, /下一节：Physics/);
  assert.match(meta, /11:00–11:45/);
  assert.equal(ui.document.querySelectorAll('#dashboardTimetable .is-now').length, 0);
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
  const context = { window: {}, Date: FixedDate, Number, Object, Array, String, Intl };
  vm.runInNewContext(source, context);
  const snapshot = schoolSnapshot();
  snapshot.preferences = {};
  const view = context.window.dashboardData.project(snapshot, FIXED_NOW);
  assert.equal(view.selectionReady, false);
  assert.equal(view.current, undefined);
  assert.equal(view.next, undefined);
  assert.equal(view.tasks.length, 2);
});
