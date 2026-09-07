'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_MAIL_TOOLS,
  AI_TOOLS,
  PendingActionStore,
  applyActions,
  createAction,
  relevantDataHash,
  sanitizeCalendarEvents,
  toolKind,
} = require('../electron/ai-tools.cjs');

const base = () => ({ notes: [], tasks: [], schedule: [], calendarEvents: [], settings: {} });
const event = (overrides = {}) => ({
  title: 'University information session', date: '2026-10-12', start: '18:30', end: '19:30',
  notes: 'Online presentation described in the selected school email.', reminderMinutes: 15, ...overrides,
});

test('weekly events retain weekdays through proposal and commit; invalid weekdays are rejected', () => {
  const data=base();
  const action=createAction('create_calendar_events',{events:[event({repeatWeekdays:[7,3,7]})]},data);
  const store=new PendingActionStore(); const proposal=store.create([action],data);
  assert.deepEqual(proposal.groups[0].items[0].repeatWeekdays,[3,7]);
  const result=store.commit(proposal.id,data);
  assert.deepEqual(result.data.calendarEvents[0].repeatWeekdays,[3,7]);
  assert.throws(()=>sanitizeCalendarEvents([event({repeatWeekdays:[0]})]),/无效/);
});

test('mail-derived calendar events remain a pending confirmation and commit at most once', () => {
  const data = base();
  const action = createAction('create_calendar_events', { events: [
    event(),
    event({ title: 'Campus admissions talk', date: '2026-10-18', start: '14:00', end: '15:00', reminderMinutes: null }),
  ] }, data);
  const store = new PendingActionStore();
  const proposal = store.create([action], data, { title: '大学宣讲会日程' });
  assert.equal(data.calendarEvents.length, 0, 'creating a proposal cannot write calendar data');
  assert.equal(proposal.requiresConfirmation, true);
  assert.equal(proposal.groups[0].type, 'calendar-events');
  assert.equal(proposal.groups[0].items.length, 2);
  const result = store.commit(proposal.id, data);
  assert.equal(result.counts.calendarEvents, 2);
  assert.equal(result.data.calendarEvents.length, 2);
  assert.equal(data.calendarEvents.length, 0, 'commit returns new data without mutating the input');
  assert.throws(() => store.commit(proposal.id, data), /过期|已经处理/);
});

test('calendar proposals require exact real dates, times and the fixed reminder choices', () => {
  for (const invalid of [
    event({ date: '10-12' }), event({ date: '2026-02-29' }), event({ date: '2026-10-12T00:00:00Z' }),
    event({ start: '6:30' }), event({ end: '18:00' }), event({ reminderMinutes: 20 }),
  ]) assert.throws(() => sanitizeCalendarEvents([invalid]), /日期|时间|提醒/);
  assert.throws(() => sanitizeCalendarEvents(Array.from({ length: 13 }, () => event())), /1–12/);
  assert.deepEqual(sanitizeCalendarEvents([event({ reminderMinutes: 0 })])[0].reminderMinutes, 0);
});

test('same title, date and start is unchanged while existing calendar events are preserved', () => {
  const existing = { id: 'existing', color: 'purple', ...event({ notes: 'Original user note', reminderMinutes: 5 }) };
  const data = { ...base(), calendarEvents: [existing] };
  const duplicate = createAction('create_calendar_events', { events: [event({ end: '20:00', notes: 'AI replacement must not overwrite', reminderMinutes: 60 })] }, data);
  const result = applyActions(data, [duplicate]);
  assert.equal(result.counts.calendarEvents, 0);
  assert.equal(result.counts.unchanged, 1);
  assert.deepEqual(result.data.calendarEvents, [existing]);
  assert.deepEqual(data.calendarEvents, [existing]);
});

test('calendar changes after preview invalidate the proposal instead of being overwritten', () => {
  const data = base();
  const store = new PendingActionStore();
  const proposal = store.create([createAction('create_calendar_events', { events: [event()] }, data)], data);
  const before = relevantDataHash(data);
  data.calendarEvents.push({ id: 'manual', color: 'green', ...event({ title: 'Manually added event' }) });
  assert.notEqual(relevantDataHash(data), before);
  assert.throws(() => store.commit(proposal.id, data), /数据已发生变化/);
  assert.equal(data.calendarEvents.length, 1);
  assert.equal(data.calendarEvents[0].id, 'manual');
});

test('calendar creation is a guarded write tool and mail search extends only list_mail', () => {
  assert.equal(toolKind('create_calendar_events'), 'write');
  assert.ok(AI_TOOLS.some((tool) => tool.function.name === 'create_calendar_events'));
  const listMail = AI_MAIL_TOOLS.find((tool) => tool.function.name === 'list_mail');
  assert.equal(listMail.function.parameters.properties.query.maxLength, 80);
  assert.equal(listMail.function.parameters.properties.cursor.minimum, 0);
  assert.equal(listMail.function.parameters.properties.cursor.maximum, 100000);
  assert.match(listMail.function.description, /主题或正文/);
  assert.equal(AI_MAIL_TOOLS.some((tool) => /send|报名|发信/i.test(tool.function.name)), false);
});
