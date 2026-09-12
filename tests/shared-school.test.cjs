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

test('作业 id 统一成 ManageBac 作业号：两个程序写的同一条作业在并集里不会变成两条', () => {
  // PHL 内部用复合 id；共享文件里必须写裸作业号（Lite 写的就是裸号）。
  assert.equal(shared.sharedTaskId('managebac:11:22'), '22');
  assert.equal(shared.sharedTaskId('22'), '22');
  assert.equal(shared.sharedTaskId(''), '');

  const phlSection = shared.managebacSection({
    source: 'managebac', fetchedAt: 'a',
    courses: [{ id: '11', name: 'Biology' }],
    tasks: [{ id: 'managebac:11:22', courseId: '11', course: 'Biology', title: 'Lab' }],
  });
  assert.equal(phlSection.tasks[0].id, '22');
  assert.equal(phlSection.tasks[0].phl_id, 'managebac:11:22', 'PHL 自己的复合 id 作为额外字段保留');

  const liteSection = { fetched_at: 'b', courses: [{ id: '11', name: 'Biology' }],
    tasks: [{ id: '22', course_id: '11', course: 'Biology', title: 'Lab', due_at: '2026-09-20T23:59', status: 'Pending' }] };
  const merged = shared.mergeManagebac(phlSection, liteSection);
  assert.equal(merged.tasks.length, 1, '同一条作业只应剩一条');

  // 读回来时拼回 PHL 的复合 id（详情/提交按"课程号 + 作业号"取）。
  const back = shared.managebacToSnapshot(merged);
  assert.equal(back.tasks[0].id, 'managebac:11:22');
  assert.equal(back.tasks[0].taskId, '22');
  // 老数据（裸 id 没有 course_id）也不能崩
  const bare = shared.managebacToSnapshot({ tasks: [{ id: '99', title: '旧数据' }] });
  assert.equal(bare.tasks[0].id, '99');
  assert.equal(bare.tasks[0].taskId, '99');
});

test('邮箱段只带摘要，不带正文', () => {
  const section = shared.mailSection({ unread: 2, fetchedAt: 'x', recent: [{ uid: '7', from: 'a@b.com', subject: 'Hi', date: 'y', unread: true, body: 'SECRET' }] });
  assert.equal(section.unread, 2);
  assert.equal(section.recent[0].unread, true);
  assert.equal('body' in section.recent[0], false, '正文绝不进共享文件');
});

test('两个程序写 managebac：按 id 取并集，谁也不抹掉谁抓到的课与作业', () => {
  // PH Launcher 抓到 2 门课 / 1 份作业
  const first = shared.mergeManagebac(null, {
    fetched_at: '2026-09-11T11:00:00+08:00',
    courses: [{ id: '11', name: 'Biology', grade: '6' }, { id: '12', name: 'Physics', grade: '6' }],
    tasks: [{ id: 't1', course_id: '11', title: 'Lab', status: 'Pending' }],
  });
  // Lite 抓到 1 门课（同 id、字段更新）/ 2 份作业（其中一份是新的）
  const merged = shared.mergeManagebac(first, {
    fetched_at: '2026-09-11T11:05:00+08:00',
    courses: [{ id: '11', name: 'Biology HL', grade: '6' }],
    tasks: [{ id: 't1', course_id: '11', title: 'Lab report', status: 'Submitted' }, { id: 't2', course_id: '12', title: 'Essay', status: 'Pending' }],
  });
  assert.deepEqual(merged.courses.map((c) => c.id), ['11', '12'], 'Lite 没抓到的课不会被删');
  assert.equal(merged.courses[0].name, 'Biology HL', '同 id 用新抓到的字段');
  assert.deepEqual(merged.tasks.map((t) => t.id), ['t1', 't2']);
  assert.equal(merged.tasks[0].title, 'Lab report');
  assert.equal(merged.fetched_at, '2026-09-11T11:05:00+08:00');
});

test('两边都写进文件后仍是并集（updateSchool 里真的走了合并）', () => {
  const merged = path.join(temp, 'School-merge');
  shared.updateSchool(merged, { managebac: shared.managebacSection({ source: 'managebac', fetchedAt: 'a', courses: [{ id: '11', name: 'Biology' }, { id: '12', name: 'Physics' }], tasks: [{ id: 't1', courseId: '11', course: 'Biology', title: 'Lab' }] }) });
  shared.updateSchool(merged, { managebac: shared.managebacSection({ source: 'managebac', fetchedAt: 'b', courses: [{ id: '11', name: 'Biology' }], tasks: [{ id: 't2', courseId: '12', course: 'Physics', title: 'Essay' }] }) });
  const doc = shared.readSchool(merged).doc;
  assert.equal(doc.managebac.courses.length, 2);
  assert.equal(doc.managebac.tasks.length, 2);
});

test('edupage：同一周取并集，换了一周就整段替换（不攒历史）', () => {
  const lesson = (date, subject, group) => ({ date, start: '08:00', end: '08:40', subject, teacher: 'T', room: 'R', group, cancelled: false });
  const sameWeek = shared.mergeEdupaged(
    { week_start: '2026-09-07', fetched_at: 'a', class_name: 'G10', lessons: [lesson('2026-09-07', 'Math', 'A')] },
    { week_start: '2026-09-07', fetched_at: 'b', class_name: 'G10', lessons: [lesson('2026-09-07', 'Math', 'A'), lesson('2026-09-08', 'Physics', 'B')] },
  );
  assert.equal(sameWeek.lessons.length, 2, '同一天同一节的重复课卡合并成一条');

  const nextWeek = shared.mergeEdupaged(
    { week_start: '2026-09-07', fetched_at: 'a', lessons: [lesson('2026-09-07', 'Math', 'A')] },
    { week_start: '2026-09-14', fetched_at: 'b', lessons: [lesson('2026-09-14', 'Math', 'A')] },
  );
  assert.equal(nextWeek.lessons.length, 1);
  assert.equal(nextWeek.week_start, '2026-09-14');
});

test('空的一周不许清掉对方写好的课表', () => {
  const lesson = (date, subject) => ({ date, start: '08:00', end: '08:40', subject, teacher: 'T', room: 'R', group: 'A', cancelled: false });
  const existing = { week_start: '2026-09-07', fetched_at: 'a', lessons: [lesson('2026-09-07', 'Math'), lesson('2026-09-08', 'Physics')] };
  // 对方按天写: 周末(空) 或下一周(空) 的写入不能把这一周清掉
  assert.equal(shared.mergeEdupaged(existing, { week_start: '2026-09-07', fetched_at: 'b', lessons: [] }).lessons.length, 2);
  assert.equal(shared.mergeEdupaged(existing, { week_start: '2026-09-14', fetched_at: 'b', lessons: [] }).lessons.length, 2);
  assert.equal(shared.mergeEdupaged(existing, { week_start: '2026-09-14', lessons: [lesson('2026-09-14', 'New')] }).lessons.length, 1, '真有课的一周才替换');
  // 双方都空时按传入的来(不然永远写不进空段)
  assert.equal(shared.mergeEdupaged({ week_start: '2026-09-07', lessons: [] }, { week_start: '2026-09-14', lessons: [] }).week_start, '2026-09-14');
});

test('对方按天写课表（week_start 落在本周内）也按同一周并集，不整段替换', () => {
  const lesson = (date, subject, group) => ({ date, start: '08:00', end: '08:40', subject, teacher: 'T', room: 'R', group, cancelled: false });
  // PLL 按天算课表：它写 2026-09-16 那天，week_start 会是当天的周一，而不是整周的周一。
  const merged = shared.mergeEdupaged(
    { week_start: '2026-09-14', fetched_at: 'a', lessons: [lesson('2026-09-15', 'PHL 写的课', 'A')] },
    { week_start: '2026-09-16', fetched_at: 'b', lessons: [lesson('2026-09-16', 'PLL 按天写的课', '')] },
  );
  assert.equal(merged.lessons.length, 2, '两天的课都要在');
  assert.equal(merged.week_start, '2026-09-14', '保留整周的周一起始日');
  // 真的换了一周才替换
  const replaced = shared.mergeEdupaged(
    { week_start: '2026-09-14', fetched_at: 'a', lessons: [lesson('2026-09-15', '旧课', 'A')] },
    { week_start: '2026-09-21', fetched_at: 'b', lessons: [lesson('2026-09-21', '新课', 'A')] },
  );
  assert.equal(replaced.lessons.length, 1);
  assert.equal(replaced.week_start, '2026-09-21');
});

test('合并遇到空段或坏段不会抛错', () => {
  assert.equal(shared.mergeManagebac(null, null), null);
  assert.deepEqual(shared.mergeManagebac({ courses: 'bad', tasks: null }, { courses: [{ id: '1' }], tasks: [] }).courses, [{ id: '1' }]);
  assert.equal(shared.mergeEdupaged(undefined, { week_start: '2026-09-07' }).week_start, '2026-09-07');
  assert.equal(shared.mergeEdupaged({ week_start: '2026-09-07' }, null).week_start, '2026-09-07');
});

test('共享段的时间戳一律带本地时区偏移（UTC 的 Z 写法会被换算过来）', () => {
  const lesson = { id: 'x', date: '2026-09-07', start: '08:00', end: '08:40', course: 'Math', teacher: 'T', room: 'R', groups: ['A'], groupKey: 'k1', cancelled: false };
  const utc = '2026-09-11T03:51:28.854Z';
  const edupage = shared.edupageSection({ source: 'edupage', weekStart: '2026-09-07', fetchedAt: utc, lessons: [lesson], options: [] });
  assert.match(edupage.fetched_at, /[+-]\d{2}:\d{2}$/, '带本地偏移，不是 Z');
  assert.ok(Math.abs(Date.parse(edupage.fetched_at) - Date.parse(utc)) < 1000, '换算后还是同一时刻');

  const managebac = shared.managebacSection({ source: 'managebac', fetchedAt: utc, courses: [], tasks: [] });
  assert.match(managebac.fetched_at, /[+-]\d{2}:\d{2}$/);

  assert.equal(shared.mailSection({ fetchedAt: '' }).fetched_at, '', '拿不到时间就留空，不编一个');
  assert.equal(shared.localStamp('还没同步'), '还没同步', '不是时间的字符串原样保留');
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });
