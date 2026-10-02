'use strict';
// Keeps PH Launcher's calendar and the shared `data/Schedule` file in step.
//
// The two models cannot be copied field for field (the shared format knows a day
// and an optional start time, while the calendar has durations, weekly repeats,
// reminders and attachments), so this module only plans changes:
//
//   * `planImport`  — shared entries the calendar does not know yet (add only)
//   * `planPush`    — local events that must be created or updated in the file
//   * `planRemoval` — shared entries whose local event was deleted and whose
//                     content still matches what the calendar last wrote
//
// Nothing here writes to disk or to the calendar; the caller applies the plans so
// every mutation keeps going through the normal save path.
const shared = require('./shared-schedule.cjs');

const DURATION_MINUTES = 60;

/** Whether the shared format can express this calendar event at all. */
function representable(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.date !== 'string' || !event.date) return false;
  if (typeof event.title !== 'string' || !event.title.trim()) return false;
  if (Array.isArray(event.repeatWeekdays) && event.repeatWeekdays.length) return false;
  const start = event.start === undefined || event.start === null ? '' : event.start;
  return typeof start === 'string' && (start === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start));
}
function sharedIdOf(event) {
  const value = Number(event?.sharedScheduleId);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function signature(day, time, title) {
  return `${day}|${time}|${String(title).trim()}`;
}

/** Shared entries to add to the calendar: unknown ids and unknown content. */
function planImport(events, doc, { idFactory = () => require('node:crypto').randomUUID() } = {}) {
  const linked = new Set();
  const known = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const id = sharedIdOf(event);
    if (id) linked.add(id);
    if (typeof event?.date === 'string') known.add(signature(event.date, event.start || '', event.title || ''));
  }
  const planned = [];
  for (const entry of shared.toLauncherEvents(doc, { durationMinutes: DURATION_MINUTES })) {
    const id = Number(entry.sharedId);
    if (!Number.isSafeInteger(id) || linked.has(id)) continue;
    if (known.has(signature(entry.date, entry.start, entry.title))) continue;
    planned.push({
      id: idFactory(),
      title: entry.title,
      date: entry.date,
      start: entry.start,
      end: entry.end,
      notes: entry.notes || '',
      color: 'blue',
      reminderMinutes: null,
      sharedScheduleId: id,
      source: 'lite',
    });
  }
  return planned;
}

/** Local events that must appear in (or be refreshed in) the shared file. */
function planPush(events, doc) {
  const current = new Map();
  for (const entry of doc && Array.isArray(doc.events) ? doc.events : []) {
    const id = Number(entry?.id);
    if (Number.isSafeInteger(id)) current.set(id, entry);
  }
  const upserts = [];
  const links = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!representable(event)) continue;
    const id = sharedIdOf(event);
    const entry = { day: event.date, time: event.start || '', title: String(event.title).trim().slice(0, 120), note: typeof event.notes === 'string' ? event.notes.trim().slice(0, 400) : '' };
    const existing = id ? current.get(id) : null;
    if (existing && shared.sameSharedEvent(existing, entry)) continue;
    if (!id) {
      // No link yet: adopt an identical shared entry instead of creating a twin.
      const match = [...current.entries()].find(([, item]) => shared.sameSharedEvent(item, entry));
      if (match) { links.push({ launcherId: event.id, sharedId: match[0] }); continue; }
    }
    upserts.push({ ...entry, ...(id ? { matchId: id } : {}), launcherId: event.id });
  }
  return { upserts, links };
}

/** Shared entries to delete because their local event is gone and unchanged. */
function planRemoval(previousEvents, nextEvents, doc) {
  const remaining = new Set((Array.isArray(nextEvents) ? nextEvents : []).map((event) => event?.id));
  const current = new Map();
  for (const entry of doc && Array.isArray(doc.events) ? doc.events : []) {
    const id = Number(entry?.id);
    if (Number.isSafeInteger(id)) current.set(id, entry);
  }
  const removals = [];
  for (const event of Array.isArray(previousEvents) ? previousEvents : []) {
    if (remaining.has(event?.id)) continue;
    const id = sharedIdOf(event);
    if (!id) continue;
    const entry = current.get(id);
    if (!entry) continue;
    // Only remove what this app last wrote; a change from the other application
    // is kept (the local deletion stays local).
    if (shared.sameSharedEvent(entry, { day: event.date, time: event.start || '', title: event.title, note: event.notes || '' })) removals.push(id);
  }
  return removals;
}

module.exports = { DURATION_MINUTES, planImport, planPush, planRemoval, representable, sharedIdOf };
