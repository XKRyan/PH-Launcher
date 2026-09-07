// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 PH Launcher contributors.
// EduPage week-window flow adapted from Hello Pinghe! Launcher, huaziqian40-bot
// and contributors, hellopinghe/app/services.py @ 19683149ad5572464d332fbe121c78a2ee5ba359.
// Original PH parsing work retains its MIT notice in LICENSE-MIT-PH-Launcher.txt.
// See docs/school-integration.md for sources and integration changes.
const { parseHTML } = require('linkedom');
const { createHash } = require('node:crypto');

const ORIGINS = Object.freeze({
  managebac: 'https://shph.managebac.cn',
  edupage: 'https://pingheschool.edupage.org',
});
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const clean = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const validDate = (value) => { const time = Date.parse(`${value}T12:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; };
const addDays = (value, days) => new Date(new Date(`${value}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const text = (node, selector, max = 200) => clean((selector ? node.querySelector(selector) : node)?.textContent, max);

class SchoolDataError extends Error {
  constructor(code, message) { super(message); this.name = 'SchoolDataError'; this.code = code; }
}
function fail(code, message) { throw new SchoolDataError(code, message); }
function readUrl(site, raw, method = 'GET') {
  let url;
  try { url = new URL(raw, ORIGINS[site]); } catch { fail('URL_NOT_ALLOWED', '学校数据地址无效'); }
  if (!ORIGINS[site] || url.origin !== ORIGINS[site] || url.username || url.password || url.hash) fail('URL_NOT_ALLOWED', '只允许读取学校官方网站');
  const path = url.pathname;
  const params = url.searchParams;
  if (site === 'managebac' && method === 'GET') {
    if (path === '/student/classes/my' && [...params.keys()].every((key) => key === 'page') && (!params.has('page') || /^[1-9]\d?$/.test(params.get('page')))) return url.href;
    if (/^\/student\/classes\/\d+\/(units|files|events\.json|core_tasks(?:\/\d+)?)$/.test(path) && !url.search) return url.href;
    if (/^\/student\/classes\/\d+\/discussions(?:\/\d+)?$/.test(path) && !url.search) return url.href;
    if ((/^\/student\/classes\/\d+\/discussions\/\d+\/attachments\/\d+(?:\/[A-Za-z0-9._~-]+)?\/?$/.test(path) || /^\/attachments\/\d+(?:\/(?:download|[A-Za-z0-9._~-]+))?\/?$/.test(path)) && !url.search) return url.href;
    if (['/student/ib/activity/cas', '/student/ib/pbl/778'].includes(path) && !url.search) return url.href;
  }
  if (site === 'edupage') {
    if (method === 'GET' && /^\/user\/?$/.test(path) && !url.search) return url.href;
    if (method === 'GET' && path === '/dashboard/eb.php' && url.search === '?mode=ttday') return url.href;
    if (method === 'POST' && path === '/gcall' && !url.search) return url.href;
  }
  fail('URL_NOT_ALLOWED', '这个地址不属于已允许的只读数据页面');
}
function safeSourceUrl(site, raw) {
  try {
    const url = new URL(raw, ORIGINS[site]);
    if (url.origin !== ORIGINS[site] || url.username || url.password) return '';
    if (site === 'managebac' && !/^\/student\/classes\/\d+(?:\/(?:units|files|core_tasks)(?:\/\d+)?|discussions(?:\/\d+)?)?\/?$/.test(url.pathname)) return '';
    url.search = ''; url.hash = ''; return url.href;
  } catch { return ''; }
}
function safeDiscussionAttachmentUrl(raw, courseId, discussionId) {
  try {
    const url = new URL(raw, ORIGINS.managebac);
    if (url.origin !== ORIGINS.managebac || url.username || url.password) return '';
    const scoped = new RegExp(`^/student/classes/${courseId}/discussions/${discussionId}/attachments/\\d+(?:/[A-Za-z0-9._~-]+)?/?$`);
    if (!scoped.test(url.pathname) && !/^\/attachments\/\d+(?:\/(?:download|[A-Za-z0-9._~-]+))?\/?$/.test(url.pathname)) return '';
    url.search = ''; url.hash = ''; return url.href;
  } catch { return ''; }
}
function htmlDocument(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML_BYTES) fail('PAGE_TOO_LARGE', '学校页面过大，请在原网页查看');
  const { document } = parseHTML(html);
  if (document.querySelector('#session_password, #session_form, input[type="password"]')) fail('LOGIN_REQUIRED', '请先在内置网页登录学校账号，再刷新');
  // The parser is inert: no network, scripts, styles or event handlers execute.
  for (const node of document.querySelectorAll('script,style,noscript,template')) node.remove();
  return document;
}

function parseManageBacCourses(html) {
  const doc = htmlDocument(html);
  const courses = new Map();
  const ignore = /^(?:leave|units|tasks|updates|grades|class|classes|course|view|join)$/i;
  const links = doc.querySelectorAll('#classes a[href], .f-menu-submenu-item a[href], [data-class-id] a[href]');
  for (const node of links) {
    const url = safeSourceUrl('managebac', node.getAttribute('href'));
    const id = url.match(/\/classes\/(\d+)/)?.[1];
    const title = node.querySelector('.f-menu-submenu-link-title, .title, h2, h3');
    const name = text(title || node, null, 160);
    if (!id || !name || ignore.test(name)) continue;
    const priority = title || /^\/student\/classes\/\d+\/?$/.test(new URL(url).pathname) ? 2 : 1;
    const card = node.closest('[data-class-id], .fusion-card-item');
    const cardIds = card ? [...card.querySelectorAll('a[href]')].map(link => safeSourceUrl('managebac', link.getAttribute('href')).match(/\/classes\/(\d+)/)?.[1]).filter(Boolean) : [];
    const teacherNames = card && (!card.getAttribute('data-class-id') || card.getAttribute('data-class-id') === id) && cardIds.length && cardIds.every(value => value === id)
      ? [...new Set([...card.querySelectorAll('[data-teacher-name], .teacher-name')].map(item => clean(item.getAttribute('data-teacher-name') || item.textContent, 100)).filter(Boolean))].slice(0, 8) : [];
    if (!courses.has(id) || priority > courses.get(id).priority) courses.set(id, { id, name, url: `${ORIGINS.managebac}/student/classes/${id}/units`, priority, ...(teacherNames.length ? { teachers: teacherNames } : {}) });
  }
  const empty = /No classes found/i.test(doc.documentElement?.textContent || '');
  return { courses: [...courses.values()].map(({ priority, ...course }) => course), recognized: links.length > 0 || empty, empty };
}

function parseManageBacGrade(html) {
  const doc = htmlDocument(html);
  // Locate a labelled grade, never assume the fourth sidebar cell is a grade.
  const labelPattern = /(?:overall\s*(?:grade|assessment|score)|final\s*grade|总评|综合成绩)/i;
  for (const node of doc.querySelectorAll('[data-overall-grade], .sidebar-items-list .cell, [class*="overall-grade"], [class*="overall_grade"]')) {
    const attribute = clean(node.getAttribute('data-overall-grade'), 80);
    if (attribute) return { grade: attribute, recognized: true };
    const value = text(node, null, 240);
    if (!labelPattern.test(value)) continue;
    const grade = clean(value.replace(labelPattern, '').replace(/^\s*[:：-]\s*/, ''), 80);
    return { grade: grade || null, recognized: true };
  }
  return { grade: null, recognized: Boolean(doc.querySelector('.sidebar-items-list')) };
}

function exactDueDate(node) {
  const source = node.querySelector('time[datetime], [data-due-at], [data-due-date]');
  const value = source?.getAttribute('datetime') || source?.getAttribute('data-due-at') || source?.getAttribute('data-due-date') || '';
  // Do not invent the year/time zone for month/day labels. Keep them as dueText.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return '';
}
function parseManageBacTasks(html, course = {}) {
  const doc = htmlDocument(html);
  const tasks = new Map();
  const cards = doc.querySelectorAll('.fusion-card-item.short-assignment, [data-task-id]');
  for (const card of cards) {
    const link = card.querySelector('.title a[href], h3 a[href], h4 a[href], a[href*="/core_tasks/"]');
    const url = safeSourceUrl('managebac', link?.getAttribute('href'));
    const ids = url.match(/\/classes\/(\d+)\/core_tasks\/(\d+)$/);
    if (!ids || (course.id && ids[1] !== String(course.id))) continue;
    const title = text(link, null, 200);
    if (!title) continue;
    const id = `managebac:${ids[1]}:${ids[2]}`;
    tasks.set(id, {
      id, title, courseId: ids[1], course: clean(course.name, 160), url,
      dueText: text(card, '.due-date', 160) || text(card, '.date-badge', 160),
      dueAt: exactDueDate(card), status: text(card, '.badge-label', 80),
      score: text(card, '.assessment.task-score', 80),
      pastDue: Boolean(card.querySelector('.past-due')),
    });
  }
  return { tasks: [...tasks.values()].slice(0, 500), recognized: cards.length > 0 || /No (?:tasks|assignments|records)|暂无作业/i.test(doc.documentElement?.textContent || '') };
}

function parseCourseFiles(html, courseId) {
  const doc = htmlDocument(html);
  return [...doc.querySelectorAll('.row.file, [data-ec3-info]')].slice(0, 100).map((row) => {
    let metadata = {};
    try { metadata = JSON.parse(row.getAttribute('data-ec3-info') || '{}'); } catch { /* Display visible filename only. */ }
    return { name: clean(metadata.name, 180) || text(row, null, 180), url: `${ORIGINS.managebac}/student/classes/${courseId}/files` };
  }).filter((item) => item.name);
}
function parseTaskDetail(html) {
  const doc = htmlDocument(html);
  const root = doc.querySelector('.core-task-show');
  if (!root) fail('PAGE_CHANGED', '没有识别到作业详情，请在原网页查看');
  const head = root.querySelector('.fusion-card-item') || root;
  const title = text(head, '.title', 200);
  const status = text(head, '.badge-label', 100);
  const dueText = text(head, '.due-date', 200);
  const dueAt = exactDueDate(head);
  const score = text(head, '.assessment', 120);
  const copy = root.cloneNode(true);
  for (const node of copy.querySelectorAll('form,input,textarea,button,.recent-discussions,.fusion-card-item')) node.remove();
  return { title, status, dueText, dueAt, score, description: text(copy, null, 8000) };
}
function discussionAuthor(node) {
  if (!node) return { author: '', category: '' };
  const links = [...node.querySelectorAll('a')].map((link) => text(link, null, 100)).filter(Boolean);
  if (links.length >= 2) return { author: links[0], category: links.at(-1) };
  const value = text(node, null, 240);
  if (links.length === 1) return { author: links[0], category: clean(value.match(/\bin\s+(.+)$/i)?.[1], 100) };
  const match = value.match(/^(.+?)\s+in\s+(.+)$/i);
  return match ? { author: clean(match[1], 100), category: clean(match[2], 100) } : { author: clean(value, 100), category: '' };
}
function discussionAttachments(node, courseId, discussionId, limit = 8) {
  if (!node) return [];
  const items = new Map();
  for (const link of node.querySelectorAll("a[href*='/attachments/'], .attachment a[href], .files a[href]")) {
    const url = safeDiscussionAttachmentUrl(link.getAttribute('href'), courseId, discussionId);
    const name = text(link, null, 180);
    if (url && name && !items.has(url)) items.set(url, { name, url });
  }
  return [...items.values()].slice(0, limit);
}
function parseManageBacDiscussions(html, courseId) {
  const cid = validatedId(courseId);
  const doc = htmlDocument(html); const discussions = [];
  const blocks = doc.querySelectorAll("div.discussion[id^='discussion_']");
  for (const block of [...blocks].slice(0, 200)) {
    const id = clean(block.id, 40).match(/^discussion_(\d{1,16})$/)?.[1];
    if (!id) continue;
    const titleNode = block.querySelector('.h4.title a, .h4.title, h3.title a, h3.title');
    const byline = discussionAuthor(block.querySelector('.author'));
    discussions.push({
      id, title: text(titleNode, null, 240) || '无标题讨论', ...byline,
      preview: text(block, '.fr-view, .discussion-body', 500),
      attachments: discussionAttachments(block, cid, id, 5),
      url: `${ORIGINS.managebac}/student/classes/${cid}/discussions/${id}`,
    });
  }
  const empty = /No (?:discussions|records)|暂无讨论/i.test(doc.documentElement?.textContent || '');
  return { discussions, recognized: blocks.length > 0 || empty, empty };
}
function discussionPost(node, courseId, discussionId) {
  if (!node) return null;
  const byline = discussionAuthor(node.querySelector('.author'));
  const whole = text(node, null, 1000);
  const date = clean(whole.match(/Posted on\s+(.+? (?:AM|PM))/i)?.[1], 100);
  return { ...byline, date, body: text(node, '.fr-view, .discussion-body', 12000), attachments: discussionAttachments(node, courseId, discussionId) };
}
function parseDiscussionDetail(html, courseId, discussionId) {
  const cid = validatedId(courseId); const did = validatedId(discussionId);
  const doc = htmlDocument(html);
  const mainNode = doc.querySelector("div.discussion[id^='discussion_']");
  if (!mainNode || mainNode.id !== `discussion_${did}`) fail('PAGE_CHANGED', '没有识别到讨论详情，请在原网页查看');
  const title = text(mainNode, '.h4.title, h3.title, .h4', 240) || '无标题讨论';
  const comments = [];
  for (const reply of [...doc.querySelectorAll("div.reply[id^='reply_']")].slice(0, 500)) {
    const id = clean(reply.id, 40).match(/^reply_(\d{1,16})$/)?.[1];
    if (!id) continue;
    const header = text(reply, '.header', 500);
    const [authorPart, posted = ''] = header.split(/\s*Posted on\s*/i);
    comments.push({
      id, author: clean(authorPart.split('|')[0], 100),
      date: clean(posted.replace(/\s+(?:Reply|Edit|Delete)\b.*$/i, ''), 100),
      body: text(reply, '.fr-view, .body', 12000),
      attachments: discussionAttachments(reply, cid, did),
      private: /(?:^|\s)private(?:\s|$)/i.test(reply.className || ''),
    });
  }
  return { title, main: discussionPost(mainNode, cid, did), comments };
}
function parseCoreOverview(html, kind) {
  const doc = htmlDocument(html);
  const selectors = kind === 'cas' ? ['.aims-and-goals', '.statuses-legend', '.card-body'] : ['.pbl-worksheet', '.js-core-project-documents'];
  const sections = selectors.flatMap((selector) => [...doc.querySelectorAll(selector)].slice(0, 5)).map((node) => {
    const copy = node.cloneNode(true);
    for (const field of copy.querySelectorAll('input,textarea,form,button,nav')) field.remove();
    return text(copy, null, 3000);
  }).filter(Boolean);
  if (!sections.length) fail('PAGE_CHANGED', '未识别到此项目的概览，请在原网页查看');
  return { title: text(doc, 'h1', 160) || (kind === 'cas' ? 'CAS' : 'Extended Essay'), sections };
}

function validatedId(value) {
  if (!/^\d{1,16}$/.test(String(value || ''))) fail('INVALID_ID', '课程或作业编号无效');
  return String(value);
}

// Read exactly one JSON value inside a script or RPC envelope, without eval.
function jsonObjectAt(source, start) {
  if (source[start] !== '{') return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
function parseEduPageIdentity(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML_BYTES) fail('PAGE_TOO_LARGE', '学校页面过大');
  const marker = /\buserhome\s*\(\s*\{/g;
  let match;
  while ((match = marker.exec(html))) {
    const data = jsonObjectAt(html, marker.lastIndex - 1);
    const id = clean(data?.userid, 100);
    if (!data || !/^[\w@.:-]{1,100}$/.test(id) || !data.dbi || typeof data.dbi !== 'object') continue;
    let classId = clean(data.userrow?.TriedaID, 30);
    if (!/^-?\d+$/.test(classId)) {
      const groups = data.userGroups;
      const keys = Array.isArray(groups) ? groups : groups && typeof groups === 'object' ? Object.keys(groups) : [];
      const value = keys.map((item) => String(item).match(/^Trieda-(\d+)$/)?.[1]).find(Boolean);
      classId = value ? `-${value}` : '';
    }
    return { id, accountKey: digest(`edupage:${id}`), classId, dbi: data.dbi };
  }
  fail('LOGIN_REQUIRED', '请先在内置 EduPage 登录，再刷新课表');
}
function parseEduPageNonce(html) {
  const normalized = String(html).replace(/&amp;/g, '&');
  const match = normalized.match(/gpid=(\d+)&gsh=([^\s"'<>;&]+)/);
  if (!match || match[1].length > 12 || match[2].length > 300) fail('PAGE_CHANGED', 'EduPage 课表页面已变化，请在原网页查看');
  return { gpid: String(Number(match[1]) + 1), gsh: match[2] };
}
function parseEduPageEnvelope(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_HTML_BYTES) fail('PAGE_TOO_LARGE', 'EduPage 返回的数据过大');
  try {
    const json = JSON.parse(body);
    if (json?.dates && typeof json.dates === 'object') return json;
  } catch { /* RPC envelopes are not themselves JSON. */ }
  for (const match of body.matchAll(/\{\s*"dates"\s*:/g)) {
    const result = jsonObjectAt(body, match.index);
    if (result?.dates && typeof result.dates === 'object') return result;
  }
  // The dates property need not be first; only inspect a bounded number of JSON starts.
  let count = 0;
  for (const match of body.matchAll(/\{/g)) {
    if (++count > 100) break;
    const result = jsonObjectAt(body, match.index);
    if (result?.dates && typeof result.dates === 'object') return result;
  }
  fail('PAGE_CHANGED', '未能识别 EduPage 课表数据，请在原网页查看');
}
function lookup(dbi, table, id) {
  const record = dbi?.[table]?.[String(id)];
  return record && typeof record === 'object' ? record : {};
}
function eduRows(dates, identity, requestedDates) {
  const lessons = []; const options = new Map(); let skipped = 0;
  if (!identity.classId) fail('CLASS_UNKNOWN', '无法确认当前账号所属班级；请在 EduPage 核对班级后再同步');
  for (const date of requestedDates) {
    const plan = dates[date]?.plan;
    if (!Array.isArray(plan)) continue;
    for (const item of plan.slice(0, 1000)) {
      if (!item || typeof item !== 'object') continue;
      const classes = Array.isArray(item.classids) ? item.classids.map(String) : [];
      if (!classes.includes(identity.classId)) continue;
      const start = clean(item.starttime, 5); const end = clean(item.endtime, 5);
      const subject = lookup(identity.dbi, 'subjects', item.subjectid);
      const course = clean(subject.name || subject.short, 160);
      if (!course || !validTime(start) || !validTime(end) || end <= start) { skipped += 1; continue; }
      const teacherIds = Array.isArray(item.teacherids) ? item.teacherids.slice(0, 6).map(String) : [];
      const teacher = teacherIds.map((id) => { const row = lookup(identity.dbi, 'teachers', id); return clean(row.name || `${row.firstname || ''} ${row.lastname || ''}`, 100); }).filter(Boolean).join('、');
      const room = (Array.isArray(item.classroomids) ? item.classroomids.slice(0, 6) : []).map((id) => { const row = lookup(identity.dbi, 'classrooms', id); return clean(row.name || row.short, 60); }).filter(Boolean).join(' / ');
      const groups = (Array.isArray(item.groupnames) ? item.groupnames.slice(0, 10) : []).map((group) => clean(group, 80)).filter(Boolean).sort();
      // Stable identity separates teaching groups even when identical subject names occur.
      const groupKey = digest(`${item.subjectid}|${groups.join('|')}|${teacherIds.sort().join('|')}`);
      const cancelled = Boolean(item.removed) || ['absent', ''].includes(item.type);
      const id = `edupage:${digest(`${identity.accountKey}|${date}|${start}|${end}|${groupKey}|${room}`)}`;
      lessons.push({ id, date, start, end, course, teacher, room, groups, groupKey, cancelled, period: /^\d+$/.test(String(item.uniperiod)) ? Number(item.uniperiod) : null });
      options.set(groupKey, { key: groupKey, course, teacher, groups, label: [course, groups.join(' / '), teacher].filter(Boolean).join(' · ') });
    }
  }
  return { lessons: [...new Map(lessons.map((item) => [item.id, item])).values()].sort((a, b) => `${a.date}${a.start}${a.course}`.localeCompare(`${b.date}${b.start}${b.course}`)), options: [...options.values()], skipped };
}

class SchoolDataClient {
  constructor({ fetch, now = () => new Date(), timeoutMs = 20000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    if (typeof fetch !== 'function') throw new TypeError('SchoolDataClient requires an injected session fetch');
    this.fetch = fetch; this.now = now; this.timeoutMs = timeoutMs; this.pause = pause;
  }
  async request(site, raw, { method = 'GET', body } = {}) {
    let url = readUrl(site, raw, method);
    if (method === 'POST') {
      const form = new URLSearchParams(body);
      const keys = ['gpid', 'gsh', 'action', 'user', 'changes', 'date', 'dateto', '_LJSL'];
      if ([...form.keys()].length !== keys.length || keys.some((key) => form.getAll(key).length !== 1) || form.get('action') !== 'loadData' || form.get('changes') !== '{}' || form.get('_LJSL') !== '4096' || !validDate(form.get('date')) || ![0, 1, 2].some((days) => form.get('dateto') === addDays(form.get('date'), days))) fail('WRITE_NOT_ALLOWED', '只允许读取课表，不允许修改学校数据');
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      for (let redirect = 0; redirect < 4; redirect += 1) {
        const response = await this.fetch(site, url, { method, body, redirect: 'manual', credentials: 'include', cache: 'no-store', signal: abort.signal, headers: { Accept: 'text/html,application/json', ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } });
        if (response.status === 401 || response.status === 403) fail('LOGIN_REQUIRED', '登录已过期或没有读取权限，请在内置网页重新登录');
        if (response.status >= 300 && response.status < 400) {
          const destination = new URL(response.headers.get('location') || '', url);
          if (/login|session|auth/i.test(destination.pathname)) fail('LOGIN_REQUIRED', '登录已过期，请在内置网页重新登录');
          if (method !== 'GET') fail('PAGE_CHANGED', 'EduPage 课表请求需要重新登录');
          url = readUrl(site, destination.href); continue;
        }
        if (!response.ok) fail('NETWORK_ERROR', '学校网站暂时没有响应，请稍后刷新');
        if (response.url && response.url !== url) readUrl(site, response.url, method);
        const length = Number(response.headers.get('content-length') || 0);
        if (length > MAX_HTML_BYTES) fail('PAGE_TOO_LARGE', '学校页面过大');
        let result;
        if (response.body?.getReader) {
          const reader = response.body.getReader(); const chunks = []; let size = 0;
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > MAX_HTML_BYTES) { await reader.cancel(); fail('PAGE_TOO_LARGE', '学校页面过大'); } chunks.push(Buffer.from(chunk.value)); }
          result = Buffer.concat(chunks).toString('utf8');
        } else result = await response.text();
        if (Buffer.byteLength(result) > MAX_HTML_BYTES) fail('PAGE_TOO_LARGE', '学校页面过大');
        return result;
      }
      fail('PAGE_CHANGED', '学校页面重定向过多，请在原网页查看');
    } catch (error) {
      if (error instanceof SchoolDataError) throw error;
      if (error.code === 'BODY_TOO_LARGE') fail('PAGE_TOO_LARGE', '学校页面过大，请在原网页查看');
      fail(abort.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', abort.signal.aborted ? '读取学校数据超时，请稍后刷新' : '暂时无法读取学校网站，请检查网络后刷新');
    } finally { clearTimeout(timer); }
  }
  async syncManageBac() {
    const courses = new Map(); const tasks = new Map(); const warnings = [];
    let capped = false;
    for (let page = 1; page <= 8; page += 1) {
      const result = parseManageBacCourses(await this.request('managebac', `/student/classes/my?page=${page}`));
      if (page === 1 && !result.recognized) fail('PAGE_CHANGED', '没有识别到课程列表；学校页面可能已变化，请在原网页查看');
      let added = 0;
      for (const course of result.courses) if (!courses.has(course.id)) { courses.set(course.id, { ...course, grade: null }); added += 1; }
      if (!added || result.empty) break;
      if (page === 8) capped = true;
      await this.pause(120);
    }
    if (capped || courses.size > 30) warnings.push('课程较多，本次最多显示 30 门课；其余请在原网页查看');
    for (const course of [...courses.values()].slice(0, 30)) {
      try {
        const grade = parseManageBacGrade(await this.request('managebac', `/student/classes/${course.id}/units`));
        course.grade = grade.grade;
        if (!grade.recognized) warnings.push(`${course.name}：暂时无法识别总评`);
        await this.pause(120);
        const parsed = parseManageBacTasks(await this.request('managebac', `/student/classes/${course.id}/core_tasks`), course);
        for (const task of parsed.tasks) tasks.set(task.id, task);
        if (!parsed.recognized) warnings.push(`${course.name}：未识别到作业列表，请在原网页核对`);
      } catch (error) {
        if (error.code === 'LOGIN_REQUIRED') throw error;
        warnings.push(`${course.name}：部分数据没有同步成功`);
      }
      await this.pause(120);
    }
    return { source: 'managebac', fetchedAt: this.now().toISOString(), courses: [...courses.values()].slice(0, 30), tasks: [...tasks.values()].slice(0, 1000), warnings: warnings.slice(0, 30) };
  }
  async getCourseDetail(courseId) {
    const id = validatedId(courseId);
    const base = `/student/classes/${id}`;
    const unitsHtml = await this.request('managebac', `${base}/units`);
    const doc = htmlDocument(unitsHtml);
    const grade = parseManageBacGrade(unitsHtml).grade;
    const result = { id, name: text(doc, 'h1', 160), grade, url: `${ORIGINS.managebac}${base}/units`, units: text(doc.querySelector('.units-list-tab, .units-tabs'), null, 6000), tasks: [], files: [], events: [], warnings: [], fetchedAt: this.now().toISOString() };
    for (const section of ['core_tasks', 'files', 'events.json']) {
      await this.pause(120);
      try {
        const body = await this.request('managebac', `${base}/${section}`);
        if (section === 'core_tasks') result.tasks = parseManageBacTasks(body, { id, name: result.name }).tasks;
        if (section === 'files') result.files = parseCourseFiles(body, id);
        if (section === 'events.json') {
          let parsed;
          try { parsed = JSON.parse(body); } catch { fail('PAGE_CHANGED', '未识别到课程日历'); }
          const events = Array.isArray(parsed) ? parsed : parsed.events || parsed.items;
          if (!Array.isArray(events)) fail('PAGE_CHANGED', '未识别到课程日历');
          result.events = events.slice(0, 200).map((event) => ({ id: clean(event.id, 80), title: clean(event.title, 240), start: clean(event.start, 40), end: clean(event.end, 40), allDay: event.allDay === true, url: safeSourceUrl('managebac', event.url) })).filter((event) => event.title && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(event.start));
        }
      } catch (error) {
        if (error.code === 'LOGIN_REQUIRED') throw error;
        result.warnings.push(`${section === 'files' ? '课程文件' : section === 'core_tasks' ? '课程作业' : '课程日历'}暂时未能读取，请在原网页查看`);
      }
    }
    return result;
  }
  async getTaskDetail(courseId, taskId) {
    const cid = validatedId(courseId); const tid = validatedId(taskId);
    const path = `/student/classes/${cid}/core_tasks/${tid}`;
    return { id: `managebac:${cid}:${tid}`, courseId: cid, taskId: tid, url: `${ORIGINS.managebac}${path}`, ...parseTaskDetail(await this.request('managebac', path)), fetchedAt: this.now().toISOString() };
  }
  async getCourseDiscussions(courseId) {
    const id = validatedId(courseId); const path = `/student/classes/${id}/discussions`;
    const parsed = parseManageBacDiscussions(await this.request('managebac', path), id);
    if (!parsed.recognized) fail('PAGE_CHANGED', '没有识别到课程讨论列表，请在原网页查看');
    return { courseId: id, discussions: parsed.discussions, url: `${ORIGINS.managebac}${path}`, fetchedAt: this.now().toISOString() };
  }
  async getDiscussionDetail(courseId, discussionId) {
    const cid = validatedId(courseId); const did = validatedId(discussionId);
    const path = `/student/classes/${cid}/discussions/${did}`;
    return { courseId: cid, discussionId: did, url: `${ORIGINS.managebac}${path}`, ...parseDiscussionDetail(await this.request('managebac', path), cid, did), fetchedAt: this.now().toISOString() };
  }
  async getCoreOverview(kind) {
    if (!['cas', 'ee'].includes(kind)) fail('INVALID_ID', '请选择 CAS 或 EE');
    const path = kind === 'cas' ? '/student/ib/activity/cas' : '/student/ib/pbl/778';
    return { kind, ...parseCoreOverview(await this.request('managebac', path), kind), url: `${ORIGINS.managebac}${path}`, fetchedAt: this.now().toISOString() };
  }
  async syncEduPage({ weekStart } = {}) {
    if (!validDate(weekStart)) fail('INVALID_DATE', '请选择正确的课表日期');
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const identity = parseEduPageIdentity(await this.request('edupage', '/user'));
    const merged = {}; const warnings = [];
    // Port the upstream three-anchor week request; if the server returns smaller
    // windows, supplement only uncovered days. Never mistake a missing date for
    // an empty timetable. At most seven requests; each request gets a fresh nonce.
    const anchors = [dates[0], dates[3], dates[6]];
    for (const date of [...anchors, ...dates.filter((day) => !anchors.includes(day))]) {
      if (Array.isArray(merged[date]?.plan)) continue;
      try {
        const nonce = parseEduPageNonce(await this.request('edupage', '/dashboard/eb.php?mode=ttday'));
        const form = new URLSearchParams({ ...nonce, action: 'loadData', user: identity.id, changes: '{}', date, dateto: addDays(date, 2), _LJSL: '4096' });
        const payload = parseEduPageEnvelope(await this.request('edupage', '/gcall', { method: 'POST', body: form.toString() }));
        for (const requested of dates) if (Array.isArray(payload.dates[requested]?.plan)) merged[requested] = payload.dates[requested];
      } catch (error) {
        if (error.code === 'LOGIN_REQUIRED') throw error;
        warnings.push(`${date}：课表没有同步成功`);
      }
      await this.pause(150);
    }
    const missingDates = dates.filter((date) => !Array.isArray(merged[date]?.plan));
    if (missingDates.length === 7) fail('PAGE_CHANGED', '本周课表读取失败；请在 EduPage 原网页核对登录状态与课表');
    const endIdentity = parseEduPageIdentity(await this.request('edupage', '/user'));
    if (endIdentity.accountKey !== identity.accountKey || endIdentity.classId !== identity.classId) fail('ACCOUNT_CHANGED', '同步过程中账号已切换，请重新刷新');
    const parsed = eduRows(merged, identity, dates);
    if (parsed.skipped) warnings.push(`有 ${parsed.skipped} 条课程缺少名称或时间，未列入课表`);
    if (!parsed.lessons.length) warnings.push('未找到当前班级的完整课程；请在 EduPage 原网页核对，不能据此判断本周无课');
    warnings.push('课表包含当前班级可选教学组，请选择自己的教学组；调课与停课以 EduPage 原网页为准');
    const ownClass = lookup(identity.dbi, 'classes', identity.classId);
    return { source: 'edupage', accountKey: identity.accountKey, className: clean(ownClass.name || ownClass.short, 160), fetchedAt: this.now().toISOString(), weekStart, lessons: parsed.lessons, options: parsed.options, missingDates, warnings };
  }
}

module.exports = { ORIGINS, SchoolDataClient, SchoolDataError, readUrl, safeSourceUrl, parseManageBacCourses, parseManageBacGrade, parseManageBacTasks, parseCourseFiles, parseTaskDetail, parseManageBacDiscussions, parseDiscussionDetail, parseCoreOverview, parseEduPageIdentity, parseEduPageNonce, parseEduPageEnvelope, eduRows };
