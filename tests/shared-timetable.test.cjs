'use strict';
// 共享课表 data/Timetable：读取容错、缓存条目还原与键往返。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDocFromEdupage, readTimetable, toCacheEntry, writeDoc } = require('../electron/shared-timetable.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-timetable-'));
const file = path.join(temp, 'Timetable');
const lesson = (extra = {}) => ({ subject: 'ESS SL1(G3)', teacher: 'Yan Xu', room: 'A212', start: '08:00', end: '08:40', group: 'P', cancelled: false, ...extra });

test('缺失与损坏的共享课表按"没有课表"处理，绝不抛错', () => {
  const missing = readTimetable(path.join(temp, 'nope'));
  assert.deepEqual({ exists: missing.exists, days: missing.days }, { exists: false, days: {} });
  fs.writeFileSync(file, '{not json');
  const broken = readTimetable(file);
  assert.equal(broken.repaired, true);
  assert.equal(broken.exists, true);
  assert.deepEqual(broken.days, {});
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', '损坏文件不会被删除或改写');
});

test('非法日期/时间/空科目的课卡被跳过，合法的按天分组', () => {
  fs.writeFileSync(file, JSON.stringify({
    version: 1, kind: 'pinghe-timetable', app: 'Pinghe Launcher Lite',
    days: {
      '2026-09-14': [lesson(), lesson({ start: '7:00' }), lesson({ subject: '  ' })],
      'not-a-date': [lesson()],
      '2026-09-15': [],
    },
  }));
  const read = readTimetable(file);
  assert.deepEqual(Object.keys(read.days), ['2026-09-14']);
  assert.equal(read.weekStart, '2026-09-14');
  assert.equal(read.days['2026-09-14'].length, 1);
});

test('缓存条目还原：lesson 键映射、组标识稳定、选项可构建', () => {
  const doc = { version: 1, kind: 'pinghe-timetable', days: { '2026-09-14': [lesson()] } };
  const entry = toCacheEntry(doc, { at: 12345 });
  assert.equal(entry.key, 'edupage:2026-09-14');
  assert.equal(entry.data.source, 'edupage');
  assert.equal(entry.data.accountKey, 'shared:timetable');
  const row = entry.data.lessons[0];
  assert.equal(row.course, 'ESS SL1(G3)');
  assert.equal(row.date, '2026-09-14');
  assert.equal(row.source, 'lite');
  assert.match(row.id, /^lite:[0-9a-f]{20}$/);
  assert.equal(row.groupKey, entry.groupKeys[0]);
  assert.equal(entry.data.options[0].label, 'ESS SL1(G3) · P · Yan Xu');
  // 同一门课（科目+组+老师相同）两次出现 → 同一个组标识
  const again = toCacheEntry({ days: { '2026-09-15': [lesson()] } }, { at: 2 });
  assert.equal(again.groupKeys[0], entry.groupKeys[0]);
  // 取消的课不进选项
  const cancelled = toCacheEntry({ days: { '2026-09-16': [lesson({ cancelled: true })] } }, { at: 3 });
  assert.equal(cancelled.data.options.length, 0);
  assert.equal(cancelled.data.lessons[0].cancelled, true);
});

test('PHL 侧写回的键与 Lite 课卡一致，往返不丢内容', () => {
  const doc = buildDocFromEdupage({ lessons: [{ date: '2026-09-14', start: '08:00', end: '08:40', course: 'ESS SL1(G3)', teacher: 'Yan Xu', room: 'A212', group: 'P', cancelled: false }] });
  assert.deepEqual(doc.days['2026-09-14'], [{ subject: 'ESS SL1(G3)', teacher: 'Yan Xu', room: 'A212', start: '08:00', end: '08:40', group: 'P', cancelled: false }]);
  writeDoc(file, doc, { now: () => new Date('2026-09-10T15:00:00+08:00') });
  const read = readTimetable(file);
  const entry = toCacheEntry(read, { at: read.mtime });
  assert.equal(entry.data.lessons[0].course, 'ESS SL1(G3)');
  assert.match(read.days['2026-09-14'][0].subject, /ESS/);
  // 写入是原子且 UTF-8：无临时文件残留
  assert.deepEqual(fs.readdirSync(temp).filter((name) => name.endsWith('.tmp')), []);
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });
