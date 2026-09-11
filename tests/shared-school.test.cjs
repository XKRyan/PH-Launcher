'use strict';
// 共用学校数据 data/School：读写容错、段级合并、两端形状互转。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('../electron/shared-school.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-school-'));
const file = path.join(temp, 'School');

test('缺失/损坏/别的 kind 的文件都按"还没有共享数据"处理', () => {
  assert.deepEqual(shared.readSchool(path.join(temp, 'nope')).doc, null);
  fs.writeFileSync(file, '{not json');
  const broken = shared.readSchool(file);
  assert.equal(broken.exists, true);
  assert.equal(broken.repaired, true);
  assert.equal(broken.doc, null);
  fs.writeFileSync(file, JSON.stringify({ kind: 'something-else', managebac: { courses: [] } }));
  assert.equal(shared.readSchool(file).doc, null);
});

test('段级合并：只改传入的段，别的段与其他字段原样保留（含未知字段）', () => {
  shared.updateSchool(file, { managebac: { fetched_at: 'x', courses: [{ id: '11', name: 'Biology', grade: '6' }], tasks: [] } }, { app: 'A' });
  shared.updateSchool(file, { edupage: { week_start: '2026-09-07', lessons: [{ date: '2026-09-07', start: '08:00', end: '08:40', subject: 'Math', teacher: 'T', room: 'R', group: 'A' }] } }, { app: 'B' });
  const doc = shared.readSchool(file).doc;
  assert.equal(doc.app, 'B');
  assert.equal(doc.managebac.courses[0].name, 'Biology', 'managebac 段被保留');
  assert.equal(doc.edupage.lessons.length, 1);
  assert.match(doc.updated_at, /[+-]\d{2}:\d{2}$/, '时间戳带本地偏移');
  // 未知字段（未来版本写入的）必须被保留
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.future_section = { keep: true };
  fs.writeFileSync(file, JSON.stringify(raw));
  shared.updateSchool(file, { mail: { unread: 3 } });
  const after = shared.readSchool(file).doc;
  assert.deepEqual(after.future_section, { keep: true });
  assert.equal(after.mail.unread, 3);
});

test('PHL 快照 → 共享段 → PHL 快照 往返不丢关键信息', () => {
  const edupage = shared.edupageSection({
    source: 'edupage',
    weekStart: '2026-09-07',
    fetchedAt: '2026-09-11T11:09:00+08:00',
    className: 'G10',
    lessons: [{ id: 'x', date: '2026-09-07', start: '08:00', end: '08:40', course: 'Math AA', teacher: 'T', room: 'R', groups: ['A'], groupKey: 'k1', cancelled: false }],
    options: [],
  }, { selectedGroups: ['Math AA · A · T'] });
  assert.equal(edupage.lessons[0].subject, 'Math AA');
  assert.deepEqual(edupage.selected_groups, ['Math AA · A · T']);

  const back = shared.edupageToSnapshot(edupage);
  assert.equal(back.lessons[0].course, 'Math AA');
  assert.equal(back.weekStart, '2026-09-07');
  assert.equal(back.lessons[0].teacher, 'T');
  assert.deepEqual(back.selectedGroups, ['Math AA · A · T']);
  assert.ok(back.options.length === 1 && back.options[0].key === back.lessons[0].groupKey, '教学组选项与课卡的组标识一致');

  const managebac = shared.managebacSection({
    source: 'managebac',
    fetchedAt: '2026-09-11T11:09:00+08:00',
    courses: [{ id: '11', name: 'Biology', grade: '6' }],
    tasks: [{ id: 'managebac:11:22', courseId: '11', course: 'Biology', title: 'Lab', dueAt: '2026-09-20T23:59:00', dueText: 'Sep 20', status: 'Pending', score: '' }],
  });
  const seen = shared.managebacToSnapshot(managebac);
  assert.equal(seen.courses[0].name, 'Biology');
  assert.equal(seen.tasks[0].courseId, '11');
  assert.equal(seen.tasks[0].dueText, 'Sep 20');
  assert.equal(seen.tasks[0].pastDue, false);
});

test('邮箱段只带摘要，不带正文', () => {
  const section = shared.mailSection({ unread: 2, fetchedAt: 'x', recent: [{ uid: '7', from: 'a@b.com', subject: 'Hi', date: 'y', unread: true, body: 'SECRET' }] });
  assert.equal(section.unread, 2);
  assert.equal(section.recent[0].unread, true);
  assert.equal('body' in section.recent[0], false, '正文绝不进共享文件');
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });
