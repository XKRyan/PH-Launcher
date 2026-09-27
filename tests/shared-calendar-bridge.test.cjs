'use strict';
// The calendar ⇄ shared Schedule bridge: what gets imported, pushed and removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planImport, planPush, planRemoval, representable, sharedIdOf } = require('../electron/shared-calendar-bridge.cjs');

const doc = (events) => ({ version: 1, kind: 'pinghe-schedule', app: 'Pinghe Launcher Lite', events });
const localEvent = (extra = {}) => ({
  id: 'evt-1', title: '打球', date: '2026-09-12', start: '15:00', end: '16:00', notes: '带球拍', color: 'green', reminderMinutes: null, ...extra,
});

test('only events the shared format can express are mirrored', () => {
  assert.equal(representable(localEvent()), true);
  assert.equal(representable(localEvent({ start: '', end: '' })), true, 'an all-day event has no start time');
  assert.equal(representable(localEvent({ repeatWeekdays: [3] })), false, 'weekly repeats stay local');
  assert.equal(representable(localEvent({ date: '' })), false);
  assert.equal(representable(localEvent({ title: '   ' })), false);
  assert.equal(representable(localEvent({ start: '25:00' })), false);
  assert.equal(representable(null), false);
  assert.equal(sharedIdOf({ sharedScheduleId: 3 }), 3);
  assert.equal(sharedIdOf({ sharedScheduleId: '3' }), 3);
  assert.equal(sharedIdOf({ sharedScheduleId: 0 }), 0);
  assert.equal(sharedIdOf({}), 0);
});

test('shared entries the calendar has never seen are imported once, with a link', () => {
  const sharedDoc = doc([{ id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }, { id: 2, day: '2026-09-13', time: '', title: '全天事项', note: '' }]);
  const planned = planImport([], sharedDoc, { idFactory: () => 'new-event' });
  assert.equal(planned.length, 2);
  assert.deepEqual(planned[0], { id: 'new-event', title: '打球', date: '2026-09-12', start: '15:00', end: '16:00', notes: '带球拍', color: 'blue', reminderMinutes: null, sharedScheduleId: 1, source: 'lite' });
  assert.equal(planned[1].start, '');
  assert.equal(planned[1].end, '');
  assert.equal(planned[1].sharedScheduleId, 2);
  // Linked or identical entries are never imported twice.
  assert.deepEqual(planImport([localEvent({ sharedScheduleId: 1 })], doc([{ id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }])), []);
  assert.deepEqual(planImport([localEvent({ sharedScheduleId: 1 })], sharedDoc).map((item) => item.sharedScheduleId), [2]);
  assert.deepEqual(planImport([localEvent({ id: 'other' })], doc([{ id: 9, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }])), []);
});

test('local events are created, refreshed, adopted or skipped on push', () => {
  const created = planPush([localEvent()], doc([]));
  assert.deepEqual(created.upserts, [{ day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍', launcherId: 'evt-1' }]);
  assert.deepEqual(created.links, []);

  const unchanged = planPush([localEvent({ sharedScheduleId: 1 })], doc([{ id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }]));
  assert.deepEqual(unchanged.upserts, []);
  assert.deepEqual(unchanged.links, []);

  const updated = planPush([localEvent({ sharedScheduleId: 1, notes: '改到 16:00' })], doc([{ id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }]));
  assert.deepEqual(updated.upserts, [{ day: '2026-09-12', time: '15:00', title: '打球', note: '改到 16:00', matchId: 1, launcherId: 'evt-1' }]);

  // An identical unlinked entry is adopted rather than duplicated.
  const adopted = planPush([localEvent()], doc([{ id: 7, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }]));
  assert.deepEqual(adopted.upserts, []);
  assert.deepEqual(adopted.links, [{ launcherId: 'evt-1', sharedId: 7 }]);

  // Unrepresentable local events never reach the file.
  assert.deepEqual(planPush([localEvent({ repeatWeekdays: [3] })], doc([])).upserts, []);
});

test('deleting a local event removes only the shared entry it still owns', () => {
  const linked = localEvent({ sharedScheduleId: 1 });
  const same = doc([{ id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }]);
  assert.deepEqual(planRemoval([linked], [], same), [1]);
  // The other application changed it: keep the file, drop the local event only.
  const changed = doc([{ id: 1, day: '2026-09-12', time: '16:30', title: '打球', note: '带球拍' }]);
  assert.deepEqual(planRemoval([linked], [], changed), []);
  // Still present locally, unlinked, or already gone: nothing to remove.
  assert.deepEqual(planRemoval([linked], [linked], same), []);
  assert.deepEqual(planRemoval([localEvent()], [], same), []);
  assert.deepEqual(planRemoval([linked], [], doc([])), []);
});
