'use strict';
// PHL / Lite 共用文件的兼容回归：任何写回都只能覆盖已知字段，不能整份重建抹掉对方扩展。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schedule = require('../electron/shared-schedule.cjs');
const timetable = require('../electron/shared-timetable.cjs');
const school = require('../electron/shared-school.cjs');
const sessions = require('../electron/shared-sessions.cjs');
const settings = require('../electron/settings-yaml.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-compat-'));
const fixedNow = () => new Date('2026-11-10T10:00:00+08:00');

test('Schedule upsert/remove 保留顶层和条目未知字段，删除最大 id 后仍守住 lastId 高水位', () => {
  const file = path.join(temp, 'Schedule');
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    kind: 'pinghe-schedule',
    app: 'Pinghe Launcher Lite',
    updated_at: '2026-11-09T10:00:00+08:00',
    'x-lite-top': { keep: true },
    events: [{ id: 9, day: '2026-11-10', time: '08:00', title: '旧标题', note: '', 'x-lite-event': 'keep' }],
  }, null, 2)}\n`);

  schedule.upsertEvents(file, [{ matchId: 9, day: '2026-11-10', time: '08:30', title: '新标题', note: '改' }], { now: fixedNow() });
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc['x-lite-top'], { keep: true });
  assert.equal(doc.events[0]['x-lite-event'], 'keep');

  schedule.removeEvents(file, 9, { now: fixedNow() });
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.lastId, 9, '没有 lastId 的旧文件也要在删除前记录高水位');
  assert.deepEqual(doc['x-lite-top'], { keep: true });
  const added = schedule.upsertEvents(file, [{ day: '2026-11-11', time: '09:00', title: '下一条' }], { now: fixedNow() });
  assert.equal(added.doc.events[0].id, 10, '已删除的最大 id 不得复用');
});

test('Timetable 写回保留顶层未知键和对应课卡未知字段', () => {
  const file = path.join(temp, 'Timetable');
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    kind: 'pinghe-timetable',
    app: 'Pinghe Launcher Lite',
    'x-lite-top': 'keep',
    days: {
      '2026-11-10': [{ subject: 'Math', teacher: 'Old', room: 'R1', start: '08:00', end: '08:40', group: 'A', cancelled: false, 'x-lite-card': { color: 'blue' } }],
    },
  }, null, 2)}\n`);
  const incoming = timetable.buildDocFromEdupage({ lessons: [
    { date: '2026-11-10', course: 'Math', teacher: 'New', room: 'R2', start: '08:00', end: '08:40', group: 'A', cancelled: false },
  ] }, { now: fixedNow });
  timetable.writeDoc(file, incoming, { now: fixedNow });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc['x-lite-top'], 'keep');
  assert.deepEqual(doc.days['2026-11-10'][0]['x-lite-card'], { color: 'blue' });
  assert.equal(doc.days['2026-11-10'][0].teacher, 'New');
});

test('School 段、课程/作业/邮件条目及任意顶层段的未知字段都保留', () => {
  const file = path.join(temp, 'School');
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    kind: 'pinghe-school',
    app: 'Pinghe Launcher Lite',
    updated_at: '2026-11-09T10:00:00+08:00',
    'x-lite-top': true,
    managebac: {
      fetched_at: 'old',
      'x-lite-section': 'keep',
      courses: [{ id: '11', name: 'Biology', grade: '6', 'x-lite-course': 1 }],
      tasks: [{ id: '22', course_id: '11', title: 'Lab', status: 'Pending', 'x-lite-task': 2 }],
    },
    mail: { unread: 1, 'x-lite-mail': 3, recent: [{ uid: '7', subject: 'Old', 'x-lite-message': 4 }] },
    notifications: { unread: 2, 'x-lite-notifications': 5 },
  }, null, 2)}\n`);

  school.updateSchool(file, {
    managebac: { fetched_at: 'new', courses: [{ id: '11', name: 'Biology HL', grade: '7' }], tasks: [{ id: '22', course_id: '11', title: 'Lab report', status: 'Submitted' }] },
    mail: { unread: 0, recent: [{ uid: '7', subject: 'New' }] },
    notifications: { unread: 0 },
  }, { now: fixedNow });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc['x-lite-top'], true);
  assert.equal(doc.managebac['x-lite-section'], 'keep');
  assert.equal(doc.managebac.courses[0]['x-lite-course'], 1);
  assert.equal(doc.managebac.tasks[0]['x-lite-task'], 2);
  assert.equal(doc.mail['x-lite-mail'], 3);
  assert.equal(doc.mail.recent[0]['x-lite-message'], 4);
  assert.equal(doc.notifications['x-lite-notifications'], 5);
  assert.equal(doc.managebac.tasks[0].status, 'Submitted');
});

test('agent 会话写回保留顶层和同位置消息的未知字段', () => {
  const directory = path.join(temp, 'agent');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'shared-1.json');
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    kind: 'phl-agent-session',
    id: 'shared-1',
    title: '旧标题',
    app: 'Pinghe Launcher Lite',
    'x-lite-top': { model: 'lite' },
    history: [{ role: 'user', content: '旧问题', 'x-lite-message': { attachment: 'a' } }],
  }, null, 2)}\n`);
  sessions.writeSharedSession(directory, { id: 'shared-1', title: '新标题', messages: [{ role: 'user', content: '新问题' }] }, { now: fixedNow });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc['x-lite-top'], { model: 'lite' });
  assert.deepEqual(doc.history[0]['x-lite-message'], { attachment: 'a' });
  assert.equal(doc.history[0].content, '新问题');
});

test('settings.yaml replaceBlock 保留未知字段、对应列表条目扩展和注释', () => {
  const original = [
    'accounts:',
    '  # Lite 平台不能被 PHL 丢掉',
    '  xinlv:',
    '    username: lite-user',
    '    future_token: keep',
    '  edupage:',
    '    username: old',
    '    future_flag: keep',
    '',
    'lessons:',
    '- subject: Math',
    '  start: 08:00',
    '  group: A',
    '  future_color: blue',
    '# Lite 的课卡注释',
    '- subject: Removed',
    '  start: 09:00',
    '  group: B',
    '',
    'future_section:',
    '  keep: true',
    '',
  ].join('\n');
  const accountsBody = settings.serializeNestedMap('accounts', { edupage: { username: 'new' } });
  let updated = settings.replaceBlock(original, 'accounts', accountsBody);
  assert.equal(settings.readNestedMap(updated, 'accounts').xinlv.future_token, 'keep');
  assert.equal(settings.readNestedMap(updated, 'accounts').edupage.future_flag, 'keep');
  assert.match(updated, /# Lite 平台不能被 PHL 丢掉/);

  updated = settings.replaceBlock(updated, 'lessons', [
    'lessons:',
    '- subject: Math',
    '  start: 08:00',
    '  group: A',
    '  teacher: New',
    '',
  ].join('\n'));
  assert.match(updated, /future_color: blue/);
  assert.match(updated, /# Lite 的课卡注释/);
  assert.doesNotMatch(updated, /subject: Removed/);
  assert.match(updated, /future_section:\n  keep: true/);
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });
