'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, preferences } = require('../electron/task-reminders.cjs');
const { submitted } = require('../src/school-tasks.js');
const now = Date.parse('2026-11-03T02:00:00Z');
const hour = 3600000;
const task = (id, hours = 48, extra = {}) => ({ id: `managebac:21:${id}`, courseId: '21', course: 'Biology', title: `Task ${id}`, dueAt: new Date(now + hours * hour).toISOString(), status: 'Pending', ...extra });
const snapshot = (tasks, extra = {}) => ({ accountKey: 'a', fetchedAt: new Date(now).toISOString(), courses: [{ id: '21' }], tasks, taskSyncedCourses: ['21'], ...extra });
const run = (tasks, options = {}) => evaluate({ snapshot: snapshot(tasks), accountKey: 'a', now, ...options });
const baseline = () => run([task(1)]).state;

test('first sync baselines historical work; later new tasks are delivered once across restart', () => {
  assert.deepEqual(run([task(1)]).alerts, []);
  const second = run([task(1), task(2)], { state: baseline() });
  assert.deepEqual(second.alerts.map(a => a.type), ['new']);
  const restart = run([task(1), task(2)], { state: JSON.parse(JSON.stringify(second.state)) });
  assert.deepEqual(restart.alerts, []); assert.equal(restart.changed, false);
});
test('deadline stages fire once and a sleeping app receives only the closest reminder', () => {
  const tasks = [task(1, 23)];
  let result = run(tasks);
  assert.deepEqual(result.alerts.map(a => a.type), ['due']);
  assert.equal(run(tasks, { state: result.state }).alerts.length, 0);
  const wake = now + 22.5 * hour;
  result = run(tasks, { state: result.state, now: wake, snapshot: snapshot(tasks, { fetchedAt: new Date(wake).toISOString() }) });
  assert.deepEqual(result.alerts.map(a => a.type), ['due']);
  assert.equal(run([task(1, .5)]).alerts.length, 1);
  assert.equal(run([task(1, -1)]).alerts.length, 0);
});
test('new and urgent task produces one combined alert, not two popups', () => {
  const result = run([task(1), task(2, .5)], { state: baseline() });
  assert.deepEqual(result.alerts.map(a => a.type), ['new-due']);
  assert.equal(run([task(2, .5)], { state: result.state }).alerts.length, 0);
});
test('rescheduled deadlines get a new reminder without being counted as new work', () => {
  const previous = run([task(1, 23)]);
  const result = run([task(1, 20)], { state: previous.state });
  assert.deepEqual(result.alerts.map(a => a.type), ['due']);
});
test('submitted, hidden and invalid-date tasks do not trigger deadline reminders', () => {
  const tasks = [task(1, 1, { status: 'Submitted / Ungraded' }), task(2, 1), task(3, 1, { dueAt: 'invalid' })];
  assert.equal(run(tasks, { hiddenTasks: [task(2).id] }).alerts.length, 0);
  assert.equal(run([task(1, 1, { status: 'Not yet submitted' })]).alerts.length, 1);
  assert.equal(submitted({ status: 'Please resubmit' }), false);
  assert.equal(submitted({ status: 'Not assessed' }), false);
});
test('failure/partial course reads preserve seen ids and do not announce the first successful course', () => {
  const first = run([task(1)]);
  const partial = run([], { state: first.state, snapshot: snapshot([], { taskSyncedCourses: [], warnings: ['partial'] }) });
  assert.equal(run([task(1)], { state: partial.state }).alerts.length, 0);
  const empty = run([], { snapshot: snapshot([], { taskSyncedCourses: [], warnings: ['partial'] }) });
  assert.equal(run([task(1)], { state: empty.state }).alerts.length, 0);
});
test('account changes baseline independently and old-account snapshots cannot fire', () => {
  const previous = baseline();
  assert.equal(run([task(2)], { state: previous, accountKey: 'b' }).changed, false);
  assert.equal(run([task(2)], { state: previous, accountKey: 'b', snapshot: snapshot([task(2)], { accountKey: 'b' }) }).alerts.length, 0);
});
test('disabled new alerts do not queue a backlog; deadline setting is independent', () => {
  let result = run([task(1), task(2)], { state: baseline(), settings: { newTasks: false, deadlines: false } });
  assert.equal(result.alerts.length, 0);
  result = run([task(1), task(2)], { state: result.state });
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(preferences({ minutes: [60, 60, 9, '1440'] }).minutes, [60]);
});
test('stale offline snapshots do not issue misleading deadline alerts', () => {
  assert.equal(run([task(1, 1)], { snapshot: snapshot([task(1, 1)], { fetchedAt: new Date(now - hour).toISOString() }) }).alerts.length, 0);
});
test('task identities and labels cannot grow the reminder state unboundedly', () => {
  const result = run(Array.from({ length: 12000 }, (_, i) => task(i)));
  assert.equal(Object.keys(result.state.entries).length, 2000);
  assert.doesNotMatch(JSON.stringify(result.state), /Biology|Task /);
});

test('reminder inbox replaces deadline stages and clears submitted, hidden and rescheduled items', () => {
  const { pendingAlerts } = require('../electron/task-reminders.cjs');
  const tasks = [task(1, 23)]; let result = run(tasks);
  assert.equal(pendingAlerts(result.state, snapshot(tasks)).length, 1);
  const wake = now + 22.5 * hour;
  result = run(tasks, { state: result.state, now: wake, snapshot: snapshot(tasks, { fetchedAt: new Date(wake).toISOString() }) });
  assert.equal(Object.keys(result.state.inbox).length, 1);
  assert.equal(pendingAlerts(result.state, snapshot([...tasks, ...tasks])).length, 1);
  for (const replacement of [task(1, 23, { status: 'Submitted / Ungraded' }), task(1, 100)]) {
    const next = run([replacement], { state: result.state });
    assert.equal(pendingAlerts(next.state, snapshot([replacement])).length, 0);
  }
  const hidden = run(tasks, { state: result.state, hiddenTasks: [tasks[0].id] });
  assert.deepEqual(Object.keys(hidden.state.inbox), []);
});


test('retained stale assignments never issue reminders or consume delivery stages', () => {
  const stale = run([task(1,.5,{stale:true})], {state:baseline()});
  assert.equal(stale.alerts.length,0);
  assert.equal(run([task(1,.5)],{state:stale.state}).alerts.length,1);
});
