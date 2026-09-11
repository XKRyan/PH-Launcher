'use strict';
// 共用学校数据 `data/School`：两个程序把"抓到的学校信息"都放这一份文件里，
// 谁先同步谁写入，另一个打开直接读，格式完全一致。
//
// 结构（键名用 Lite 风格的 snake_case，两端都不用转换）：
// {
//   version: 1, kind: "pinghe-school", app: "PH Launcher", updated_at: "…+08:00",
//   edupage:   { week_start, fetched_at, class_name, lessons: [{date,start,end,
//                subject,teacher,room,group,cancelled}], options: [...],
//                selected_groups: ["…"] },
//   managebac: { fetched_at, courses: [{id,name,grade}],
//                tasks: [{id,course_id,course,title,due_at,due_text,status,score}] },
//   mail:      { fetched_at, unread, recent: [{uid,from,subject,date,unread}] }
// }
//
// 规则与 Schedule / Timetable / agent 一致：容错读取、原子写入、
// 只更新自己负责的段（别人的段原样保留）、时间戳带本地时区偏移。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const KIND = 'pinghe-school';
const MAX_BYTES = 8 * 1024 * 1024;
const clean = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const localIso = (date) => {
  const moment = date instanceof Date ? date : new Date(date);
  const offset = -moment.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
};

function emptyDoc(now = () => new Date()) {
  return { version: 1, kind: KIND, app: '', updated_at: localIso(now()), edupage: null, managebac: null, mail: null };
}

/** 容错读取：缺失/损坏/超大一律当"还没有共享数据"。 */
function readSchool(filePath) {
  const result = { exists: false, repaired: false, doc: null, mtime: 0 };
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
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || doc.kind !== KIND) { result.repaired = true; return result; }
    result.doc = doc;
  } catch { result.repaired = true; }
  return result;
}

/** 读改写合并（只替换传入的段，其余原样保留），原子落盘。 */
function updateSchool(filePath, patch, { app = 'PH Launcher', now = () => new Date() } = {}) {
  const current = readSchool(filePath);
  const doc = current.doc && typeof current.doc === 'object' ? current.doc : emptyDoc(now);
  const next = { ...doc, version: 1, kind: KIND, app, updated_at: localIso(now()) };
  for (const section of ['edupage', 'managebac', 'mail']) {
    if (patch && Object.hasOwn(patch, section) && patch[section] !== undefined) next[section] = patch[section];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
  return next;
}

// ---------------------------------------------------------------- 归一化
/** PH Launcher 的 edupage 快照 → 共享段（课卡键与 Lite 一致）。 */
function edupageSection(data, { selectedGroups = [] } = {}) {
  if (!data || data.source !== 'edupage') return null;
  const lessons = (Array.isArray(data.lessons) ? data.lessons : [])
    .filter((lesson) => lesson && validDate(lesson.date) && clean(lesson.course))
    .map((lesson) => ({
      date: lesson.date,
      start: clean(lesson.start, 5),
      end: clean(lesson.end, 5),
      subject: clean(lesson.course),
      teacher: clean(lesson.teacher),
      room: clean(lesson.room, 60),
      group: clean(lesson.group || (Array.isArray(lesson.groups) ? lesson.groups.join(' / ') : '')),
      cancelled: lesson.cancelled === true,
    }));
  return {
    week_start: validDate(data.weekStart) ? data.weekStart : '',
    fetched_at: clean(data.fetchedAt, 40),
    class_name: clean(data.className, 160),
    lessons,
    selected_groups: (Array.isArray(selectedGroups) ? selectedGroups : []).map((item) => clean(item, 160)).filter(Boolean),
  };
}

/** PH Launcher 的 managebac 快照 → 共享段。 */
function managebacSection(data) {
  if (!data || data.source !== 'managebac') return null;
  const courses = (Array.isArray(data.courses) ? data.courses : []).slice(0, 60).map((course) => ({
    id: clean(course.id, 32),
    name: clean(course.name, 200),
    grade: clean(course.grade, 80),
  }));
  const tasks = (Array.isArray(data.tasks) ? data.tasks : []).slice(0, 600).map((task) => ({
    id: clean(task.id, 120),
    course_id: clean(task.courseId, 32),
    course: clean(task.course, 200),
    title: clean(task.title, 200),
    due_at: clean(task.dueAt, 40),
    due_text: clean(task.dueText, 160),
    status: clean(task.status, 80),
    score: clean(task.score, 80),
  }));
  return { fetched_at: clean(data.fetchedAt, 40), courses, tasks };
}

/** 共享的 managebac 段 → PH Launcher 的快照形状（启动时直接可用）。 */
function managebacToSnapshot(section) {
  if (!section || typeof section !== 'object') return null;
  const courses = (Array.isArray(section.courses) ? section.courses : []).map((course) => ({ id: clean(course.id, 32), name: clean(course.name, 200), grade: clean(course.grade, 80) }));
  const tasks = (Array.isArray(section.tasks) ? section.tasks : []).map((task) => ({
    id: clean(task.id, 120),
    courseId: clean(task.course_id, 32),
    course: clean(task.course, 200),
    title: clean(task.title, 200),
    dueAt: clean(task.due_at, 40),
    dueText: clean(task.due_text, 160),
    status: clean(task.status, 80),
    score: clean(task.score, 80),
    pastDue: Boolean(task.due_at) && Date.parse(task.due_at) < Date.now(),
  }));
  return {
    source: 'managebac',
    fetchedAt: clean(section.fetched_at, 40),
    courses,
    tasks,
    warnings: ['这份课程与作业来自共享数据文件（两个程序共用）；以学校原网页为准。'],
    sharedFromPeer: true,
  };
}

/** 共享的 edupage 段 → PH Launcher 的快照形状（含教学组选项与选课）。 */
function edupageToSnapshot(section) {
  if (!section || typeof section !== 'object') return null;
  const groupKey = (lesson) => digest(`shared:${clean(lesson.subject)}|${clean(lesson.group)}|${clean(lesson.teacher)}`);
  const lessons = [];
  const options = new Map();
  for (const lesson of Array.isArray(section.lessons) ? section.lessons : []) {
    if (!lesson || !validDate(lesson.date) || !validTime(lesson.start) || !clean(lesson.subject)) continue;
    const key = groupKey(lesson);
    const row = {
      id: `shared:${digest(`${lesson.date}|${lesson.start}|${lesson.subject}|${key}`)}`,
      date: lesson.date,
      start: clean(lesson.start, 5),
      end: clean(lesson.end, 5),
      course: clean(lesson.subject),
      teacher: clean(lesson.teacher),
      room: clean(lesson.room, 60),
      group: clean(lesson.group),
      groupKey: key,
      cancelled: lesson.cancelled === true,
      period: null,
      source: 'shared',
    };
    lessons.push(row);
    if (row.cancelled) continue;
    const option = options.get(key) || { key, course: row.course, teacher: row.teacher, groups: [], rooms: [], times: [], label: '' };
    if (row.group && !option.groups.includes(row.group)) option.groups.push(row.group);
    if (row.room && !option.rooms.includes(row.room)) option.rooms.push(row.room);
    options.set(key, option);
  }
  if (!lessons.length) return null;
  const optionList = [...options.values()].map((option) => ({ ...option, groups: option.groups.sort(), times: option.times.sort(), label: [option.course, option.groups.join(' / '), option.teacher].filter(Boolean).join(' · ') }));
  const dates = [...new Set(lessons.map((lesson) => lesson.date))].sort();
  return {
    source: 'edupage',
    accountKey: 'shared:school',
    className: clean(section.class_name, 160),
    fetchedAt: clean(section.fetched_at, 40),
    weekStart: validDate(section.week_start) ? section.week_start : dates[0] || '',
    lessons,
    options: optionList,
    missingDates: [],
    warnings: ['这份课表来自共享数据文件（两个程序共用）；以学校原网页为准。'],
    sharedFromPeer: true,
    selectedGroups: (Array.isArray(section.selected_groups) ? section.selected_groups : []).map((item) => clean(item, 160)).filter(Boolean),
  };
}

/** 邮件摘要：只放数量与小时头的头部字段（正文不进共享文件）。 */
function mailSection({ unread = 0, recent = [], fetchedAt = '' } = {}) {
  return {
    fetched_at: clean(fetchedAt, 40),
    unread: Number.isFinite(Number(unread)) ? Number(unread) : 0,
    recent: (Array.isArray(recent) ? recent : []).slice(0, 30).map((item) => ({
      uid: clean(item.uid, 20),
      from: clean(item.from, 160),
      subject: clean(item.subject, 200),
      date: clean(item.date, 60),
      unread: item.unread === true,
    })),
  };
}

module.exports = { KIND, edupageSection, edupageToSnapshot, emptyDoc, localIso, mailSection, managebacSection, managebacToSnapshot, readSchool, updateSchool };
