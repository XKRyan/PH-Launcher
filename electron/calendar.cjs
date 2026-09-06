const { randomUUID } = require('node:crypto');

const MAX_CALENDAR_EVENTS = 2000;
const CALENDAR_COLORS = Object.freeze(['green', 'wine', 'gold', 'blue', 'purple', 'slate']);

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
  return { id, title: input.title.trim(), date: input.date, start, end, notes: notes.replaceAll('\r\n', '\n'), color };
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
  const updated = normalizeCalendarEvent(input);
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

module.exports = { MAX_CALENDAR_EVENTS, CALENDAR_COLORS, isCalendarDate, isCalendarTime, normalizeCalendarEvent, normalizeCalendarEvents, upsertCalendarEvent, removeCalendarEvent };
