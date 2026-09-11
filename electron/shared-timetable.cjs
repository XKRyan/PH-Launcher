'use strict';
// 共享课表 `data/Timetable`：PH Launcher 与 Pinghe Launcher Lite 共用的周课表。
//
// 文件的键与 Lite `personal()` 课卡完全一致（subject/teacher/room/start/end/
// group/cancelled），按天分组，两个程序都不需要转换字段。读取端把共享的按天
// 课卡还原成 PH Launcher 的 edupage 缓存条目（lessons + options），这样"对方
// 选好的课表"在本程序里直接可见，不需要重新登录同步。
//
// 读取容错：文件缺失/损坏 → 没有课表，绝不抛错；写入原子替换。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const KIND = 'pinghe-timetable';
const MAX_BYTES = 4 * 1024 * 1024;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const clean = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');

/** 读取共享课表；缺失/损坏一律按"没有课表"处理。 */
function readTimetable(filePath) {
  const result = { exists: false, repaired: false, weekStart: '', days: {}, mtime: 0 };
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return result;
    raw = fs.readFileSync(filePath, 'utf8');
    result.exists = true;
    result.mtime = stat.mtimeMs;
  } catch {
    return result;
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { result.repaired = true; return result; }
  if (!doc || typeof doc !== 'object' || doc.kind !== KIND || typeof doc.days !== 'object' || !doc.days) {
    result.repaired = true;
    return result;
  }
  for (const [day, lessons] of Object.entries(doc.days)) {
    if (!validDate(day) || !Array.isArray(lessons)) continue;
    const usable = lessons.filter((lesson) => lesson && typeof lesson === 'object'
      && clean(lesson.subject) && validTime(lesson.start) && (!lesson.end || validTime(lesson.end)));
    if (usable.length) result.days[day] = usable;
  }
  const dates = Object.keys(result.days).sort();
  result.weekStart = dates[0] || '';
  return result;
}

function groupKeyOf(lesson) {
  // 共享课表的组标识只依赖共享文件自己的字段，两边计算结果一致。
  return digest(`shared:${clean(lesson.subject)}|${clean(lesson.group)}|${clean(lesson.teacher)}`);
}

/** 共享文档 → edupage 缓存条目（可直接交给 schoolState.hydrate）。 */
function toCacheEntry(doc, { at = Date.now() } = {}) {
  const days = doc && typeof doc === 'object' && doc.days && typeof doc.days === 'object' ? doc.days : {};
  const lessons = [];
  const options = new Map();
  const groupKeys = new Set();
  for (const date of Object.keys(days).sort()) {
    for (const lesson of days[date]) {
      const key = groupKeyOf(lesson);
      groupKeys.add(key);
      const row = {
        id: `lite:${digest(`${date}|${lesson.start}|${lesson.end}|${clean(lesson.subject)}|${key}`)}`,
        date,
        start: clean(lesson.start, 5),
        end: clean(lesson.end, 5),
        course: clean(lesson.subject),
        teacher: clean(lesson.teacher),
        room: clean(lesson.room, 60),
        group: clean(lesson.group),
        groupKey: key,
        cancelled: lesson.cancelled === true,
        period: null,
        source: 'lite',
      };
      lessons.push(row);
      if (row.cancelled) continue;
      const option = options.get(key) || { key, course: row.course, teacher: row.teacher, groups: [], rooms: [], times: [], label: '' };
      if (row.group && !option.groups.includes(row.group)) option.groups.push(row.group);
      if (row.room && !option.rooms.includes(row.room)) option.rooms.push(row.room);
      const timeLabel = `${date.slice(5)} ${row.start}–${row.end}`;
      if (!option.times.includes(timeLabel)) option.times.push(timeLabel);
      options.set(key, option);
    }
  }
  const weekStart = Object.keys(days).sort()[0] || '';
  const optionList = [...options.values()].map((option) => ({
    ...option,
    groups: option.groups.sort(),
    times: option.times.sort(),
    label: [option.course, option.groups.join(' / '), option.teacher].filter(Boolean).join(' · '),
  }));
  return {
    key: `edupage:${weekStart}`,
    at,
    groupKeys: [...groupKeys],
    data: {
      source: 'edupage',
      accountKey: 'shared:timetable',
      className: '',
      fetchedAt: typeof doc?.updated_at === 'string' ? doc.updated_at : new Date(at).toISOString(),
      weekStart,
      lessons,
      options: optionList,
      missingDates: [],
      warnings: ['这份课表来自共享数据文件（Pinghe Launcher Lite 同步）；以学校原网页为准。'],
      sharedFromLite: true,
    },
  };
}

/** PH Launcher 的 edupage 数据 → 共享文档（键与 Lite 课卡一致）。 */
function buildDocFromEdupage(data, { app = 'PH Launcher', now = () => new Date() } = {}) {
  const days = {};
  const lessons = Array.isArray(data?.lessons) ? data.lessons : [];
  for (const lesson of lessons) {
    if (!lesson || !validDate(lesson.date) || !clean(lesson.course)) continue;
    (days[lesson.date] ||= []).push({
      subject: clean(lesson.course),
      teacher: clean(lesson.teacher),
      room: clean(lesson.room, 60),
      start: clean(lesson.start, 5),
      end: clean(lesson.end, 5),
      group: clean(lesson.group),
      cancelled: lesson.cancelled === true,
    });
  }
  return {
    version: 1,
    kind: KIND,
    app,
    updated_at: now().toISOString(),
    days,
  };
}

/** 原子写入共享课表（UTF-8 无 BOM, \n, 同目录临时文件 + rename）。 */
function writeDoc(filePath, doc, { now = () => new Date() } = {}) {
  const payload = { ...doc, updated_at: now().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
  return payload;
}

module.exports = { KIND, buildDocFromEdupage, readTimetable, toCacheEntry, writeDoc };
