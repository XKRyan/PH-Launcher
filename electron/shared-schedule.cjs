'use strict';
// PH Launcher 与 Pinghe Launcher Lite(PLL)共用的日程文件 `data/Schedule` 读写模块。
// 文件格式由双方共同遵守的规范约定(Lite 仓库根 DATA-FORMAT.md §3):
//   { version: 1, kind: 'pinghe-schedule', app: '最后写入者', updated_at: '…+08:00',
//     events: [{ id, day: 'YYYY-MM-DD', time: 'HH:MM' 或 '', title, note, created }] }
//
// 实现约定:
// - 读取永远容错: 文件缺失/为空/损坏/字段不合规时返回可直接使用的文档(必要时在内存里
//   修复并标记 repaired), 绝不抛错, 绝不在读取路径上写盘, 绝不自动删除文件。
// - 写入一律"读-改-写 + 同目录临时文件 + renameSync 原子替换": UTF-8 无 BOM、\n 换行、
//   2 空格缩进, 与 PLL 的写盘风格保持一致。
// - 并发保护: 写入前重读目标文件的 mtimeMs 与字节数, 与读取时不一致说明对方先写了一步,
//   此时重做一次读-改-写; 若再次撞车则照写(最后写入者胜)并在结果上标记 contended: true。
// - 事件 id 为全文件唯一自增整数, 删除后不复用。除事件内的最大 id 外, 本模块还在文档上
//   维护高水位字段 lastId(记录分配过的最大 id)。该字段对 PLL 是未知字段, 按规范 §2.3
//   "写回时保留全部未知字段"的兼容规则, PLL 写回时会原样保留, 不会造成冲突。
// - updated_at 只在内容真正变化时刷新; 纯重复的写入完全不碰文件。

const fs = require('node:fs');
const path = require('node:path');

const SCHEDULE_KIND = 'pinghe-schedule';
const SCHEDULE_VERSION = 1;
const DEFAULT_APP = 'PH Launcher';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MAX_OFFSET_MINUTES = 840; // 现实时区偏移的上限为 ±14:00

function pad2(value) { return String(value).padStart(2, '0'); }

function isSharedDay(value) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= (month === 2 && leap ? 29 : MONTH_DAYS[month - 1]);
}

function isSharedTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

function sharedText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 把同一时刻表示成带指定偏移(分钟)的本地 ISO 8601 文本, 例: 2026-09-10T21:30:00+08:00。
 * 偏移缺省时用系统本地时区; 非法输入一律退回"当前时刻 + 本机偏移", 绝不抛错。
 */
function localIso(date, offsetMinutes) {
  const instant = date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  let offset = Number(offsetMinutes);
  if (!Number.isFinite(offset)) offset = -new Date(instant).getTimezoneOffset();
  offset = Math.min(MAX_OFFSET_MINUTES, Math.max(-MAX_OFFSET_MINUTES, Math.round(offset)));
  const shifted = new Date(instant + offset * 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 从 ISO 8601 文本末尾解析时区偏移(分钟); 没有偏移、Z 或非法格式返回 null。 */
function parseOffset(text) {
  if (typeof text !== 'string') return null;
  const match = /([+-])(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/** 全新空文档; now/app 与读写函数的参数保持一致。 */
function emptySchedule(now = new Date(), app = DEFAULT_APP) {
  return {
    version: SCHEDULE_VERSION,
    kind: SCHEDULE_KIND,
    app: sharedText(app) || DEFAULT_APP,
    updated_at: localIso(now),
    events: [],
  };
}

/** 单条事件的最小合法化: 合法则返回事件对象(保留未知字段), 不合法返回 null。 */
function normalizeSharedEvent(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const id = Number(candidate.id);
  if (!Number.isSafeInteger(id) || !isSharedDay(candidate.day)) return null;
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  if (!title.trim()) return null;
  const time = candidate.time === undefined || candidate.time === null ? '' : candidate.time;
  if (time !== '' && !isSharedTime(time)) return null; // 允许 '' (全天)或合法 HH:MM
  const note = typeof candidate.note === 'string' ? candidate.note : '';
  const event = { ...candidate, id, day: candidate.day, time, title, note };
  if (typeof candidate.created !== 'string' || !candidate.created.trim()) delete event.created;
  return event;
}

/** 容错读取: 永不抛错、永不写盘; 存在但无法按原样使用时 repaired 为 true。 */
function readSchedule(filePath, { now = new Date(), app = DEFAULT_APP } = {}) {
  const unusable = (exists) => ({ doc: emptySchedule(now, app), exists, repaired: true });
  let stat = null;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) return { doc: emptySchedule(now, app), exists: false, repaired: false };
  let raw = null;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return unusable(true); }
  let parsed = null;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); // 容忍 BOM
  } catch { return unusable(true); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unusable(true);

  let repaired = false;
  const doc = { ...parsed }; // 保留全部未知顶层字段(规范 §2.3 的兼容要求)
  if (doc.version !== SCHEDULE_VERSION) { doc.version = SCHEDULE_VERSION; repaired = true; }
  if (doc.kind !== SCHEDULE_KIND) { doc.kind = SCHEDULE_KIND; repaired = true; }
  if (typeof doc.app !== 'string' || !doc.app.trim()) { doc.app = sharedText(app) || DEFAULT_APP; repaired = true; }
  if (typeof doc.updated_at !== 'string' || !doc.updated_at.trim()) { doc.updated_at = localIso(now); repaired = true; }
  if (!Array.isArray(doc.events)) {
    doc.events = [];
    repaired = true;
  } else {
    const cleaned = [];
    const seen = new Set();
    for (const candidate of doc.events) {
      const event = normalizeSharedEvent(candidate);
      if (!event || seen.has(event.id)) { repaired = true; continue; }
      seen.add(event.id);
      cleaned.push(event);
    }
    doc.events = cleaned;
  }
  return { doc, exists: true, repaired };
}

/** 下一个可用 id: 事件内最大 id 与高水位 lastId 取大者再 +1, 保证删除后不复用。 */
function nextEventId(doc) {
  const highestInEvents = doc.events.reduce((max, event) => Math.max(max, event.id), 0);
  const marked = Number(doc.lastId);
  return Math.max(highestInEvents, Number.isFinite(marked) ? marked : 0) + 1;
}

function toEventId(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** upsert 条目的最小合法化: 日期/时间/标题必须能按规范表示, 否则整条跳过。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const day = typeof raw.day === 'string' ? raw.day.trim() : '';
  if (!isSharedDay(day)) return null;
  const time = raw.time === undefined || raw.time === null ? '' : String(raw.time).trim();
  if (time !== '' && !isSharedTime(time)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const note = raw.note === undefined || raw.note === null ? '' : String(raw.note).trim();
  return { matchId: toEventId(raw.matchId), day, time, title, note };
}

/** 比较两条事件是否"内容完全相同"(同日/同时/同标题/同备注, 去首尾空白后)。 */
function sameSharedEvent(a, b) {
  return sharedText(a && a.day) === sharedText(b && b.day)
    && sharedText(a && a.time) === sharedText(b && b.time)
    && sharedText(a && a.title) === sharedText(b && b.title)
    && sharedText(a && a.note) === sharedText(b && b.note);
}

function fileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

function sameFingerprint(before, after) {
  if (before === null || after === null) return before === after;
  return before.mtimeMs === after.mtimeMs && before.size === after.size;
}

let tempSequence = 0;

/** 原子写盘: 同目录临时文件 + renameSync; UTF-8 无 BOM、\n 换行、2 空格缩进。 */
function writeDocAtomic(filePath, doc) {
  const payload = JSON.stringify(doc, null, 2) + '\n';
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${tempSequence += 1}`);
  try {
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* 已改名成功, 临时文件不存在 */ }
  }
}

/**
 * 通用读-改-写: mutate(doc) 返回要写盘的文档, 返回 null 表示无变化(不写盘)。
 * 写入前重读 mtimeMs 与字节数: 变了就重做一次; 再变则照写并标记 contended。
 */
function commitSchedule(filePath, mutate, { now, app }) {
  for (let attempt = 0; ; attempt += 1) {
    const before = fileFingerprint(filePath);
    const { doc } = readSchedule(filePath, { now, app });
    const next = mutate(doc);
    if (!next) return { doc, committed: false, contended: false };
    const contended = !sameFingerprint(before, fileFingerprint(filePath));
    if (!contended || attempt >= 1) {
      writeDocAtomic(filePath, next);
      return { doc: next, committed: true, contended };
    }
    // 对方先写了一步: 按协议重做一次读-改-写, 把对方的改动合并进来。
  }
}

/**
 * 新增/更新条目且绝不隐式删除。entries 为 { matchId?, day, time, title, note } 数组:
 * matchId 命中已有事件则原地更新(保留 id 与 created), 内容与已有事件完全相同记 unchanged,
 * 否则追加新事件(id = 已分配最大 id + 1)。日期/时间/标题无法按规范表示的条目被跳过。
 * updated_at 只在 added/updated 不为 0 时刷新。无法表示的条目不产生任何计数。
 */
function upsertEvents(filePath, entries, { now = new Date(), app = DEFAULT_APP } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const stamp = localIso(now);
  const writer = sharedText(app) || DEFAULT_APP;
  const tally = { added: 0, updated: 0, unchanged: 0 };
  const { doc, contended } = commitSchedule(filePath, (current) => {
    tally.added = 0; tally.updated = 0; tally.unchanged = 0; // 重试时从头再算一遍
    let pendingId = nextEventId(current);
    for (const raw of list) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      const target = entry.matchId === undefined
        ? undefined
        : current.events.find((event) => event.id === entry.matchId);
      if (target) {
        if (sameSharedEvent(target, entry)) { tally.unchanged += 1; continue; }
        target.day = entry.day;
        target.time = entry.time;
        target.title = entry.title;
        target.note = entry.note;
        tally.updated += 1;
        continue;
      }
      if (current.events.some((event) => sameSharedEvent(event, entry))) { tally.unchanged += 1; continue; }
      current.events.push({ id: pendingId, day: entry.day, time: entry.time, title: entry.title, note: entry.note, created: stamp });
      pendingId += 1;
      tally.added += 1;
    }
    if (!tally.added && !tally.updated) return null; // 纯重复或空操作: 不写盘
    current.version = SCHEDULE_VERSION;
    current.kind = SCHEDULE_KIND;
    current.app = writer;
    current.updated_at = stamp;
    const highest = current.events.reduce((max, event) => Math.max(max, event.id), 0);
    if (!(Number(current.lastId) >= highest)) current.lastId = highest;
    return current;
  }, { now, app });
  const result = { doc, added: tally.added, updated: tally.updated, unchanged: tally.unchanged };
  if (contended) result.contended = true;
  return result;
}

/** 按 id 删除事件(未知 id 忽略), 返回实际删除的 id 列表; 删除不影响 id 高水位。 */
function removeEvents(filePath, ids, { now = new Date(), app = DEFAULT_APP } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(toEventId).filter((id) => id !== undefined));
  const taken = [];
  const stamp = localIso(now);
  const writer = sharedText(app) || DEFAULT_APP;
  const { doc, contended } = commitSchedule(filePath, (current) => {
    taken.length = 0;
    const kept = [];
    for (const event of current.events) {
      if (wanted.has(event.id)) taken.push(event.id);
      else kept.push(event);
    }
    if (!taken.length) return null; // 没有命中任何 id: 不写盘
    taken.sort((a, b) => a - b);
    current.events = kept;
    current.version = SCHEDULE_VERSION;
    current.kind = SCHEDULE_KIND;
    current.app = writer;
    current.updated_at = stamp;
    return current;
  }, { now, app });
  const result = { doc, removed: [...taken] };
  if (contended) result.contended = true;
  return result;
}

/** end = start + durationMinutes, 永不超过 23:59; 23:00 后开始的至少保留 15 分钟(当天装得下时)。 */
function sharedEndTime(time, durationMinutes) {
  const [hours, minutes] = time.split(':').map(Number);
  const start = hours * 60 + minutes;
  let end = Math.min(start + durationMinutes, 23 * 60 + 59);
  if (start > 23 * 60) end = Math.min(23 * 60 + 59, Math.max(end, start + 15));
  return `${pad2(Math.floor(end / 60))}:${pad2(end % 60)}`;
}

/**
 * 共用文档 → PHL 日历模型: { sharedId, date, start, end, title, notes }。
 * 全天事项(time 为空)映射为 start/end 均为空串并带 allDay: true; sharedId 是共享文件
 * 里的数字 id 转成的字符串(PHL 日历用字符串 id), 可在回写时当作 matchId 使用。
 * day 无效、标题为空、id 缺失或时间无法表示的条目被跳过; 任何输入都不抛错。
 */
function toLauncherEvents(doc, { durationMinutes = 60 } = {}) {
  const source = doc && typeof doc === 'object' && Array.isArray(doc.events) ? doc.events : [];
  let duration = Math.round(Number(durationMinutes));
  if (!Number.isFinite(duration) || duration < 0) duration = 60;
  const result = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = Number(entry.id);
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!Number.isSafeInteger(id) || !isSharedDay(entry.day) || !title) continue;
    const time = entry.time === undefined || entry.time === null ? '' : entry.time;
    if (time !== '' && !isSharedTime(time)) continue;
    const item = {
      sharedId: String(id),
      date: entry.day,
      start: time,
      end: time === '' ? '' : sharedEndTime(time, duration),
      title,
      notes: typeof entry.note === 'string' ? entry.note : '',
    };
    if (time === '') item.allDay = true;
    result.push(item);
  }
  return result;
}

/**
 * PHL 日历模型 → 共用条目: { launcherId?, day, time, title, note }。
 * 跳过每周重复(repeatWeekdays 非空)、没有有效日期、或 start 无法表示的事件;
 * start 原样映射为 time(空串即全天), notes 映射为 note; 标题去空白并截到 120 字,
 * 备注去空白并截到 400 字。launcherId 保留原值, 回写时由调用方映射为 matchId。
 */
function fromLauncherEvents(events) {
  if (!Array.isArray(events)) return [];
  const result = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    if (Array.isArray(event.repeatWeekdays) && event.repeatWeekdays.length) continue;
    if (!isSharedDay(event.date)) continue;
    const start = event.start === undefined || event.start === null ? '' : event.start;
    if (typeof start !== 'string' || (start !== '' && !isSharedTime(start))) continue;
    const title = typeof event.title === 'string' ? event.title.trim().slice(0, 120) : '';
    if (!title) continue;
    const note = typeof event.notes === 'string' ? event.notes.trim().slice(0, 400) : '';
    const item = { day: event.date, time: start, title, note };
    if (event.id !== undefined && event.id !== null && event.id !== '') item.launcherId = event.id;
    result.push(item);
  }
  return result;
}

module.exports = {
  SCHEDULE_KIND,
  SCHEDULE_VERSION,
  emptySchedule,
  readSchedule,
  upsertEvents,
  removeEvents,
  localIso,
  parseOffset,
  toLauncherEvents,
  fromLauncherEvents,
  sameSharedEvent,
};
