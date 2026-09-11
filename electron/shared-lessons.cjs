'use strict';
// 共用选课：settings.yaml 的 lessons 段（科目 + 教学组 + 老师）↔ 某个课表快照里的教学组标识。
//
// 为什么需要这一层：两个程序共用同一份"我选了哪些课"，但各自抓到的课表给教学组的
// 标识不一样（PH Launcher 用它自己算的组标识，Pinghe Launcher Lite 写进共用文件的
// 课表用 digest('shared:科目|组|老师')）。所以共用选课不能存成某一方的组标识，
// 只能存"科目 + 教学组 + 老师"这种两边都认得的说法，用的时候对着当前这份课表重新解析。
const LESSON_FIELD = /^\s+([a-z_]+):\s*(.*)$/;
const LESSON_ITEM = /^-\s*subject:\s*(.+)$/;

const text = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const unquote = (value) => String(value || '').trim().replace(/^'|'$/g, '');

/** 解析 settings.yaml 里的 lessons 段（容错读取，坏行直接跳过）。 */
function parseEntries(source) {
  const entries = [];
  if (typeof source !== 'string' || !source) return entries;
  let active = null;
  let inside = false;
  for (const line of source.split('\n')) {
    if (!inside) {
      // 只认顶层 lessons: 段，避免读到别的段落里的同名键。
      if (/^lessons:\s*$/.test(line.trimEnd())) inside = true;
      continue;
    }
    const item = line.match(LESSON_ITEM);
    if (item) { active = { subject: unquote(item[1]) }; entries.push(active); continue; }
    if (!active) continue;
    const field = line.match(LESSON_FIELD);
    if (!field) {
      // 缩进结束（回到顶层段落）→ lessons 段读完了。
      if (line.trim() && !/^\s/.test(line)) break;
      continue;
    }
    const [, key, value] = field;
    if (key === 'teacher' || key === 'group') active[key] = unquote(value);
  }
  return entries.filter((entry) => entry.subject);
}

/**
 * 共用选课 → 某一门课表 options 里的教学组标识。
 * 老师优先消歧：同名科目有多个组时用老师定人；老师对不上，再退回"科目 + 组号"。
 * group 允许写成 "A/B"（同一门课多个组）——任一命中即可。
 */
function resolveGroupKeys(entries, options) {
  const list = Array.isArray(options) ? options : [];
  const keys = new Set();
  for (const entry of entries || []) {
    const subject = text(entry?.subject);
    if (!subject) continue;
    const wanted = text(entry?.group).split(/[/,]/).map((value) => value.trim()).filter(Boolean);
    const teacher = text(entry?.teacher);
    const candidates = list.filter((option) => text(option.course) === subject
      && (!wanted.length || (option.groups || []).map(text).some((value) => wanted.includes(value))));
    const exact = teacher ? candidates.filter((option) => text(option.teacher) === teacher) : [];
    for (const option of exact.length ? exact : candidates) keys.add(option.key);
  }
  return [...keys];
}

module.exports = { parseEntries, resolveGroupKeys };
