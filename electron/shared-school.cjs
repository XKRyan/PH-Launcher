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

/** 统一时间戳写法：能解析成时间的一律转成本地偏移，解析不了的原样保留。 */
const localStamp = (value) => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? localIso(time) : clean(value, 40);
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

/** 按 id 取并集：已有的条目保留，同 id 用新抓到的覆盖。 */
function mergeRows(existing, incoming, keyOf, limit) {
  const merged = new Map();
  for (const row of Array.isArray(existing) ? existing : []) {
    const key = keyOf(row);
    if (key) merged.set(key, row);
  }
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const key = keyOf(row);
    if (key) merged.set(key, row);
  }
  return [...merged.values()].slice(0, limit);
}

/**
 * 两个程序都会写 managebac 段，直接整段覆盖会互相抹掉对方的条目
 * （一边 20 门课 / 7 份作业，一边 13 门课 / 51 份作业，谁后同步谁的数据就只剩自己那份）。
 * 这里按课程 / 作业自己的 id 取并集：同一个数据文件夹就意味着同一个账号，
 * id 相同即同一条，新抓到的字段更可信。
 */
function mergeManagebac(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming || null;
  if (!incoming || typeof incoming !== 'object') return existing;
  // id 先归一化再比: 老版本写过复合 id(`managebac:<课程>:<作业>`), 新版写裸作业号,
  // 不归一化的话同一条作业会被当成两条留在文件里。
  const keyOf = (row) => sharedTaskId(row?.id || row?.phl_id);
  return {
    fetched_at: clean(incoming.fetched_at, 40) || clean(existing.fetched_at, 40),
    courses: mergeRows(existing.courses, incoming.courses, (row) => clean(row?.id, 32), 60),
    tasks: mergeRows(existing.tasks, incoming.tasks, keyOf, 600),
  };
}

/** 某一天所在那一周的周一；解析不了就原样返回。 */
function weekStartOf(day) {
  const value = clean(day, 20);
  if (!validDate(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

/**
 * edupage 段只保留"当前这一周"：**不在同一周**就整段替换（否则文件会越攒越多、
 * 而且会把上周的课当成这周的）；同一周则按日期 + 时间 + 科目 + 教学组取并集。
 *
 * 同一周按"周一"比较而不是比对字符串：Pinghe Launcher Lite 是按天算课表的
 * （`personal(day)`），它写回来的 `week_start` 可能落在本周内的某一天。
 */
function mergeEdupaged(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming || null;
  if (!incoming || typeof incoming !== 'object') return existing;
  if (weekStartOf(existing.week_start) !== weekStartOf(incoming.week_start)) return incoming;
  const keyOf = (row) => [clean(row?.date, 20), clean(row?.start, 5), clean(row?.subject), clean(row?.group, 80)].join('|');
  return {
    ...incoming,
    week_start: validDate(existing.week_start) ? existing.week_start : incoming.week_start,
    lessons: mergeRows(existing.lessons, incoming.lessons, keyOf, 2000),
    selected_groups: (Array.isArray(incoming.selected_groups) && incoming.selected_groups.length) ? incoming.selected_groups : existing.selected_groups,
  };
}

/** 读改写合并（只替换传入的段，其余原样保留），原子落盘。 */
function updateSchool(filePath, patch, { app = 'PH Launcher', now = () => new Date() } = {}) {
  const current = readSchool(filePath);
  const doc = current.doc && typeof current.doc === 'object' ? current.doc : emptyDoc(now);
  const next = { ...doc, version: 1, kind: KIND, app, updated_at: localIso(now()) };
  for (const section of ['edupage', 'managebac', 'mail']) {
    if (patch && Object.hasOwn(patch, section) && patch[section] !== undefined) next[section] = patch[section];
  }
  if (patch?.managebac !== undefined) next.managebac = mergeManagebac(doc.managebac, patch.managebac);
  if (patch?.edupage !== undefined) next.edupage = mergeEdupaged(doc.edupage, patch.edupage);
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
    fetched_at: localStamp(data.fetchedAt),
    class_name: clean(data.className, 160),
    lessons,
    selected_groups: (Array.isArray(selectedGroups) ? selectedGroups : []).map((item) => clean(item, 160)).filter(Boolean),
  };
}

/**
 * 作业 id 统一成"ManageBac 自己的作业号"。
 *
 * PH Launcher 内部用的是复合 id（`managebac:<课程号>:<作业号>`），Lite 写的是裸作业号。
 * 共用文件两边都写，id 形式不一致的话，同一条作业在"按 id 取并集"时会变成两条
 * （同一条作业在两个程序里各显示一遍）。这里统一写裸作业号，PHL 自己的复合 id
 * 作为额外字段 `phl_id` 保留（Lite 不认识但会原样保留）。
 */
function sharedTaskId(value) {
  const text = clean(value, 120);
  const match = /^managebac:\d+:(\d+)$/.exec(text);
  return match ? match[1] : text;
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
    id: sharedTaskId(task.taskId || task.id),
    phl_id: clean(task.id, 120),
    course_id: clean(task.courseId, 32),
    course: clean(task.course, 200),
    title: clean(task.title, 200),
    due_at: clean(task.dueAt, 40),
    due_text: clean(task.dueText, 160),
    status: clean(task.status, 80),
    score: clean(task.score, 80),
  }));
  return { fetched_at: localStamp(data.fetchedAt), courses, tasks };
}

/** 共享的 managebac 段 → PH Launcher 的快照形状（启动时直接可用）。 */
function managebacToSnapshot(section) {
  if (!section || typeof section !== 'object') return null;
  const courses = (Array.isArray(section.courses) ? section.courses : []).map((course) => ({ id: clean(course.id, 32), name: clean(course.name, 200), grade: clean(course.grade, 80) }));
  const tasks = (Array.isArray(section.tasks) ? section.tasks : []).map((task) => {
    const courseId = clean(task.course_id, 32);
    const taskId = sharedTaskId(task.id || task.phl_id);
    return {
      // PHL 内部沿用复合 id（详情/提交按"课程号 + 作业号"取，界面上取最后一段）；
      // 共享文件里存的是裸作业号，这里拼回来，两边写入时不至于各存一份。
      id: courseId && taskId ? `managebac:${courseId}:${taskId}` : (taskId || clean(task.id, 120)),
      taskId,
      courseId,
      course: clean(task.course, 200),
      title: clean(task.title, 200),
      dueAt: clean(task.due_at, 40),
      dueText: clean(task.due_text, 160),
      status: clean(task.status, 80),
      score: clean(task.score, 80),
      pastDue: Boolean(task.due_at) && Date.parse(task.due_at) < Date.now(),
    };
  });
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
    fetched_at: localStamp(fetchedAt),
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

module.exports = { KIND, edupageSection, edupageToSnapshot, emptyDoc, localIso, localStamp, mailSection, managebacSection, managebacToSnapshot, mergeEdupaged, mergeManagebac, mergeRows, readSchool, sharedTaskId, updateSchool };
