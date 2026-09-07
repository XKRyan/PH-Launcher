const { randomUUID } = require('node:crypto');
const path = require('node:path');

const MAX_CALENDAR_EVENTS = 2000;
const CALENDAR_COLORS = Object.freeze(['green', 'wine', 'gold', 'blue', 'purple', 'slate']);
const CALENDAR_REMINDER_MINUTES = Object.freeze([0, 5, 10, 15, 30, 60]);
const CALENDAR_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const CALENDAR_REMINDER_ACTIONS = Object.freeze(['completed', 'cancelled', 'snoozed']);

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}

function isCalendarTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeWeekdays(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('每周重复日期无效');
  const weekdays = [...new Set(value.map(Number))].sort((a, b) => a - b);
  if (weekdays.some(day => !CALENDAR_WEEKDAYS.includes(day))) throw new Error('每周重复日期无效');
  return weekdays;
}

function normalizeReminderState(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('日程提醒状态无效');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).slice(-400);
  const result = {};
  for (const [date, state] of entries) {
    if (!isCalendarDate(date) || !state || !CALENDAR_REMINDER_ACTIONS.includes(state.action)) throw new Error('日程提醒状态无效');
    if (state.action === 'snoozed' && (!Number.isSafeInteger(state.snoozedUntil) || state.snoozedUntil <= 0)) throw new Error('延后提醒时间无效');
    result[date] = state.action === 'snoozed' ? { action: state.action, snoozedUntil: state.snoozedUntil } : { action: state.action };
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('关联文件列表无效');
  const seen = new Set(); const result = [];
  for (const item of value) {
    const filePath = typeof item?.path === 'string' ? item.path.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!path.isAbsolute(filePath) || filePath.length > 4096 || /[\u0000\r\n]/.test(filePath) || !name || name.length > 255 || /[\u0000\r\n\\/]/.test(name)) throw new Error('关联文件信息无效');
    if (!seen.has(filePath)) { seen.add(filePath); result.push({ path: filePath, name }); }
  }
  return result;
}

function normalizeCalendarEvent(input, { idFactory = randomUUID } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('日程格式无效');
  const id = input.id === undefined || input.id === '' ? idFactory() : input.id;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('日程编号无效');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120 || /[\u0000\r\n]/.test(input.title)) {
    throw new Error('请输入 1 至 120 字的日程标题');
  }
  if (!isCalendarDate(input.date)) throw new Error('请选择有效日期（1900 至 2199 年）');
  const start = input.start === undefined ? '' : input.start;
  const end = input.end === undefined ? '' : input.end;
  if ((start !== '' || end !== '') && (!isCalendarTime(start) || !isCalendarTime(end) || start >= end)) {
    throw new Error('请填写有效的起止时间；结束须晚于开始，跨天日程请分开添加');
  }
  const notes = input.notes === undefined ? '' : input.notes;
  if (typeof notes !== 'string' || notes.length > 4000 || notes.includes('\u0000')) throw new Error('备注最多 4000 字');
  const color = input.color === undefined ? 'green' : input.color;
  if (!CALENDAR_COLORS.includes(color)) throw new Error('请选择有效的日程颜色');
  const reminderMinutes = input.reminderMinutes === undefined || input.reminderMinutes === null || input.reminderMinutes === '' ? null : Number(input.reminderMinutes);
  if (reminderMinutes !== null && (!CALENDAR_REMINDER_MINUTES.includes(reminderMinutes) || !start)) throw new Error('请选择有效的提前提醒时间');
  const repeatWeekdays = normalizeWeekdays(input.repeatWeekdays);
  const reminderState = normalizeReminderState(input.reminderState);
  const attachments = normalizeAttachments(input.attachments);
  const result = { id, title: input.title.trim(), date: input.date, start, end, notes: notes.replaceAll('\r\n', '\n'), color, reminderMinutes };
  if (repeatWeekdays.length) result.repeatWeekdays = repeatWeekdays;
  if (reminderState) result.reminderState = reminderState;
  if (attachments.length) result.attachments = attachments;
  return result;
}

function normalizeCalendarEvents(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const result = [];
  for (const candidate of input.slice(0, MAX_CALENDAR_EVENTS)) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id)) continue;
    try {
      const event = normalizeCalendarEvent(candidate);
      result.push(event);
      seen.add(event.id);
    } catch { /* Invalid imported records cannot enter the calendar. */ }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
}

function upsertCalendarEvent(events, input) {
  const current = normalizeCalendarEvents(events);
  const existing = current.find(event => event.id === input?.id);
  const updated = normalizeCalendarEvent(existing ? {
    ...input,
    reminderState: input.reminderState === undefined ? existing.reminderState : input.reminderState,
    repeatWeekdays: input.repeatWeekdays === undefined ? existing.repeatWeekdays : input.repeatWeekdays,
    attachments: input.attachments === undefined ? existing.attachments : input.attachments,
  } : input);
  const index = current.findIndex((event) => event.id === updated.id);
  if (input?.id && index < 0) throw new Error('这条日程已不存在，请关闭后重新添加');
  if (index < 0) {
    if (current.length >= MAX_CALENDAR_EVENTS) throw new Error('日程数量已达上限，请先删除不需要的日程');
    current.push(updated);
  } else {
    current[index] = updated;
  }
  return normalizeCalendarEvents(current);
}

function removeCalendarEvent(events, id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('日程编号无效');
  return normalizeCalendarEvents(events).filter((event) => event.id !== id);
}

function calendarWeekday(date) { return date.getDay() || 7; }
function occursOn(event, date) {
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return event.repeatWeekdays?.length ? key >= event.date && event.repeatWeekdays.includes(calendarWeekday(date)) : key === event.date;
}

function setCalendarReminderAction(events, eventId, occurrenceDate, action, { snoozedUntil } = {}) {
  if (!CALENDAR_REMINDER_ACTIONS.includes(action) || !isCalendarDate(occurrenceDate)) throw new Error('日程提醒操作无效');
  const current = normalizeCalendarEvents(events);
  const index = current.findIndex(event => event.id === eventId);
  if (index < 0) throw new Error('这条日程已不存在');
  const date = new Date(`${occurrenceDate}T12:00:00`);
  if (!occursOn(current[index], date)) throw new Error('这次日程不存在');
  const state = action === 'snoozed' ? normalizeReminderState({ [occurrenceDate]: { action, snoozedUntil } })[occurrenceDate] : { action };
  current[index] = { ...current[index], reminderState: { ...(current[index].reminderState || {}), [occurrenceDate]: state } };
  return normalizeCalendarEvents(current);
}

module.exports = { MAX_CALENDAR_EVENTS, CALENDAR_COLORS, CALENDAR_REMINDER_MINUTES, CALENDAR_WEEKDAYS, isCalendarDate, isCalendarTime, normalizeCalendarEvent, normalizeCalendarEvents, upsertCalendarEvent, removeCalendarEvent, occursOn, setCalendarReminderAction, normalizeAttachments };
