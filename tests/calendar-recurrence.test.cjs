'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { normalizeCalendarEvent, occursOn, setCalendarReminderAction, upsertCalendarEvent } = require('../electron/calendar.cjs');
const { calendarReminderItems, ReminderScheduler } = require('../electron/reminders.cjs');

const recurring = normalizeCalendarEvent({ id: 'club', title: '课外课', date: '2030-01-07', start: '16:00', end: '17:00', reminderMinutes: 10, repeatWeekdays: [5, 1, 3, 3] });

test('weekly calendar events normalize weekdays and occur only on selected days from their start date', () => {
  assert.deepEqual(recurring.repeatWeekdays, [1, 3, 5]);
  assert.equal(occursOn(recurring, new Date('2030-01-09T12:00:00')), true);
  assert.equal(occursOn(recurring, new Date('2030-01-10T12:00:00')), false);
  assert.equal(occursOn(recurring, new Date('2030-01-04T12:00:00')), false);
  assert.throws(() => normalizeCalendarEvent({ ...recurring, repeatWeekdays: [0, 8] }));
});

test('complete and cancel apply to one occurrence without deleting future weekly events', () => {
  let events = setCalendarReminderAction([recurring], 'club', '2030-01-09', 'completed');
  events = setCalendarReminderAction(events, 'club', '2030-01-11', 'cancelled');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].repeatWeekdays, [1, 3, 5]);
  assert.deepEqual(events[0].reminderState['2030-01-09'], { action: 'completed' });
  assert.deepEqual(events[0].reminderState['2030-01-11'], { action: 'cancelled' });
  const reminders = calendarReminderItems(events, new Date('2030-01-07T12:00:00').getTime());
  assert.ok(!reminders.some(item => item.occurrenceDate === '2030-01-09'));
  assert.ok(!reminders.some(item => item.occurrenceDate === '2030-01-11'));
  assert.ok(reminders.some(item => item.occurrenceDate === '2030-01-14'));
});

test('a persisted snooze changes only this occurrence and survives scheduler reconstruction', () => {
  const snoozedUntil = new Date('2030-01-09T16:05:00').getTime();
  const events = setCalendarReminderAction([recurring], 'club', '2030-01-09', 'snoozed', { snoozedUntil });
  const items = calendarReminderItems(events, new Date('2030-01-09T15:55:00').getTime());
  const occurrence = items.find(item => item.occurrenceDate === '2030-01-09');
  assert.equal(occurrence.dueAt, snoozedUntil);
  assert.ok(items.some(item => item.occurrenceDate === '2030-01-11'));
  const scheduler = new ReminderScheduler({ now: () => new Date('2030-01-09T15:55:00').getTime(), setTimer: () => 1, clearTimer() {} });
  scheduler.syncCalendar(events);
  assert.equal(scheduler.pending.get(occurrence.id).dueAt, snoozedUntil);
});

test('related file metadata is bounded, preserved on edits, and never contains file contents', () => {
  const filePath = path.resolve('School', 'Alex Zhang', 'draft.pdf');
  const withFile = normalizeCalendarEvent({ ...recurring, attachments: [{ path: filePath, name: 'draft.pdf' }] });
  assert.deepEqual(withFile.attachments, [{ path: filePath, name: 'draft.pdf' }]);
  assert.equal(Object.hasOwn(withFile.attachments[0], 'content'), false);
  const edited = upsertCalendarEvent([withFile], { ...withFile, title: '课外课更新', attachments: undefined });
  assert.deepEqual(edited[0].attachments, withFile.attachments);
  assert.throws(() => normalizeCalendarEvent({ ...recurring, attachments: Array.from({ length: 21 }, (_, index) => ({ path: path.resolve(`f${index}`), name: `f${index}` })) }));
});
