'use strict';

const MAX_PENDING_REMINDERS = 1_000;
const MAX_FIRED_KEYS = 5_000;
const MAX_TIMER_DELAY = 2_147_000_000;

function validReminder(input) {
  if (!input || typeof input !== 'object') throw new Error('提醒格式无效');
  const id = String(input.id || '').trim();
  const title = String(input.title || '').trim().slice(0, 160);
  const dueAt = Number(input.dueAt);
  if (!/^[a-z0-9:_-]{1,160}$/i.test(id) || !title || !Number.isFinite(dueAt)) throw new Error('提醒格式无效');
  return { id, title, body: String(input.body || '').trim().slice(0, 800), dueAt };
}

class ReminderScheduler {
  constructor({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, onDue = () => {}, onCancel = () => {} } = {}) {
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.onDue = onDue;
    this.onCancel = onCancel;
    this.pending = new Map(); this.fired = new Set(); this.delivered = new Map(); this.snoozed = new Set(); this.timer = null;
  }
  schedule(input) {
    const reminder = validReminder(input);
    if (this.fired.has(reminder.id) || reminder.dueAt < this.now()) return false;
    if (this.snoozed.has(reminder.id)) return true;
    if (!this.pending.has(reminder.id) && this.pending.size >= MAX_PENDING_REMINDERS) return false;
    this.pending.set(reminder.id, reminder); this.arm(); return true;
  }
  cancel(id) { id = String(id); const pending = this.pending.delete(id); const delivered = this.delivered.delete(id); this.snoozed.delete(id); if (pending || delivered) this.onCancel(id); this.arm(); return pending || delivered; }
  snooze(id, minutes = 5) {
    const previous = this.pending.get(String(id)) || this.delivered.get(String(id));
    if (!previous || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) return false;
    this.delivered.delete(previous.id); this.fired.delete(previous.id); this.snoozed.add(previous.id);
    this.pending.set(previous.id, { ...previous, dueAt: this.now() + minutes * 60_000 }); this.arm(); return true;
  }
  syncGroup(prefix, items) {
    if (!['calendar:', 'course:'].includes(prefix)) throw new Error('提醒类型无效');
    const wanted = new Set();
    const upcoming = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.id?.startsWith(prefix)) continue;
      let reminder;
      try { reminder = validReminder(item); } catch { continue; }
      wanted.add(reminder.id);
      if (reminder.dueAt >= this.now() || this.snoozed.has(reminder.id)) upcoming.push(reminder);
    }
    for (const id of new Set([...this.pending.keys(), ...this.delivered.keys()])) if (id.startsWith(prefix) && !wanted.has(id)) this.cancel(id);
    upcoming.sort((a, b) => a.dueAt - b.dueAt);
    for (const reminder of upcoming) this.schedule(reminder);
    this.arm();
  }
  syncCalendar(events) {
    const items = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.reminderMinutes === null || event?.reminderMinutes === undefined) continue;
      const minutes = Number(event.reminderMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(event?.date || '') || !/^\d{2}:\d{2}$/.test(event?.start || '')) continue;
      const dueAt = new Date(`${event.date}T${event.start}:00`).getTime() - minutes * 60_000;
      const id = `calendar:${event.id}:${event.date}:${event.start}:${minutes}`;
      items.push({ id, title: `日程提醒：${event.title}`, body: `${minutes === 0 ? '现在开始' : `${minutes} 分钟后`} · ${event.date} ${event.start}${event.notes ? `\n${String(event.notes).slice(0,400)}` : ''}`, dueAt });
    }
    this.syncGroup('calendar:', items);
  }
  arm() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    let next = null;
    for (const reminder of this.pending.values()) if (!next || reminder.dueAt < next.dueAt) next = reminder;
    if (!next) return;
    this.timer = this.setTimer(() => this.flush(), Math.max(1, Math.min(MAX_TIMER_DELAY, next.dueAt - this.now())));
  }
  flush() {
    this.timer = null;
    const now = this.now();
    for (const [id, reminder] of this.pending) {
      if (reminder.dueAt > now) continue;
      this.pending.delete(id);
      if (this.fired.has(id)) continue;
      this.fired.add(id);
      this.delivered.set(id, reminder);
      if (this.fired.size > MAX_FIRED_KEYS) { const oldest = this.fired.values().next().value; this.fired.delete(oldest); this.delivered.delete(oldest); this.snoozed.delete(oldest); }
      this.onDue({ ...reminder });
    }
    this.arm();
  }
  notifyNow(input) {
    const reminder = validReminder({ ...input, dueAt: this.now() + 1 });
    if (this.fired.has(reminder.id) || this.pending.has(reminder.id)) return false;
    if (this.pending.size >= MAX_PENDING_REMINDERS) throw new Error('提醒数量已达上限');
    this.pending.set(reminder.id, reminder); this.arm(); return true;
  }
  dispose() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.pending.clear(); this.delivered.clear(); this.snoozed.clear(); }
}

module.exports = { ReminderScheduler, validReminder, MAX_PENDING_REMINDERS };
