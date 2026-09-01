const { sanitizeLessons } = require('./ai-tools.cjs');

const EXTRACTOR_VERSION = 1;

function extractEduPageTimetableInPage() {
  const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const dayMap = new Map([
    ['sun', 0], ['sunday', 0], ['星期日', 0], ['星期天', 0], ['周日', 0], ['周天', 0],
    ['mon', 1], ['monday', 1], ['星期一', 1], ['周一', 1],
    ['tue', 2], ['tues', 2], ['tuesday', 2], ['星期二', 2], ['周二', 2],
    ['wed', 3], ['wednesday', 3], ['星期三', 3], ['周三', 3],
    ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4], ['星期四', 4], ['周四', 4],
    ['fri', 5], ['friday', 5], ['星期五', 5], ['周五', 5],
    ['sat', 6], ['saturday', 6], ['星期六', 6], ['周六', 6],
  ]);
  const parseDay = (value) => {
    const text = clean(value, 80).toLocaleLowerCase('en-US');
    if (!text) return null;
    for (const [label, day] of dayMap) {
      if (new RegExp(`(^|[^a-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text) || text.includes(label)) return day;
    }
    const numeric = text.match(/(?:day|weekday|dow)[^0-9]*([0-7])/i)?.[1];
    if (numeric !== undefined) {
      const day = Number(numeric);
      return day === 7 ? 0 : day;
    }
    if (/^[1-7]$/.test(text)) return Number(text) === 7 ? 0 : Number(text);
    if (text === '0') return 0;
    return null;
  };
  const parseTimes = (value) => {
    const text = clean(value, 400).replace(/[.]/g, ':');
    const matches = [...text.matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)]
      .map((match) => `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`);
    return [...new Set(matches)].slice(0, 2);
  };
  const attrText = (node, names) => names.map((name) => node?.getAttribute?.(name) || node?.dataset?.[name] || '').filter(Boolean).join(' ');
  const ownLabel = (node) => clean([
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('title'),
    node?.getAttribute?.('data-tooltip'),
    node?.textContent,
  ].filter(Boolean).join(' '), 500);
  const findContext = (node, parser) => {
    let current = node;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const attributes = attrText(current, ['day', 'dayIndex', 'dayindex', 'weekday', 'dow', 'date', 'start', 'startTime', 'starttime', 'end', 'endTime', 'endtime']);
      const parsed = parser(`${attributes} ${current.getAttribute?.('aria-label') || ''} ${current.getAttribute?.('title') || ''}`);
      if (parsed !== null && (!Array.isArray(parsed) || parsed.length)) return parsed;
    }
    return parser(ownLabel(node));
  };
  const fieldText = (node, selectors, attributes = []) => {
    for (const selector of selectors) {
      const found = node.querySelector?.(selector);
      const value = clean(found?.textContent || found?.getAttribute?.('aria-label'), 120);
      if (value) return value;
    }
    for (const attribute of attributes) {
      const value = clean(node.getAttribute?.(attribute) || node.dataset?.[attribute], 120);
      if (value) return value;
    }
    return '';
  };
  const courseFromText = (text) => {
    const lines = String(text || '').split(/\n|\r|\s{2,}/).map((line) => clean(line, 80)).filter(Boolean);
    return lines.find((line) =>
      line.length <= 60 &&
      parseDay(line) === null &&
      parseTimes(line).length === 0 &&
      !/^(room|classroom|teacher|period|lesson|教室|教师|老师|第\s*\d+\s*节)/i.test(line),
    ) || '';
  };
  const lessonFromNode = (node, forcedDay = null, forcedTimes = []) => {
    const label = ownLabel(node);
    const day = forcedDay ?? findContext(node, parseDay);
    const explicitTimes = parseTimes(attrText(node, ['start', 'startTime', 'starttime', 'end', 'endTime', 'endtime', 'time']));
    const times = explicitTimes.length >= 2 ? explicitTimes : forcedTimes.length >= 2 ? forcedTimes : findContext(node, parseTimes);
    let course = fieldText(
      node,
      ['[data-subject]', '[class*="subject"]', '[class*="Subject"]', '[class*="lessonTitle"]', '[class*="LessonTitle"]', '[class*="cardTitle"]', '[class*="CardTitle"]', '.skgdCardTitle', 'strong', 'b'],
      ['data-subject', 'data-course', 'data-lesson'],
    );
    if (course && /\d{1,2}[:.]\d{2}/.test(course)) course = '';
    if (!course) course = courseFromText(node.innerText || label);
    const room = fieldText(
      node,
      ['[data-room]', '[class*="room"]', '[class*="Room"]', '[class*="classroom"]', '[class*="Classroom"]'],
      ['data-room', 'data-classroom'],
    ).replace(/^(room|classroom|教室)\s*[:：-]?\s*/i, '');
    if (day === null || times.length < 2 || !course) return null;
    return { course, dayOfWeek: day, start: times[0], end: times[1], room, evidence: clean(label, 180) };
  };

  const result = {
    version: 1,
    url: location.href,
    title: clean(document.title, 160),
    mode: 'unknown',
    lessons: [],
    warnings: [],
    diagnostics: { cardCandidates: 0, tableCandidates: 0 },
  };
  if (!/(^|\.)edupage\.org$/i.test(location.hostname)) {
    result.warnings.push('当前页面不是 EduPage');
    return result;
  }
  if (document.querySelector('input[type="password"]')) {
    result.warnings.push('请先登录 EduPage，再打开“常规课表”页面');
    return result;
  }

  const headingText = clean([
    document.title,
    location.pathname,
    ...[...document.querySelectorAll('h1,h2,h3,[role="heading"],nav,[class*="title"],[class*="Title"]')]
      .slice(0, 80)
      .map((node) => node.textContent),
  ].join(' '), 5000).toLocaleLowerCase('en-US');
  if (/(regular timetable|regular schedule|常规课表|固定课表|标准课表)/i.test(headingText)) result.mode = 'regular';
  else if (/(current week|this week|today|substitution|本周|今日|今天|调课|代课|停课)/i.test(headingText)) result.mode = 'dynamic';

  const nodes = [...document.querySelectorAll([
    '[data-subject]',
    '[data-course]',
    '[data-lesson]',
    '[data-testid*="lesson" i]',
    '[class*="lesson"][class*="card" i]',
    '[class*="timetable"] [class*="card" i]',
    '.skgdCard',
    '.skgdLesson',
    '.ascTimetableCard',
  ].join(','))].slice(0, 400);
  result.diagnostics.cardCandidates = nodes.length;
  for (const node of nodes) {
    const lesson = lessonFromNode(node);
    if (lesson) result.lessons.push(lesson);
  }

  const tables = [...document.querySelectorAll('table')].filter((table) => table.rows?.length >= 2).slice(0, 20);
  for (const table of tables) {
    const rows = [...table.rows].slice(0, 40).map((row) => [...row.cells].slice(0, 20));
    if (!rows.length) continue;
    const headerDays = rows[0].map((cell) => parseDay(cell.innerText));
    if (headerDays.some((day) => day !== null)) {
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const rowTimes = rows[rowIndex].flatMap((cell) => parseTimes(cell.innerText)).slice(0, 2);
        for (let column = 0; column < rows[rowIndex].length; column += 1) {
          const day = headerDays[column];
          if (day === null || day === undefined) continue;
          const lesson = lessonFromNode(rows[rowIndex][column], day, rowTimes);
          if (lesson) result.lessons.push(lesson);
        }
      }
    } else {
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const day = parseDay(rows[rowIndex][0]?.innerText);
        if (day === null) continue;
        for (let column = 1; column < rows[rowIndex].length; column += 1) {
          const headerTimes = parseTimes(rows[0][column]?.innerText);
          const lesson = lessonFromNode(rows[rowIndex][column], day, headerTimes);
          if (lesson) result.lessons.push(lesson);
        }
      }
    }
  }
  result.diagnostics.tableCandidates = tables.length;

  const seen = new Set();
  result.lessons = result.lessons.filter((lesson) => {
    const key = `${lesson.course.toLocaleLowerCase('zh-CN')}|${lesson.dayOfWeek}|${lesson.start}|${lesson.end}|${lesson.room.toLocaleLowerCase('zh-CN')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
  if (result.mode === 'dynamic') result.warnings.push('当前看起来是“今日／本周动态课表”；请切换到“常规课表”，避免把临时调课保存为每周课程');
  if (result.mode === 'unknown') result.warnings.push('无法确认当前是否为常规课表，请在导入前核对页面与每节课程');
  if (!result.lessons.length) result.warnings.push('没有识别到完整课程；请打开 EduPage 的常规课表，并让课程名和时间显示在页面上');
  return result;
}

const EDUPAGE_TIMETABLE_SCRIPT = `(${extractEduPageTimetableInPage.toString()})()`;

function normalizeExtractorResult(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let parsedUrl;
  try {
    parsedUrl = new URL(source.url);
  } catch {
    throw new Error('EduPage 页面地址无效');
  }
  if (parsedUrl.protocol !== 'https:' || !(parsedUrl.hostname === 'edupage.org' || parsedUrl.hostname.endsWith('.edupage.org'))) {
    throw new Error('只允许从 EduPage 页面读取课表');
  }
  parsedUrl.search = '';
  parsedUrl.hash = '';
  const lessons = [];
  const rejected = [];
  for (const candidate of Array.isArray(source.lessons) ? source.lessons.slice(0, 120) : []) {
    try {
      lessons.push(...sanitizeLessons([candidate], 'edupage'));
    } catch (error) {
      rejected.push(String(error.message || '字段无效').slice(0, 100));
    }
  }
  const warnings = (Array.isArray(source.warnings) ? source.warnings : [])
    .map((warning) => String(warning || '').replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 8);
  if (rejected.length) warnings.push(`有 ${rejected.length} 个不完整或无效的课程卡片未纳入预览`);
  const mode = ['regular', 'dynamic', 'unknown'].includes(source.mode) ? source.mode : 'unknown';
  return {
    version: EXTRACTOR_VERSION,
    url: parsedUrl.toString(),
    title: String(source.title || 'EduPage').replace(/\s+/g, ' ').trim().slice(0, 160),
    mode,
    importAllowed: mode !== 'dynamic' && lessons.length > 0,
    lessons,
    warnings,
    diagnostics: {
      recognized: lessons.length,
      rejected: rejected.length,
      cardCandidates: Math.max(0, Math.min(1000, Number(source.diagnostics?.cardCandidates) || 0)),
      tableCandidates: Math.max(0, Math.min(100, Number(source.diagnostics?.tableCandidates) || 0)),
    },
  };
}

module.exports = {
  EDUPAGE_TIMETABLE_SCRIPT,
  EXTRACTOR_VERSION,
  normalizeExtractorResult,
};
