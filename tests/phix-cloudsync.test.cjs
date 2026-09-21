'use strict';
// phix 云同步引擎（`electron/cloudsync.cjs`）：三方合并原语、对象映射、
// 禁止上云名单、快照与状态文件，以及一轮同步的推送/拉取/删除传播。
//
// 这里**不打网络**：用一个内存假客户端顶替服务端，专门盯合并规则本身
// （网络那一层由 D:\phix\server\devtools\test_sync_e2e.cjs 对着真服务端跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cs = require('../electron/cloudsync.cjs');

const DEK = Buffer.alloc(32, 9);

/** 内存版服务端：只保存密文 + revision，行为与协议 §4.4 的乐观锁一致。 */
class FakeServer {
  constructor() { this.server = 'http://fake'; this.store = new Map(); this.calls = []; }

  static conflict(current) {
    const error = new cs.PhixError('revision_conflict', '服务端说有人先写了', 409);
    error.payload = { current: { revision: current } };
    return error;
  }

  async manifest() {
    return { objects: [...this.store.entries()].map(([name, hit]) => ({ name, revision: hit.revision, deleted: Boolean(hit.deleted) })) };
  }

  async getObject(name) {
    const hit = this.store.get(name);
    if (!hit) return { name, revision: 0, payload: null };
    return { name, revision: hit.revision, payload: hit.payload, deleted: Boolean(hit.deleted) };
  }

  async putObject(name, baseRevision, payload) {
    const hit = this.store.get(name);
    const current = hit ? hit.revision : 0;
    this.calls.push(name);
    if (current !== Number(baseRevision)) throw FakeServer.conflict(current);
    const revision = current + 1;
    this.store.set(name, { revision, payload });
    return { name, revision, updated_at: cs.nowIso() };
  }
}

function makeRoot(settings = '', extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phix-cloudsync-'));
  if (settings) fs.writeFileSync(path.join(root, 'settings.yaml'), settings, 'utf8');
  for (const [name, doc] of Object.entries(extra)) cs.writeJson(path.join(root, name), doc);
  return root;
}

const engineFor = (server, root, tag = '设备A') => new cs.SyncEngine(server, DEK, 7, 'tester', { dataDir: root, device: tag });

// ---------------------------------------------------------------- 原语
test('文档哈希与 Python 侧一致：排序键 + 无空格 + 中文不转义', () => {
  assert.equal(cs.documentBytes({ b: 1, a: '中文' }).toString('utf8'), '{"a":"中文","b":1}');
  assert.equal(cs.hashDocument({ a: '中文', b: 1 }), cs.hashDocument({ b: 1, a: '中文' }));
  assert.equal(cs.hashDocument(null), '');
  assert.equal(cs.hashDocument(undefined), '');
  assert.match(cs.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('标量合并：只有一边改就用那一边，两边都改保留本地并报冲突', () => {
  const conflicts = [];
  assert.equal(cs.mergeScalar('b', 'b', 'r', 'x', conflicts), 'r');      // 只有远端改了
  assert.equal(cs.mergeScalar('b', 'l', 'b', 'x', conflicts), 'l');      // 只有本地改了
  assert.equal(cs.mergeScalar('b', 'l', 'r', 'x', conflicts), 'l');      // 两边都改 → 保留本地
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'x');
});

test('字典合并：逐叶子合并，删除跟着删，远端删除但本地改过就保留本地', () => {
  const base = { a: 1, b: { c: 1, d: 2 }, e: 5 };
  const local = { a: 1, b: { c: 1, d: 3 }, e: 5 };
  const remote = { a: 2, b: { c: 1, d: 9 }, e: 5 };
  const conflicts = [];
  const merged = cs.mergeDict(base, local, remote, 'root', conflicts);
  assert.equal(merged.a, 2, 'a 只有远端改了');
  assert.equal(merged.b.d, 3, 'd 两边都改了 → 保留本地');
  assert.equal(merged.e, 5);
  assert.equal(conflicts.length, 1);

  // 远端删除、本地没动 → 跟着删
  const dropped = cs.mergeDict({ gone: 1, keep: 2 }, { gone: 1, keep: 2 }, { keep: 2 }, 'r', []);
  assert.equal(Object.hasOwn(dropped, 'gone'), false);

  // 远端删除、本地改过 → 保留本地并报告
  const kept = cs.mergeDict({ gone: 1 }, { gone: 9 }, {}, 'r', []);
  assert.equal(kept.gone, 9);
});

test('日程合并：同一条只有一边改就用那一边，两边都改用 updated_at 较新的', () => {
  const base = { events: [{ id: 1, title: 'x', note: 'old', updated_at: '2026-01-01T00:00:00+08:00' }] };
  const local = { events: [{ id: 1, title: 'x', note: 'local', updated_at: '2026-01-02T00:00:00+08:00' }] };
  const remote = { events: [{ id: 1, title: 'x', note: 'remote', updated_at: '2026-01-03T00:00:00+08:00' }] };
  const [merged, conflicts] = engineFor(new FakeServer(), makeRoot()).merge('schedule', base, local, remote);
  assert.equal(merged.events[0].note, 'remote', '较新的那份胜出');
  assert.equal(conflicts.length, 1);
});

test('日程合并：跨设备各自新增撞了同一个 id → 两份都保留，远端那条改号', () => {
  const server = new FakeServer();
  const [merged, conflicts] = engineFor(server, makeRoot()).merge(
    'schedule',
    { events: [{ id: 1, title: '老' }], lastId: 1 },
    { events: [{ id: 1, title: '老' }, { id: 2, title: 'A 的', day: '2026-01-02' }], lastId: 2 },
    { events: [{ id: 1, title: '老' }, { id: 2, title: 'B 的', day: '2026-01-03' }], lastId: 2 },
  );
  const titles = merged.events.map((event) => event.title).sort();
  assert.deepEqual(titles, ['A 的', 'B 的', '老']);
  assert.equal(new Set(merged.events.map((event) => event.id)).size, 3, 'id 不重复');
  assert.ok(merged.events.find((event) => event.title === 'B 的').id > 2, '远端那条被改成了新号');
  assert.ok(conflicts.some((item) => String(item.note).startsWith('两台设备各自新增')));
  assert.ok(merged.lastId >= 3);
});

test('日程合并：lastId 取两边的最大值，事件按日期时间排序', () => {
  const [merged] = engineFor(new FakeServer(), makeRoot()).merge(
    'schedule',
    { events: [], lastId: 0 },
    { events: [{ id: 5, day: '2026-02-02', time: '09:00' }], lastId: 7 },
    { events: [{ id: 3, day: '2026-01-01', time: '08:00' }], lastId: 3 },
  );
  assert.equal(merged.lastId, 7);
  assert.deepEqual(merged.events.map((event) => event.id), [3, 5]);
});

test('日程合并：只在一边删掉的事件跟着删，改动过的留本地并报告', () => {
  const base = { events: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }], lastId: 2 };
  const local = { events: [{ id: 1, title: 'a' }], lastId: 2 };
  const remote = { events: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }], lastId: 2 };
  const [merged] = engineFor(new FakeServer(), makeRoot()).merge('schedule', base, local, remote);
  assert.deepEqual(merged.events.map((event) => event.id), [1], '本地删了、远端没动 → 跟着删');

  const localEdited = { events: [{ id: 1, title: 'a' }, { id: 2, title: 'b 改过' }], lastId: 2 };
  const remoteDeleted = { events: [{ id: 1, title: 'a' }], lastId: 2 };
  const [kept, conflicts] = engineFor(new FakeServer(), makeRoot())
    .merge('schedule', base, localEdited, remoteDeleted);
  assert.equal(kept.events.length, 2);
  assert.ok(conflicts.some((item) => item.note.includes('保留本地')));
});

test('课表合并：只取并集、永不删除、远端空的一天绝不清空本地', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  const local = { days: { '2026-09-07': [{ subject: '数学', start: '09:00', group: 'A' }] }, version: 1 };
  const remote = { days: { '2026-09-07': [] } };
  const [merged, conflicts] = engine.merge('timetable', {}, local, remote);
  assert.equal(merged.days['2026-09-07'].length, 1, '空的一天不许清空本地');
  assert.equal(conflicts.length, 0, '课表不报冲突');

  // 远端有本地没有的课卡 → 收下；本地有远端没有的 → 留着
  const [union] = engine.merge('timetable',
    { days: {} },
    { days: { '2026-09-07': [{ subject: '数学', start: '09:00', group: 'A' }] } },
    { days: { '2026-09-07': [{ subject: '物理', start: '10:00', group: 'B' }] } });
  assert.equal(union.days['2026-09-07'].length, 2);

  // 整份远端为空也不清空本地
  const [keepAll] = engine.merge('timetable', { days: { '2026-09-07': [{ subject: '数学' }] } },
    { days: { '2026-09-07': [{ subject: '数学', start: '09:00' }] } }, { days: {} });
  assert.equal(keepAll.days['2026-09-07'].length, 1);
  assert.equal(keepAll.kind, 'pinghe-timetable');
});

test('选课合并：按 (subject, group, teacher) 取并集，两边都改取较新的', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  const base = { lessons: [{ subject: 'TOK', group: 'F', teacher: 'Xu' }] };
  const local = { lessons: [{ subject: 'TOK', group: 'F', teacher: 'Xu' }, { subject: '数学', group: 'A', teacher: 'Yan' }] };
  const remote = { lessons: [{ subject: 'TOK', group: 'F', teacher: 'Xu' }, { subject: '物理', group: 'B', teacher: 'Jiang' }] };
  const [merged] = engine.merge('settings.lessons', base, local, remote);
  assert.deepEqual(merged.lessons.map((row) => row.subject).sort(), ['TOK', '数学', '物理']);
});

test('学校数据合并：复用 mergeManagebac / mergeEdupaged，空段不删数据', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  const local = {
    version: 1, kind: 'pinghe-school', app: 'PH Launcher', updated_at: 'x',
    managebac: { fetched_at: 'a', courses: [{ id: '1', name: '数学' }], tasks: [{ id: '11', title: '本地作业' }] },
    edupage: { week_start: '2026-09-07', fetched_at: 'a', lessons: [{ date: '2026-09-07', start: '09:00', subject: '数学', group: 'A' }] },
    mail: { fetched_at: '2026-09-01T00:00:00+08:00', unread: 1 },
  };
  const remote = {
    managebac: { fetched_at: 'b', courses: [{ id: '2', name: '物理' }], tasks: [{ id: '22', title: '远端作业' }] },
    edupage: { week_start: '2026-09-07', fetched_at: 'b', lessons: [] },
    mail: { fetched_at: '2026-09-05T00:00:00+08:00', unread: 9 },
  };
  const [merged] = engine.merge('school', { ...local }, local, remote);
  assert.deepEqual(merged.managebac.courses.map((course) => course.id).sort(), ['1', '2']);
  assert.deepEqual(merged.managebac.tasks.map((task) => task.id).sort(), ['11', '22']);
  assert.equal(merged.edupage.lessons.length, 1, '远端空的一周不许清掉本地课表');
  assert.equal(merged.mail.unread, 9, 'mail 段取 fetched_at 较新的');
  assert.equal(merged.kind, 'pinghe-school');
});

test('AI 会话合并：取 history 更长的一份，长度相同内容不同则保留本地并报告', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  const local = { id: 's1', title: 't', history: [{ role: 'user', content: 'hi' }] };
  const remote = { id: 's1', title: 't2', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  const [merged, conflicts] = engine.merge('agent:s1', null, local, remote);
  assert.equal(merged.history.length, 2);
  assert.equal(merged.title, 't2');
  assert.equal(conflicts.length, 0);

  const same = [{ role: 'user', content: 'hi' }];
  const [, reported] = engine.merge('agent:s2', null, { history: same }, { history: [{ role: 'user', content: 'yo' }] });
  assert.equal(reported.length, 1);
  assert.match(reported[0].note, /保留本地/);
});

test('未知对象走整体替换型三方合并', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  const [merged] = engine.merge('custom.thing', 'base', 'local', 'remote');
  assert.equal(merged, 'local');
});

// ---------------------------------------------------------------- 名单
test('禁止上云名单：既认对象名也认路径形态', () => {
  for (const bad of ['phll', 'phl', 'logs', '_backups', '_migrated_backup', '.sync', '.gh_token',
    '.phl-running', '.pll-running', 'phll/managebac/session_x.json', 'phl/profile/x', 'logs/app.log',
    '_backups/data-1.zip', '.sync/state.json', '', '   ']) {
    assert.equal(cs.SyncEngine.isForbidden(bad), true, bad);
  }
  for (const good of ['schedule', 'timetable', 'school', 'settings.accounts', 'settings.lessons',
    'settings.ui', 'settings.ai', 'agent:20260910-213045']) {
    assert.equal(cs.SyncEngine.isForbidden(good), false, good);
  }
});

// ---------------------------------------------------------------- 路径与状态文件
test('状态与快照按账号隔离：.sync/accounts/<账号>/{state.json,last/}', () => {
  const root = makeRoot();
  const engine = engineFor(new FakeServer(), root);
  assert.equal(engine.accountDir, path.join(root, '.sync', 'accounts', 'tester'));
  assert.equal(engine.statePath, path.join(root, '.sync', 'accounts', 'tester', 'state.json'));
  assert.equal(engine.snapshotDir, path.join(root, '.sync', 'accounts', 'tester', 'last'));
  engine.saveSnapshot('agent:2026-09-12', { history: [] });
  assert.deepEqual(fs.readdirSync(engine.snapshotDir), ['agent__2026-09-12.json']);

  // 目录名与 PLL 的 _account_dir() 逐字符一致（两边必须落到同一个目录）
  const cases = [
    ['someone', 'someone'],
    ['huaziqian25@shphschool.com', 'huaziqian25@shphschool.com'],
    ['a.b_c+d-e@f', 'a.b_c+d-e@f'],
    ['中文用户', '____'],
    ['空格 和/斜杠:冒号', '__________'],
    ['', 'default'],
    ['   ', '___'],
    ['emoji😀name', 'emoji_name'],
    ['x'.repeat(100), 'x'.repeat(60)],
    ['用户'.repeat(40), '_'.repeat(60)],
    ['a'.repeat(59) + '@with-some-tail', 'a'.repeat(59) + '@'],
    [null, 'default'],
    [undefined, 'default'],
    // 纯点串会原样变成目录名，然后被 path.join 解析到上一级 —— 必须挡住
    ['.', 'default'],
    ['..', 'default'],
    ['...', 'default'],
    ['....', 'default'],
    // 只含点加上别的字符就不算逃逸，照常保留
    ['.hidden', '.hidden'],
    ['..hidden', '..hidden'],
    ['. ', '._'],
    [' ..', '_..'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(cs.safeAccountName(input), expected, `safeAccountName(${JSON.stringify(input)})`);
  }

  // 账号名是纯点串时，目录必须仍在本账号目录之下，不能爬到 `.sync/` 上面去
  for (const name of ['.', '..', '...']) {
    const dotted = new cs.SyncEngine(new FakeServer(), root, 1, name, { dataDir: root });
    assert.equal(dotted.accountDir, path.join(root, '.sync', 'accounts', 'default'));
    assert.equal(path.dirname(dotted.accountDir), path.join(root, '.sync', 'accounts'));
  }
});

test('换账号不沿用别人的状态与快照（否则会把本地数据当"远端删除"）', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE, {
    Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: '本地日程' }], lastId: 1 },
  });
  const first = engineFor(server, root);
  await first.sync();
  assert.ok(fs.existsSync(path.join(root, '.sync', 'accounts', 'tester', 'state.json')));

  // 同一个 data/ 换成另一个 phix 账号：新账号连的是**另一个云端空间**
  const otherServer = new FakeServer();
  const other = new cs.SyncEngine(otherServer, DEK, 99, 'another-user', { dataDir: root, device: '设备B' });
  assert.equal(other.accountDir, path.join(root, '.sync', 'accounts', 'another-user'));
  assert.deepEqual(other.loadState(), {}, '新账号看不到旧账号的状态');
  assert.equal(other.loadSnapshot('schedule'), null, '新账号看不到旧账号的快照');

  // 新账号第一次同步只会"往上推"，绝不会把本地日程当"远端删除了"清掉
  const report = await other.sync();
  assert.equal(report.objects.schedule.action, 'push', cs.jsonText(report.objects.schedule));
  assert.equal(cs.readJson(path.join(root, 'Schedule'), {}).events.length, 1, '本地数据一条都不能少');
});

test('老布局的 .sync/state.json 只在属于当前账号时被复制过来，且原样保留', () => {
  const root = makeRoot();
  const legacyDir = path.join(root, '.sync');
  fs.mkdirSync(path.join(legacyDir, 'last'), { recursive: true });
  const legacyState = {
    version: 1, kind: 'phix-sync-state', server: 'http://x', username: 'tester',
    objects: { schedule: { revision: 4, sha256: 'deadbeef' } }, conflicts: [],
  };
  const legacyText = `${JSON.stringify(legacyState, null, 2)}\n`;
  fs.writeFileSync(path.join(legacyDir, 'state.json'), legacyText, 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'last', 'schedule.json'), '{"events":[]}\n', 'utf8');

  const engine = engineFor(new FakeServer(), root);
  const state = engine.loadState();
  assert.equal(state.objects.schedule.revision, 4, '老状态的 revision 被搬过来了');
  assert.equal(state.objects.schedule.sha256, '', '但老快照不被当成可信基版');
  assert.ok(fs.existsSync(engine.statePath));
  assert.equal(engine.loadSnapshot('schedule'), null, '没有可信 sha256 就不算基版');
  assert.equal(fs.readFileSync(path.join(legacyDir, 'state.json'), 'utf8'), legacyText, '老文件原样保留、绝不删');
  assert.equal(fs.existsSync(path.join(legacyDir, 'last', 'schedule.json')), true, '老快照也原样保留');

  // 别人的老状态：一个字都不动
  const otherRoot = makeRoot();
  fs.mkdirSync(path.join(otherRoot, '.sync'), { recursive: true });
  const foreignText = `${JSON.stringify({ ...legacyState, username: 'someone-else' }, null, 2)}\n`;
  fs.writeFileSync(path.join(otherRoot, '.sync', 'state.json'), foreignText, 'utf8');
  const other = engineFor(new FakeServer(), otherRoot);
  assert.deepEqual(other.loadState(), {}, '不属于当前账号的老状态不许搬');
  assert.equal(fs.existsSync(other.statePath), false);
  assert.equal(fs.readFileSync(path.join(otherRoot, '.sync', 'state.json'), 'utf8'), foreignText);

  // 老状态里 username 为空（更老的版本）→ 当作当前账号的
  const blankRoot = makeRoot();
  fs.mkdirSync(path.join(blankRoot, '.sync'), { recursive: true });
  fs.writeFileSync(path.join(blankRoot, '.sync', 'state.json'),
    `${JSON.stringify({ version: 1, objects: { school: { revision: 2 } } }, null, 2)}\n`, 'utf8');
  const blank = engineFor(new FakeServer(), blankRoot);
  assert.equal(blank.loadState().objects.school.revision, 2, '没有 username 的老状态当作当前账号的');
});

test('新位置已经有状态时不再搬老文件（幂等，且不覆盖）', () => {
  const root = makeRoot();
  const legacyDir = path.join(root, '.sync');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'state.json'),
    `${JSON.stringify({ version: 1, username: 'tester', objects: { schedule: { revision: 1 } } })}\n`, 'utf8');
  const engine = engineFor(new FakeServer(), root);
  engine.saveState({ objects: { schedule: { revision: 9 } } });
  const state = engine.loadState();
  assert.equal(state.objects.schedule.revision, 9, '优先用新位置那份');
});

test('状态文件带 kind/version 与 PLL 同构', () => {
  const root = makeRoot();
  const engine = engineFor(new FakeServer(), root);
  engine.saveState({ objects: {} });
  const state = cs.readJson(engine.statePath, {});
  assert.equal(state.kind, 'phix-sync-state');
  assert.equal(state.version, 1);
});

// ---------------------------------------------------------------- 没有基版快照时不许乱删
test('没有基版时合并只取并集，绝不把"本地没有"当成"本地删了"', () => {
  const five = [1, 2, 3, 4, 5].map((id) => ({ id, title: `事件${id}` }));
  const one = [{ id: 9, title: '新的' }];
  const ids = (result) => result.events.map((event) => event.id);

  // base = null（本地根本没有这一轮的基版）→ 并集
  assert.deepEqual(ids(cs.mergeEvents(null, one, five, 10, [])).sort((a, b) => a - b), [1, 2, 3, 4, 5, 9]);
  assert.deepEqual(ids(cs.mergeEvents(null, [{ id: 1, title: '事件1' }], five, 10, [])), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(cs.mergeEvents(null, [], five, 10, [])), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(cs.mergeEvents(null, five, [], 10, [])), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(cs.mergeEvents(undefined, one, five, 10, [])).sort((a, b) => a - b), [1, 2, 3, 4, 5, 9]);

  // 有基版时"本地删了"仍然成立（不能因为怕丢数据就永不传播删除）
  assert.deepEqual(ids(cs.mergeEvents(five, [{ id: 1, title: '事件1' }], [{ id: 1, title: '事件1' }], 10, [])), [1]);
});

test('引擎：本地文件只包含一部分事件时不会把远端那些删掉', async () => {
  const server = new FakeServer();
  const rootA = makeRoot('', { Schedule: { version: 1, kind: 'pinghe-schedule', events: [1, 2, 3, 4, 5].map((id) => ({ id, title: `事件${id}` })), lastId: 5 } });
  const ea = engineFor(server, rootA, 'A');
  await ea.sync();
  const cloudRevision = cs.readJson(ea.statePath, {}).objects.schedule.revision;

  // 另一台设备：只把 A 的状态与快照摆成"老布局"，本地文件却只有 1 条
  const rootB = makeRoot('', { Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: '事件1' }], lastId: 1 } });
  const legacyDir = path.join(rootB, '.sync');
  fs.mkdirSync(path.join(legacyDir, 'last'), { recursive: true });
  const legacy = JSON.parse(fs.readFileSync(path.join(rootA, '.sync', 'accounts', 'tester', 'state.json'), 'utf8'));
  legacy.device = 'B';
  fs.writeFileSync(path.join(legacyDir, 'state.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  fs.copyFileSync(path.join(rootA, '.sync', 'accounts', 'tester', 'last', 'schedule.json'),
    path.join(legacyDir, 'last', 'schedule.json'));

  const eb = engineFor(server, rootB, 'B');
  const report = await eb.sync();
  assert.equal(cs.readJson(path.join(rootB, 'Schedule'), {}).events.length, 5, '一条都不能少');
  assert.notEqual(report.objects.schedule.action, 'push', '更不允许把"少掉的那些"当删除推回云端');
  // 云端也没被改坏：A 再同步一次仍然是它自己的 5 条
  await ea.sync();
  assert.equal(cs.readJson(path.join(rootA, 'Schedule'), {}).events.length, 5);
  assert.equal(cs.readJson(ea.statePath, {}).objects.schedule.revision, cloudRevision);
});

test('第一次同步（没有基版）：空的那边让步，云端配置不被本机的空值抹掉', async () => {
  // 复刻 PLL 侧的场景：A 配好一个服务商推上云；B 是一台还没配过的新设备（空列表）。
  // 2026-09-13 起 settings.ai 的同步载荷是**规范形态**
  // （{providers:[{name,protocol,base_url,model,api_key}], default_index}），
  // 与网页端 / PLL 读写同一个对象。
  const server = new FakeServer();
  const rootA = makeRoot('', { 'settings.yaml': '' });
  fs.writeFileSync(path.join(rootA, 'settings.yaml'), [
    'version: 1',
    'ai:',
    '  providers:',
    '    - name: DeepSeek',
    '      protocol: openai',
    '      base_url: https://api.deepseek.com/v1',
    '      model: model-from-A',
    '      api_key: sk-fake-A',
    '  default_index: 0',
    '',
  ].join('\n'), 'utf8');
  const engineA = engineFor(server, rootA, 'A');
  await engineA.sync({ names: ['settings.ai'] });
  assert.equal(engineA.collect('settings.ai').ai.providers[0].model, 'model-from-A');
  assert.equal(engineA.collect('settings.ai').ai.providers[0].api_key, 'sk-fake-A');

  const rootB = makeRoot('');
  fs.writeFileSync(path.join(rootB, 'settings.yaml'), 'version: 1\nai:\n  providers: []\n', 'utf8');
  const engineB = engineFor(server, rootB, 'B');
  const report = await engineB.sync({ names: ['settings.ai'] });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(engineB.collect('settings.ai').ai.providers[0].model, 'model-from-A', '空值不许把云端配置抹掉');

  // A 再同步一次也不能被 B 的空值覆盖
  await engineA.sync({ names: ['settings.ai'] });
  assert.equal(engineA.collect('settings.ai').ai.providers[0].model, 'model-from-A');
  // 状态文件必须能落盘（哨兵一旦泄漏到这里就 TypeError）
  assert.ok(cs.readJson(engineB.statePath, {}).objects['settings.ai']);
});

test('没有基版时两边都有值且不同 → 保留本地并报冲突（不静默丢）', () => {
  const conflicts = [];
  assert.equal(cs.mergeScalar(undefined, 'a', 'b', 'ai.active_model', conflicts), 'a');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].base, null);
  assert.match(conflicts[0].note, /没有基版/);
  // 空对象 / 空数组也算"没值"，照样让位
  assert.deepEqual(cs.mergeScalar(undefined, {}, { a: 1 }, 'x', []), { a: 1 });
  assert.deepEqual(cs.mergeScalar(undefined, [], [1], 'x', []), [1]);
  // 数字 0 不算空（与 PLL 的 _is_empty 一致）
  assert.equal(cs.mergeScalar(undefined, 0, 5, 'x', []), 0);
});

test('首拉全是 noop 也必须把基线记下来，否则云端删除永远传播不过来', async () => {
  // 两台设备的本地数据**完全一样**：B 首拉时每个对象都是 noop。
  const server = new FakeServer();
  const fixture = { Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: 'a' }], lastId: 1 } };
  const rootA = makeRoot('', fixture);
  const rootB = makeRoot('', fixture);
  const ea = engineFor(server, rootA, 'A');
  await ea.sync();

  const eb = engineFor(server, rootB, 'B');
  const first = await eb.sync();
  assert.ok(['noop'].includes(first.objects.schedule.action), cs.jsonText(first.objects.schedule));
  const entry = cs.readJson(eb.statePath, {}).objects.schedule;
  assert.ok(entry, 'noop 也必须写出 state 条目');
  assert.ok(entry.sha256, `基线哈希必须记下来：${cs.jsonText(entry)}`);
  assert.equal(entry.revision, first.objects.schedule.revision ?? entry.revision);

  // 有基线之后：对端删掉共用大文件 → 本地保留并报一次（而不是被当成"本地改过"）
  server.store.set('schedule', { revision: 99, payload: null, deleted: true });
  const afterDelete = await eb.sync({ names: ['schedule'] });
  assert.equal(afterDelete.objects.schedule.action, 'kept-local', cs.jsonText(afterDelete.objects.schedule));
  assert.match(afterDelete.conflicts[0].note, /共用的大文件/);
  // 而且不能每轮都重报（收敛）
  const settled = await eb.sync({ names: ['schedule'] });
  assert.equal(settled.objects.schedule.action, 'noop');
  assert.equal(settled.conflicts.length, 0);

  // 可安全删除的对象则是真的跟着删
  const rootC = makeRoot('', fixture);
  const ec = engineFor(server, rootC, 'C');
  await ec.sync();
  fs.mkdirSync(path.join(rootC, 'agent'), { recursive: true });
  cs.writeJson(path.join(rootC, 'agent', 's9.json'), { id: 's9', history: [{ role: 'user', content: 'x' }] });
  await ec.sync({ names: ['agent:s9'] });
  server.store.set('agent:s9', { revision: 42, payload: null, deleted: true });
  const removed = await ec.sync({ names: ['agent:s9'] });
  assert.equal(removed.objects['agent:s9'].action, 'pull-delete');
  assert.equal(fs.existsSync(path.join(rootC, 'agent', 's9.json')), false);
});

test('快照内容与 state 里的 sha256 对不上时不算基版（防止拿别人的明文乱删）', async () => {
  const server = new FakeServer();
  const root = makeRoot('', { Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: 'a' }], lastId: 1 } });
  const engine = engineFor(server, root);
  await engine.sync();
  assert.ok(engine.loadSnapshot('schedule'), '自家快照认得出');

  // 有人改写了快照文件（或迁移过来一份不属于本轮的）→ 不再当基版
  cs.writeJson(engine._snapshotPath('schedule'), { version: 1, kind: 'pinghe-schedule', events: [], lastId: 0 });
  assert.equal(engine.loadSnapshot('schedule'), null);
  // 快照文件被删掉也一样
  await engine.sync();
  fs.rmSync(engine._snapshotPath('schedule'), { force: true });
  assert.equal(engine.loadSnapshot('schedule'), null);
});

test('saveState 会把冲突记录归一成可 JSON 序列化的形式（哨兵不许写进去）', () => {
  const engine = engineFor(new FakeServer(), makeRoot());
  // 走真实的合并路径：**没有基版 + 两边都有值**这条分支，是 Python 侧整轮崩过的那条
  const conflicts = [];
  assert.equal(cs.mergeScalar(undefined, 'local', 'remote', 'ai.active_model', conflicts), 'local');
  assert.equal(conflicts[0].base, null, '缺省的 base 写成 null，不是哨兵');

  // 再塞几条真的不可序列化的值，确认 saveState 兜住了
  conflicts.push({ path: 'x', local: undefined, remote: () => {}, base: 10n });
  conflicts.push({ path: 'y', local: { nested: [undefined, () => {}] }, remote: 1, base: 2 });
  engine.saveState({ objects: {}, conflicts });
  const saved = cs.readJson(engine.statePath, {});
  assert.equal(saved.conflicts.length, 3, '一条都不能因为写不进去而丢');
  assert.equal(saved.conflicts[0].base, null);
  assert.equal(saved.conflicts[0].local, 'local');
  assert.equal(saved.conflicts[1].local, null);
  assert.equal(typeof saved.conflicts[1].remote, 'string', '函数归一成字符串');
  assert.equal(saved.conflicts[1].base, 10, 'bigint 归一成数字');
  assert.equal(Array.isArray(saved.conflicts[2].local.nested), true);
  assert.equal(saved.conflicts[2].local.nested[0], null);
  assert.equal(typeof saved.conflicts[2].local.nested[1], 'string');
  // 直接盯 jsonSafe 本身
  assert.equal(cs.jsonSafe(undefined), null);
  assert.equal(cs.jsonSafe(10n), 10);
  assert.equal(typeof cs.jsonSafe(() => {}), 'string');
  assert.deepEqual(cs.jsonSafe([1, undefined]), [1, null]);
  assert.deepEqual(cs.jsonSafe({ a: undefined, b: 1 }), { a: null, b: 1 });
});

// ---------------------------------------------------------------- 一轮同步
const SETTINGS_FIXTURE = [
  '# 用户注释，同步不许动它',
  'version: 1',
  'accounts:',
  '  edupage:',
  '    username: someone@example.com',
  '    password: pw1',
  'lessons:',
  '- subject: TOK',
  '  teacher: Jiabin Xu',
  "  group: 'F'",
  'agent:',
  '  mode: confirm',
  '  workspaces: []',
  'ui:',
  '  course_order: []',
  'future_section:',
  '  nested:',
  '    key: keep-me',
  '',
].join('\n');

test('第一次同步把本地对象推上云，第二次没有变化（收敛），禁止名单里的名字不处理', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE, {
    Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: 'a' }], lastId: 1 },
    Timetable: { version: 1, kind: 'pinghe-timetable', days: { '2026-09-07': [{ subject: '数学', start: '09:00' }] } },
  });
  const engine = engineFor(server, root);

  const first = await engine.sync();
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.ok(first.objects['settings.accounts'].action === 'push');
  assert.ok(first.objects['settings.lessons'].action === 'push');
  assert.ok(first.objects.schedule.action === 'push');
  assert.ok(first.objects.timetable.action === 'push');
  assert.equal(first.objects.school.action, 'skip', '本地没有 School 文件');

  const second = await engine.sync();
  assert.deepEqual(second.pushed, [], '第二轮不该再推');
  assert.deepEqual(second.pulled, [], '第二轮不该再拉');
  for (const entry of Object.values(second.objects)) {
    assert.ok(['noop', 'skip'].includes(entry.action), JSON.stringify(entry));
  }

  // 名单里的对象名直接 skip，不报错也不上传
  const guarded = await engine.sync({ names: ['phll/managebac/session_x.json', 'logs/app.log'] });
  assert.equal(guarded.objects['phll/managebac/session_x.json'].action, 'skip');
  assert.equal(guarded.errors.length, 0);
  assert.equal(server.store.has('phll/managebac/session_x.json'), false);
});

test('同步写回后重新读盘再记快照，所以不会每轮都以为有变化', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE);
  const engine = engineFor(server, root);
  await engine.sync();

  // 模拟"另一台设备加了选课"：另一份本地目录改完推上去，本机再拉一次
  const other = engineFor(server, makeRoot(SETTINGS_FIXTURE), '设备B');
  await other.sync();
  const lessons = other.collect('settings.lessons');
  lessons.lessons.push({ subject: '物理', teacher: 'Jiang', group: 'B' });
  other.apply('settings.lessons', lessons);
  await other.sync();

  const before = engine.collect('settings.lessons').lessons.length;
  await engine.sync();
  assert.equal(engine.collect('settings.lessons').lessons.length, before + 1);
  const again = await engine.sync();
  assert.equal(again.objects['settings.lessons'].action, 'noop', '拉完之后必须收敛');
});

test('写回共用 settings.yaml 时保留注释、别的段与未知字段', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE);
  const engine = engineFor(server, root);
  await engine.sync();
  const other = engineFor(server, makeRoot(SETTINGS_FIXTURE), '设备B');
  const ui = other.collect('settings.ui');
  ui.ui = { course_order: ['Physics HL1', 'TOK'] };
  other.apply('settings.ui', ui);
  await other.sync();
  await engine.sync();

  const text = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  assert.ok(text.startsWith('# 用户注释，同步不许动它\n'));
  assert.match(text, /future_section:\n {2}nested:\n {4}key: keep-me/);
  assert.ok(text.includes('send_grades_to_llm') === false, '这个 fixture 里没有 agent.send_grades_to_llm');
  assert.match(text, /^agent:\n {2}mode: confirm/m);
  assert.match(text, /^version: 1$/m);
  assert.equal(engine.collect('settings.ui').ui.course_order.length, 2);
});

test('云端墓碑：能安全删的（AI 会话）跟着删，共用大文件一律保留并报告', async () => {
  // ① AI 会话是"安全可删"的 → 本地文件跟着删
  const server = new FakeServer();
  const root = makeRoot('');
  fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
  cs.writeJson(path.join(root, 'agent', 's1.json'), { id: 's1', title: 't', history: [{ role: 'user', content: 'hi' }] });
  const engine = engineFor(server, root);
  await engine.sync();
  assert.ok(fs.existsSync(path.join(root, 'agent', 's1.json')));

  server.store.set('agent:s1', { revision: 99, payload: null, deleted: true });
  const deleted = await engine.sync();
  assert.equal(deleted.objects['agent:s1'].action, 'pull-delete');
  assert.equal(fs.existsSync(path.join(root, 'agent', 's1.json')), false, '本地没改过 → 跟着删');
  assert.equal(cs.readJson(engine.statePath, {}).objects['agent:s1'].revision, 99);
  assert.equal(fs.existsSync(path.join(engine.snapshotDir, 'agent__s1.json')), false, '快照也要清掉');
  // 不再反复报
  const again = await engine.sync({ names: ['agent:s1'] });
  assert.ok(['noop', 'skip', 'remote-deleted'].includes(again.objects['agent:s1'].action),
    cs.jsonText(again.objects['agent:s1']));

  // ② 共用大文件（Schedule/Timetable/School）**不自动删**，保留本地并报一次，然后收敛
  const server2 = new FakeServer();
  const root2 = makeRoot('', { Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: 'a' }], lastId: 1 } });
  const engine2 = engineFor(server2, root2);
  await engine2.sync();
  server2.store.set('schedule', { revision: 99, payload: null, deleted: true });
  const kept = await engine2.sync();
  assert.equal(kept.objects.schedule.action, 'kept-local');
  assert.match(kept.conflicts[0].note, /共用的大文件/);
  assert.equal(cs.readJson(path.join(root2, 'Schedule'), {}).events.length, 1, '共用大文件不许被删');
  const settled = await engine2.sync();
  assert.equal(settled.objects.schedule.action, 'noop', '第二轮不再重复报同一条');
  assert.equal(settled.conflicts.length, 0);

  // ③ 本地改过 → 保留本地并**推回云端**，等于否决这次删除（否则两边永远吵）
  const server3 = new FakeServer();
  const root3 = makeRoot('', { Schedule: { version: 1, kind: 'pinghe-schedule', events: [{ id: 1, title: 'a' }], lastId: 1 } });
  const engine3 = engineFor(server3, root3);
  await engine3.sync();
  const edited = cs.readJson(path.join(root3, 'Schedule'), {});
  edited.events.push({ id: 2, title: '本地改的' });
  edited.lastId = 2;
  cs.writeJson(path.join(root3, 'Schedule'), edited);
  server3.store.set('schedule', { revision: 99, payload: null, deleted: true });
  const veto = await engine3.sync();
  assert.equal(veto.objects.schedule.action, 'push');
  assert.match(veto.conflicts[0].note, /推回云端/);
  assert.equal(cs.readJson(path.join(root3, 'Schedule'), {}).events.length, 2);
  assert.equal(Number(cs.readJson(engine3.statePath, {}).objects.schedule.revision), 100, '推回后 revision 前进');
});

test('dryRun 只算不写：不推进状态、不改本地文件', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE, { Schedule: { version: 1, kind: 'pinghe-schedule', events: [], lastId: 0 } });
  const engine = engineFor(server, root);
  await engine.sync();
  const stateBefore = fs.readFileSync(engine.statePath, 'utf8');
  const scheduleBefore = fs.readFileSync(path.join(root, 'Schedule'), 'utf8');

  const doc = cs.readJson(path.join(root, 'Schedule'), {});
  doc.events.push({ id: 1, title: '新加的' });
  doc.lastId = 1;
  cs.writeJson(path.join(root, 'Schedule'), doc);

  const dry = await engine.sync({ dryRun: true });
  assert.equal(dry.objects.schedule.action, 'push');
  assert.equal(fs.readFileSync(engine.statePath, 'utf8'), stateBefore, '预览不写状态');
  const dryFile = cs.readJson(path.join(root, 'Schedule'), {});
  assert.equal(dryFile.events.length, 1);
  assert.notEqual(fs.readFileSync(path.join(root, 'Schedule'), 'utf8'), scheduleBefore);
});

test('对方程序在跑就跳过这轮，force 才继续；死标记不算', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE);
  const engine = engineFor(server, root);

  const markerFile = path.join(root, '.pll-running');
  fs.writeFileSync(markerFile, JSON.stringify({ kind: 'pll', pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), 'utf8');
  const skipped = await engine.sync();
  assert.equal(skipped.ok, false);
  assert.match(skipped.skipped, /正在运行/);

  const forced = await engine.sync({ force: true });
  assert.equal(forced.skipped, null);
  assert.equal(forced.ok, true);

  fs.writeFileSync(markerFile, JSON.stringify({ kind: 'pll', pid: 999999, startedAt: '2020-01-01T00:00:00+08:00', updatedAt: '2020-01-01T00:00:00+08:00' }), 'utf8');
  const stale = await engine.sync();
  assert.equal(stale.skipped, null, '死进程 / 心跳过期的标记不算在运行');
});

test('云端存的是密文：换了对象名或换了 DEK 都解不开', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE);
  const engine = engineFor(server, root);
  await engine.sync();

  const stored = server.store.get('settings.lessons');
  assert.match(stored.payload, /^PHIX1\./);
  const plain = cs.jsonText(engine.collect('settings.lessons'));
  assert.equal(stored.payload.includes(plain.slice(8, 24)), false);

  // AAD 绑了对象名与 user_id：换名字、换用户、换 DEK 都解不开
  const { unsealObject } = require('../electron/phix-crypto.cjs');
  assert.throws(() => unsealObject(DEK, 7, 'timetable', stored.payload));
  assert.throws(() => unsealObject(DEK, 8, 'settings.lessons', stored.payload));
  assert.throws(() => unsealObject(Buffer.alloc(32, 1), 7, 'settings.lessons', stored.payload));
});

test('单个对象出错不会拖垮整轮同步', async () => {
  const server = new FakeServer();
  const root = makeRoot(SETTINGS_FIXTURE);
  const engine = engineFor(server, root);
  await engine.sync();
  // 让 timetable 的远端密文坏掉
  server.store.set('timetable', { revision: 1, payload: 'PHIX1.bogus.bogus' });
  const report = await engine.sync();
  assert.equal(report.objects.timetable.action, 'error');
  assert.match(String(report.objects.timetable.error), /解不开远端密文/);
  assert.equal(report.objects['settings.lessons'].action, 'noop', '别的对象照常处理');
  assert.equal(report.ok, false);
});

test('409 冲突时重新拉取再合并一次（乐观锁重试）', async () => {
  const server = new FakeServer();
  const rootA = makeRoot(SETTINGS_FIXTURE);
  const rootB = makeRoot(SETTINGS_FIXTURE);
  const ea = engineFor(server, rootA, 'A');
  const eb = engineFor(server, rootB, 'B');
  await ea.sync();
  await eb.sync();

  // 两边各自改选课，A 先推
  for (const [engine, subject] of [[ea, 'A 加的课'], [eb, 'B 加的课']]) {
    const doc = engine.collect('settings.lessons');
    doc.lessons.push({ subject, teacher: 'T', group: 'G' });
    engine.apply('settings.lessons', doc);
  }
  await ea.sync();
  const report = await eb.sync();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const subjects = eb.collect('settings.lessons').lessons.map((row) => row.subject);
  assert.ok(subjects.includes('A 加的课') && subjects.includes('B 加的课'), JSON.stringify(subjects));
});

test('collect/apply 覆盖全部对象名，agent:<id> 一个会话一个对象', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
  cs.writeJson(path.join(root, 'agent', 's1.json'), { id: 's1', title: 't', history: [{ role: 'user', content: 'hi' }] });
  cs.writeJson(path.join(root, 'agent', 's2.json'), { id: 's2', title: 't', history: [] });
  const engine = engineFor(new FakeServer(), root);
  const names = engine.allObjectNames();
  assert.deepEqual(names.slice(0, cs.DEFAULT_OBJECTS.length), [...cs.DEFAULT_OBJECTS]);
  assert.deepEqual(names.slice(cs.DEFAULT_OBJECTS.length), ['agent:s1', 'agent:s2']);
  assert.equal(engine.collect('agent:s1').history.length, 1);
  assert.equal(engine.collect('agent:missing'), null);

  engine.apply('agent:s3', { id: 's3', history: [{ role: 'user', content: 'x' }] });
  assert.equal(cs.readJson(path.join(root, 'agent', 's3.json'), {}).id, 's3');
});

test('课表写回不走 writeDoc：不偷偷改 updated_at / app', async () => {
  const server = new FakeServer();
  const root = makeRoot('', {
    Timetable: { version: 1, kind: 'pinghe-timetable', app: 'Pinghe Launcher Lite', updated_at: '2026-01-01T00:00:00+08:00', days: { '2026-09-07': [{ subject: '数学', start: '09:00' }] } },
  });
  const engine = engineFor(server, root);
  await engine.sync();
  const other = engineFor(server, makeRoot(''), 'B');
  await other.sync();
  const before = cs.readJson(path.join(root, 'Timetable'), {});
  await engine.sync();
  const after = cs.readJson(path.join(root, 'Timetable'), {});
  assert.equal(after.updated_at, before.updated_at, 'updated_at 不该被同步改写');
  assert.equal(after.app, before.app, 'app 不该被同步改写');
});
