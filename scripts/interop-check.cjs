'use strict';
// 两个软件的共用数据互通自检 · PH Launcher 侧。
//
// PH Launcher 与 Pinghe Launcher Lite 装在同一文件夹、共用同一个 data/。
// 本脚本用 PHL 的真实模块往数据目录里写/读，与 PLL 仓库的 scripts/interop_check.py
// 交替运行，验证"对方写的东西我读得到、我写的东西对方读得到、未知字段谁都不许抹掉"。
//
// 用法（数据目录请用副本，别拿真实数据当靶子）：
//   node scripts/interop-check.cjs seed  <dataDir>
//   set PHLL_DATA_DIR=<dataDir> && python -X utf8 <PLL 仓库>/scripts/interop_check.py check
//   set PHLL_DATA_DIR=<dataDir> && python -X utf8 <PLL 仓库>/scripts/interop_check.py write
//   node scripts/interop-check.cjs check <dataDir>
//
// 退出码 0 = 全部检查通过。
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON = path.join(__dirname, '..', 'electron');
const schedule = require(`${ELECTRON}/shared-schedule.cjs`);
const sessions = require(`${ELECTRON}/shared-sessions.cjs`);
const school = require(`${ELECTRON}/shared-school.cjs`);
const timetable = require(`${ELECTRON}/shared-timetable.cjs`);
const settingsYaml = require(`${ELECTRON}/settings-yaml.cjs`);
const sharedLessons = require(`${ELECTRON}/shared-lessons.cjs`);

const mode = process.argv[2];
const dir = path.resolve(process.argv[3] || '');
if (!['seed', 'check'].includes(mode) || !dir) {
  console.error('usage: node interop-node.cjs seed|check <dataDir>');
  process.exit(1);
}

const files = {
  schedule: path.join(dir, 'Schedule'),
  school: path.join(dir, 'School'),
  timetable: path.join(dir, 'Timetable'),
  settings: path.join(dir, 'settings.yaml'),
  agent: path.join(dir, 'agent'),
};
const report = { mode, dir, checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); };

function patchRawJson(file, mutate) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(doc);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

if (mode === 'seed') {
  const stamp = '2026-09-20';
  const written = schedule.upsertEvents(files.schedule, [
    { day: stamp, time: '15:30', title: 'PHL→PLL 日程互通', note: '来自 PH Launcher' },
    { day: stamp, time: '16:00', title: 'PHL 测试用·待删除', note: '用来制造 id 空洞' },
  ], { app: 'PH Launcher' });
  report.schedule = { added: written.added, ids: written.doc.events.map((event) => event.id) };
  // 删掉刚写入的那条"待删除": 文件里只留 lastId 高水位, 对方新增时不许把 id 用回来。
  const throwaway = written.doc.events.find((event) => event.title === 'PHL 测试用·待删除');
  const removal = schedule.removeEvents(files.schedule, [throwaway.id], { app: 'PH Launcher' });
  report.scheduleRemoved = { id: throwaway.id, removed: removal.removed, lastId: removal.doc.lastId };

  // 埋两个"未来版本才有的未知字段": 对方写回时必须原样保留(数据规范 §2.3)。
  patchRawJson(files.schedule, (doc) => { doc.future_field_schedule = 'keep-me'; });
  // PHL 同步完会同时写两份: data/Timetable(兼容格式) + data/School 的 edupage 段(统一格式)。
  school.updateSchool(files.school, {
    mail: school.mailSection({ unread: 7, recent: [{ uid: '9001', from: 'PHL <phl@example.com>', subject: 'PHL 摘要', date: '09-20 15:30', unread: true }], fetchedAt: '2026-09-20T15:30:00+08:00' }),
    edupage: school.edupageSection({
      source: 'edupage', accountKey: 'interop-account', weekStart: '2026-09-14', fetchedAt: '2026-09-20T15:30:00+08:00', className: '互通测试班',
      lessons: [{ id: 'x1', date: '2026-09-15', start: '15:30', end: '16:10', course: '互通测试课', teacher: 'T', room: 'R', group: '', groupKey: 'k1', cancelled: false }],
      options: [],
    }, { selectedGroups: ['互通测试课 ·  · T'] }),
  });
  patchRawJson(files.school, (doc) => { doc.future_field_school = 'keep-me'; });
  const timetableDoc = timetable.writeDoc(files.timetable, {
    version: 1, kind: 'pinghe-timetable', app: 'PH Launcher',
    days: { '2026-09-20': [{ subject: '互通测试课', teacher: 'T', room: 'R', start: '15:30', end: '16:10', group: '', cancelled: false }] },
  });
  patchRawJson(files.timetable, (doc) => { doc.future_field_timetable = 'keep-me'; });
  report.timetable = { days: Object.keys(timetableDoc.days) };

  const session = sessions.writeSharedSession(files.agent, {
    id: 'phl-interop-1', title: 'PHL 互通会话',
    messages: [{ role: 'user', content: '从 PH Launcher 写的' }, { role: 'assistant', content: '收到' }],
  });
  report.session = { ok: session.ok, path: path.basename(session.path || '') };

  const text = settingsYaml.readTextFile(files.settings);
  const accounts = settingsYaml.replaceBlock(text, 'accounts', [
    'accounts:',
    '  edupage:',
    '    username: interop-user',
    '    password: interop-secret',
    '    email: interop@example.com',
    '',
  ].join('\n'));
  const withFuture = `${accounts}future_section:\n  keep: true\n`;
  settingsYaml.atomicWriteFileSync(files.settings, withFuture);
  report.settings = { bytes: withFuture.length };
}

if (mode === 'check') {
  const doc = schedule.readSchedule(files.schedule);
  const titles = doc.doc.events.map((event) => event.title);
  check('PLL 写的日程事件 PHL 读得到', titles.includes('PLL→PHL 日程互通'), titles.join(' | '));
  check('PHL 写的日程事件还在', titles.includes('PHL→PLL 日程互通'), titles.join(' | '));
  check('日程里的未知字段被 PLL 保留', doc.doc.future_field_schedule === 'keep-me', String(doc.doc.future_field_schedule));
  check('日程 id 高水位 lastId 被保留', Number(doc.doc.lastId) >= 1, String(doc.doc.lastId));
  // PHL 在 seed 阶段删掉了自己那条"待删除"事件。真正的"id 不许复用"由 PLL 侧
  // (interop_check.py write)在自己写入前断言; 这里只检查 id 没有重复。
  const pllEvent = doc.doc.events.find((event) => event.title === 'PLL→PHL 日程互通');
  const eventIds = doc.doc.events.map((event) => Number(event.id));
  check('日程 id 没有重复', new Set(eventIds).size === eventIds.length, eventIds.join(','));
  check('PLL 新增事件拿到了新 id', Boolean(pllEvent), String(pllEvent?.id));

  const shared = sessions.listSharedSessions(files.agent);
  const ids = shared.map((item) => item.id);
  check('PLL 写的会话 PHL 列得出来', ids.some((id) => id.startsWith('pll-')), ids.join(' | '));
  check('PHL 写的会话还在', ids.includes('phl-interop-1'), ids.join(' | '));

  const schoolDoc = school.readSchool(files.school).doc;
  check('PLL 写的邮箱摘要 PHL 读得到', Number(schoolDoc?.mail?.unread) === 3, JSON.stringify(schoolDoc?.mail?.unread));
  check('学校数据里的未知字段被 PLL 保留', schoolDoc?.future_field_school === 'keep-me', String(schoolDoc?.future_field_school));
  // PLL 是按天写课表的; 它写完一天之后, PHL 写的那天必须还在(不能被整段替换)。
  const edupageDays = new Set((schoolDoc?.edupage?.lessons || []).map((row) => row.date));
  check('PLL 按天写课表后 PHL 写的那天还在', edupageDays.has('2026-09-15'), `edupage 里的日期: ${[...edupageDays].join(' | ')}`);

  const timetableDoc = timetable.readTimetable(files.timetable);
  check('PLL 写的课表 PHL 读得到', Boolean(timetableDoc.days['2026-09-21']), Object.keys(timetableDoc.days).join(' | '));
  // readTimetable 只回报 days(不暴露原始文档), 未知字段直接看文件。
  const rawTimetable = JSON.parse(fs.readFileSync(files.timetable, 'utf8'));
  check('课表里的未知字段被 PLL 保留', rawTimetable.future_field_timetable === 'keep-me', String(rawTimetable.future_field_timetable));

  const text = settingsYaml.readTextFile(files.settings);
  const accountMap = settingsYaml.readNestedMap(text, 'accounts');
  const entries = sharedLessons.parseEntries(text);
  check('账号段落被 PLL 保留', accountMap?.edupage?.username === 'interop-user', JSON.stringify(accountMap?.edupage?.username));
  check('共用选课仍在', entries.length >= 7, `${entries.length} 条`);
  check('settings.yaml 的未知段落被 PLL 保留', text.includes('future_section'), text.includes('future_section') ? 'ok' : 'missing');
}

console.log(JSON.stringify(report, null, 2));
const failed = report.checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`互通自检失败 ${failed.length} 项：${failed.map((item) => item.name).join('、')}`);
  process.exit(1);
}
