'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ReminderScheduler, MAX_PENDING_REMINDERS } = require('../electron/reminders.cjs');
const { courseReminders } = require('../electron/course-reminders.cjs');
const { createReminderWindowManager, MAX_REMINDER_WINDOW_QUEUE } = require('../electron/reminder-window.cjs');

function expectedReminderUrl() { return pathToFileURL(path.join(__dirname, '..', 'src', 'reminder.html')).href; }

test('rolling sync skips old entries before capacity limits and retries waiting groups without crashing', () => {
  let now = 2_000;
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: () => 1, clearTimer() {} });
  const past = Array.from({ length: 1100 }, (_, i) => ({ id: `calendar:past-${i}`, title: 'Past event', dueAt: 500 }));
  scheduler.syncGroup('calendar:', [...past, { id: 'calendar:future', title: 'Future event', dueAt: 5_000 }]);
  assert.equal(scheduler.pending.size, 1);
  assert.ok(scheduler.pending.has('calendar:future'));
  const courses = Array.from({ length: 1000 }, (_, i) => ({ id: `course:future-${i}`, title: 'Lesson', dueAt: 10_000 + i }));
  assert.doesNotThrow(() => scheduler.syncGroup('course:', courses));
  assert.equal(scheduler.pending.size, MAX_PENDING_REMINDERS);
  scheduler.syncGroup('calendar:', []);
  scheduler.syncGroup('course:', courses);
  assert.ok(scheduler.pending.has('course:future-999'));
  scheduler.syncGroup('course:', [{ id: 'course:new', title: 'Changed lesson', dueAt: 6_000 }]);
  assert.equal(scheduler.pending.size, 1);
  assert.ok(scheduler.pending.has('course:new'));
  now = 6_000; scheduler.flush();
  assert.ok(scheduler.fired.has('course:new'));
});

function fakeWindows() {
  const windows = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options; this.listeners = new Map(); this.onceListeners = new Map(); this.destroyed = false; this.shown = 0; this.focused = 0;
      this.webContents = { mainFrame: { id: `frame-${windows.length}` }, sends: [], on() {}, setWindowOpenHandler() {}, getURL: () => expectedReminderUrl(), send: (...args) => this.webContents.sends.push(args) };
      windows.push(this);
    }
    setMenuBarVisibility() {}
    once(name, callback) { this.onceListeners.set(name, callback); }
    on(name, callback) { this.listeners.set(name, callback); }
    emit(name) { (this.onceListeners.get(name) || this.listeners.get(name))?.(); }
    loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    close() { if (this.destroyed) return; this.destroyed = true; this.listeners.get('closed')?.(); }
    destroy() { this.close(); }
  }
  class FakeIpcMain {
    constructor() { this.listeners = new Map(); }
    on(name, callback) { this.listeners.set(name, callback); }
    removeListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    emit(name, event) { this.listeners.get(name)?.(event); }
  }
  const ipcMain = new FakeIpcMain();
  return { BrowserWindow: FakeBrowserWindow, ipcMain, windows, eventFor(window, overrides = {}) { return { sender: window.webContents, senderFrame: window.webContents.mainFrame, ...overrides }; } };
}

test('scheduler deduplicates, fires once, and snoozes an active reminder to a real later time', () => {
  let now = 1_000;
  let callback;
  const shown = [];
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => {}, onDue: (item) => shown.push(item) });
  assert.equal(scheduler.schedule({ id: 'focus:1', title: '专注完成', dueAt: 1_500 }), true);
  assert.equal(scheduler.schedule({ id: 'focus:1', title: '重复', dueAt: 1_500 }), true);
  now = 1_500; callback();
  assert.equal(shown.length, 1);
  assert.equal(scheduler.schedule({ id: 'focus:1', title: '重复', dueAt: 2_000 }), false);
  assert.equal(scheduler.schedule({ id: 'calendar:a:1', title: '日程', dueAt: 2_000 }), true);
  now = 2_000; callback();
  assert.equal(shown.length, 2);
  assert.equal(scheduler.snooze('calendar:a:1', 5), true);
  now += 5 * 60_000; callback();
  assert.equal(shown.length, 3);
});

test('calendar sync skips old all-day events and schedules only explicit advance reminders', () => {
  let now = new Date('2030-01-01T08:00:00').getTime();
  const scheduled = [];
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: () => 1, clearTimer: () => {}, onDue: (item) => scheduled.push(item) });
  scheduler.syncCalendar([
    { id: 'no-reminder', title: '全天', date: '2030-01-01', start: '', reminderMinutes: 0 },
    { id: 'lesson', title: '日程', date: '2030-01-01', start: '08:15', reminderMinutes: 10 },
  ]);
  now = new Date('2030-01-01T08:05:00').getTime(); scheduler.flush();
  assert.equal(scheduled.length, 1);
  assert.match(scheduled[0].id, /^calendar:lesson:/);
});

test('calendar and course reminders are independent for advance and on-time alerts', () => {
  const startAt = new Date('2030-01-01T08:10:00').getTime();
  let now = startAt - 10 * 60_000;
  const due = [];
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: () => 1, clearTimer: () => {}, onDue: (item) => due.push(item) });
  scheduler.syncCalendar([{ id: 'calendar-1', title: '日程', date: '2030-01-01', start: '08:10', reminderMinutes: 0 }]);
  scheduler.syncGroup('course:', courseReminders({ now: new Date(now), defaultMinutes: 10, schedule: [{ id: 'course-1', course: '数学', enabled: true, date: '2030-01-01', start: '08:10', remindMinutes: 10 }] }));
  scheduler.flush();
  assert.equal(due.filter((item) => item.id.startsWith('course:')).length, 1);
  assert.equal(due.filter((item) => item.id.startsWith('calendar:')).length, 0);
  now = startAt; scheduler.flush();
  assert.equal(due.filter((item) => item.id.startsWith('calendar:')).length, 1);
});

test('course reminders exclude unselected, cancelled, and other-account EduPage lessons', () => {
  const reminders = courseReminders({ now: new Date('2030-01-01T08:00:00+08:00'), preferences: { accountKey: 'account-a', groups: ['mine'], courseReminderMinutes: 10 }, schedule: [
    { id: 'old', source: 'edupage-dated', schoolAccount: 'account-b', enabled: true, date: '2030-01-01', start: '09:00', remindMinutes: 10 },
  ], schoolWeeks: [{ source: 'edupage', accountKey: 'account-a', lessons: [
    { id: 'mine', groupKey: 'mine', course: 'Physics', date: '2030-01-02', start: '09:00' },
    { id: 'other-group', groupKey: 'other', course: 'Art', date: '2030-01-02', start: '09:00' },
    { id: 'cancelled', groupKey: 'mine', cancelled: true, course: 'Chemistry', date: '2030-01-02', start: '09:00' },
  ] }, { source: 'edupage', accountKey: 'account-b', lessons: [{ id: 'other-account', groupKey: 'mine', course: 'History', date: '2030-01-02', start: '09:00' }] }] });
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].body, /Physics/);
});

test('school next-day times use the EduPage timezone', () => {
  const reminders = courseReminders({ now: new Date('2030-01-01T15:59:00Z'), preferences: { accountKey: 'account-a', groups: ['mine'], courseReminderMinutes: 5 }, schoolWeeks: [{ source: 'edupage', accountKey: 'account-a', lessons: [{ id: 'next-day', groupKey: 'mine', course: 'English', date: '2030-01-02', start: '00:05' }] }] });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].dueAt, Date.parse('2030-01-01T16:00:00Z'));
});

test('school reminder preference uses zero for on-time and null for off', () => {
  const base = { now: new Date('2030-01-01T08:00:00+08:00'), schoolWeeks: [{ source: 'edupage', accountKey: 'account-a', lessons: [{ id: 'lesson', groupKey: 'mine', course: 'English', date: '2030-01-02', start: '09:00' }] }] };
  const onTime = courseReminders({ ...base, preferences: { accountKey: 'account-a', groups: ['mine'], courseReminderMinutes: 0 } });
  const off = courseReminders({ ...base, preferences: { accountKey: 'account-a', groups: ['mine'], courseReminderMinutes: null } });
  assert.equal(onTime.length, 1); assert.equal(onTime[0].title, '上课时间到了');
  assert.deepEqual(off, []);
});

test('sync keeps a snoozed reminder, does not redeliver fired items, and removes deleted items', () => {
  let now = 1_000; const due = []; const canceled = [];
  const item = { id: 'course:a', title: '课程', dueAt: 1_500 };
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: () => 1, clearTimer: () => {}, onDue: (value) => due.push(value), onCancel: (id) => canceled.push(id) });
  scheduler.syncGroup('course:', [item]); now = 1_500; scheduler.flush();
  scheduler.syncGroup('course:', [item]); scheduler.flush();
  assert.equal(due.length, 1, 'a fired reminder survives repeated sync without another popup');
  assert.equal(scheduler.snooze(item.id, 5), true);
  scheduler.syncGroup('course:', [item]); now += 4 * 60_000; scheduler.flush();
  assert.equal(due.length, 1, 'sync does not overwrite the snoozed due time');
  now += 60_000; scheduler.flush(); assert.equal(due.length, 2);
  scheduler.syncGroup('course:', []);
  assert.deepEqual(canceled, [item.id]);
});

test('deleting a scheduled reminder withdraws its queued popup window', () => {
  let now = 1_000;
  const fake = fakeWindows();
  const manager = createReminderWindowManager({ ...fake, path });
  const scheduler = new ReminderScheduler({ now: () => now, setTimer: () => 1, clearTimer: () => {}, onDue: (item) => manager.enqueue(item), onCancel: (id) => manager.remove(id) });
  scheduler.schedule({ id: 'calendar:one', title: '第一条', dueAt: 1_500 });
  scheduler.schedule({ id: 'calendar:two', title: '第二条', dueAt: 1_500 });
  now = 1_500; scheduler.flush();
  assert.equal(fake.windows.length, 1);
  scheduler.cancel('calendar:two');
  fake.windows[0].close();
  assert.equal(fake.windows.length, 1, 'the deleted reminder never receives its queued window');
  manager.dispose();
});

test('pending scheduler and reminder-window queues have hard upper bounds', () => {
  const scheduler = new ReminderScheduler({ now: () => 0, setTimer: () => 1, clearTimer: () => {} });
  for (let index = 0; index < MAX_PENDING_REMINDERS; index++) scheduler.schedule({ id: `focus:${index}`, title: '提醒', dueAt: 1_000 + index });
  assert.equal(scheduler.schedule({ id: 'focus:overflow', title: '提醒', dueAt: 2_000 }), false);
  const fake = fakeWindows(); const manager = createReminderWindowManager({ ...fake, path });
  for (let index = 0; index < MAX_REMINDER_WINDOW_QUEUE; index++) assert.equal(manager.enqueue({ id: `window:${index}`, title: '提醒' }), true);
  assert.equal(manager.enqueue({ id: 'window:overflow', title: '提醒' }), false);
  manager.dispose();
});

test('reminder window rejects iframe and foreign IPC, snoozes once, and cancellation withdraws queued windows', () => {
  const fake = fakeWindows(); const snoozed = []; const closed = [];
  const manager = createReminderWindowManager({ ...fake, path, onSnooze: (item, minutes) => snoozed.push([item.id, minutes]), onClose: (item) => closed.push(item.id) });
  manager.enqueue({ id: 'one', title: '第一条' }); manager.enqueue({ id: 'two', title: '第二条' });
  const first = fake.windows[0]; first.emit('ready-to-show');
  fake.ipcMain.emit('reminder:snooze', fake.eventFor(first, { senderFrame: { id: 'iframe' } }));
  fake.ipcMain.emit('reminder:snooze', { sender: { getURL: () => expectedReminderUrl() }, senderFrame: first.webContents.mainFrame });
  assert.deepEqual(snoozed, []);
  fake.ipcMain.emit('reminder:snooze', fake.eventFor(first));
  fake.ipcMain.emit('reminder:snooze', fake.eventFor(first));
  assert.deepEqual(snoozed, [['one', 5]]);
  assert.equal(fake.windows.length, 2);
  const second = fake.windows[1]; second.emit('ready-to-show');
  manager.remove('two');
  assert.deepEqual(closed, [], 'snoozed and cancelled reminders are not treated as user dismissals');
  manager.dispose();
});

test('reminder window passes only validated appearance and language to its own renderer', () => {
  const fake = fakeWindows();
  const manager = createReminderWindowManager({ ...fake, path, getAppearance: () => ({ preset: 'ocean', primary: '#fff', paper: 'not-a-color' }), getLanguage: () => 'en' });
  manager.enqueue({ id: 'ocean', title: '用户标题', body: '用户正文', dueAt: 1_000 });
  const window = fake.windows[0];
  assert.equal(window.options.backgroundColor, '#edf3f7');
  window.emit('ready-to-show');
  assert.deepEqual(window.webContents.sends, [['reminder:show', { id: 'ocean', title: '用户标题', body: '用户正文', dueAt: 1_000, appearance: { primary: '#203f60', paper: '#edf3f7', lang: 'en' } }]]);
  manager.dispose();
});

test('an early closed or disposed window cannot show its reminder in a newer window', () => {
  const fake = fakeWindows(); const manager = createReminderWindowManager({ ...fake, path });
  manager.enqueue({ id: 'one', title: '第一条' }); manager.enqueue({ id: 'two', title: '第二条' });
  const first = fake.windows[0]; first.close();
  const second = fake.windows[1]; first.emit('ready-to-show');
  assert.equal(first.webContents.sends.length, 0);
  second.emit('ready-to-show'); assert.deepEqual(second.webContents.sends[0], ['reminder:show', { id: 'two', title: '第二条', appearance: { primary: '#173f33', paper: '#f5f2e9', lang: 'zh-CN' } }]);
  manager.dispose(); second.emit('ready-to-show');
  assert.equal(second.webContents.sends.length, 1);
});
