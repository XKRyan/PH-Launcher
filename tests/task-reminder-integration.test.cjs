'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { SchoolCache } = require('../electron/school-cache.cjs');
const taskReminders = require('../electron/task-reminders.cjs');
const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
function harness() {
  let username = 'synthetic-student';
  const account = createHash('sha256').update('managebac:' + username).digest('hex');
  const data = { settings: {} };
  const schoolState = new SchoolCache();
  const tasks = [{ id: 'managebac:21:31', courseId: '21', course: 'Biology', title: 'Lab', status: 'Pending', dueAt: new Date(Date.now() + 1800000).toISOString() }];
  const snapshot = { accountKey: account, fetchedAt: new Date().toISOString(), courses: [{ id: '21' }], tasks, taskSyncedCourses: ['21'] };
  schoolState.current.managebac = snapshot;
  const notifications = []; const events = []; let saves = 0; let fetches = 0; let failSave = false;
  const context = {
    createHash, taskReminders, IS_HEADLESS: false,
    secureStore: { data, save() { if (failSave) throw Error('Disk full'); saves++; } },
    schoolCache: schoolState.current, schoolState, schoolSessionMutations: new Set(), taskUploadInFlight: false,
    credentialVault: { getForFill: () => ({ username }) },
    schoolClient: { async syncManageBac(options) { fetches++; assert.equal(options.refreshGrades, false); return { ...snapshot }; } },
    publishSchoolSnapshot() {},
    showNotification(title, body, onClick) { assert.ok(saves > 0, 'persist before delivery'); notifications.push({ title, body, onClick }); return true; },
    sendToRenderer: (...args) => events.push(args),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function managebacReminderAccount()'), source.indexOf('function runCommand(')), context);
  return { context, data, schoolState, snapshot, notifications, events, switchAccount: () => { username = 'another-student'; }, failSave: () => { failSave = true; }, fetches: () => fetches };
}
test('integration persists deadline delivery and routes a clicked alert to pending tasks', () => {
  const h = harness(); h.context.checkTaskReminders();
  assert.equal(h.notifications.length, 1);
  h.context.checkTaskReminders(); assert.equal(h.notifications.length, 1);
  h.notifications[0].onClick(); assert.deepEqual(h.events.at(-1), ['shortcut:action', 'school-tasks']);
  h.switchAccount(); const count = h.events.length; h.notifications[0].onClick(); assert.equal(h.events.length, count);
});
test('failed persistence does not display or consume an alert', () => {
  const h = harness(); h.failSave(); h.context.checkTaskReminders();
  assert.equal(h.data.taskReminderState, undefined); assert.equal(h.notifications.length, 0);
});
test('background refresh coalesces overlapping checks and uses lightweight reads only', async () => {
  const h = harness();
  await Promise.all([h.context.refreshTaskReminders(), h.context.refreshTaskReminders()]);
  assert.equal(h.fetches(), 1); assert.equal(h.notifications.length, 1);
  assert.equal(h.events.at(-1)[0], 'school:synced');
});
test('background refresh never authenticates absent, expired or mismatched sessions', async () => {
  for (const scenario of ['missing', 'changed', 'uploading']) {
    const h = harness();
    if (scenario === 'missing') h.schoolState.current.managebac = null;
    if (scenario === 'changed') h.switchAccount();
    if (scenario === 'uploading') h.context.taskUploadInFlight = true;
    await h.context.refreshTaskReminders(); assert.equal(h.fetches(), 0, scenario);
  }
});
test('a failed read that expires a session is not retried by later polling', async () => {
  const h = harness(); let calls = 0;
  h.context.schoolClient.syncManageBac = async () => { calls++; const error = new Error('Expired'); error.code = 'LOGIN_REQUIRED'; throw error; };
  await h.context.refreshTaskReminders(); await h.context.refreshTaskReminders();
  assert.equal(calls, 1); assert.equal(h.notifications.length, 0);
});
