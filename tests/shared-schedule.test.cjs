'use strict';
// electron/shared-schedule.cjs 的契约测试: PHL ↔ PLL 共用 data/Schedule 文件的读写规则。
// 规范见 Lite 仓库根 DATA-FORMAT.md §3; 全部用例在临时目录里进行, 结束后统一清理。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SCHEDULE_KIND, SCHEDULE_VERSION, emptySchedule, readSchedule, upsertEvents, removeEvents,
  localIso, parseOffset, toLauncherEvents, fromLauncherEvents, sameSharedEvent,
} = require('../electron/shared-schedule.cjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-schedule-'));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

let fileSequence = 0;
function freshFile() { return path.join(tempDir, `Schedule-${fileSequence += 1}`); }

// 固定时刻(带 +08:00 偏移), 断言只依赖函数自身的换算, 不依赖测试机的时区。
const NOW = new Date('2026-09-10T21:30:00+08:00');
const LATER = new Date('2026-09-10T22:45:00+08:00');

test('1. 缺失的文件读到可直接使用的空文档, 且不会在磁盘上创建任何文件', () => {
  const file = freshFile();
  const result = readSchedule(file, { now: NOW });
  assert.equal(result.exists, false);
  assert.equal(result.repaired, false);
  assert.equal(result.doc.version, SCHEDULE_VERSION);
  assert.equal(result.doc.kind, SCHEDULE_KIND);
  assert.equal(result.doc.app, 'PH Launcher');
  assert.deepEqual(result.doc.events, []);
  assert.notEqual(parseOffset(result.doc.updated_at), null);
  assert.equal(fs.existsSync(file), false);
  // 空操作写入同样不创建文件
  const noop = upsertEvents(file, [], { now: NOW });
  assert.deepEqual([noop.added, noop.updated, noop.unchanged], [0, 0, 0]);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(emptySchedule(NOW).events, []);
});

test('2. 损坏/截断/不合规的文件按空文档读取并标记 repaired, 文件保持逐字节原样', () => {
  const truncated = freshFile();
  fs.writeFileSync(truncated, '{"version": 1, "kind": "pinghe-schedu', 'utf8');
  const before = fs.readFileSync(truncated);
  const result = readSchedule(truncated, { now: NOW });
  assert.equal(result.exists, true);
  assert.equal(result.repaired, true);
  assert.equal(result.doc.kind, SCHEDULE_KIND);
  assert.deepEqual(result.doc.events, []);
  assert.deepEqual(fs.readFileSync(truncated), before);
  assert.doesNotThrow(() => readSchedule(truncated));

  const blank = freshFile();
  fs.writeFileSync(blank, '', 'utf8');
  const blankResult = readSchedule(blank, { now: NOW });
  assert.equal(blankResult.exists, true);
  assert.equal(blankResult.repaired, true);
  assert.deepEqual(blankResult.doc.events, []);

  // 字段类型不对(version/kind/events)同样按不可用处理, 读取路径不改写文件
  const messy = freshFile();
  const messyText = '{"version": "1", "kind": "别的", "events": {"a": 1}}';
  fs.writeFileSync(messy, messyText, 'utf8');
  const messyResult = readSchedule(messy, { now: NOW });
  assert.equal(messyResult.repaired, true);
  assert.equal(messyResult.doc.version, SCHEDULE_VERSION);
  assert.equal(messyResult.doc.kind, SCHEDULE_KIND);
  assert.deepEqual(messyResult.doc.events, []);
  assert.equal(fs.readFileSync(messy, 'utf8'), messyText);

  // 事件数组里合法的留下, 不合法的剔除并标记 repaired
  const partial = freshFile();
  fs.writeFileSync(partial, JSON.stringify({
    version: 1,
    kind: SCHEDULE_KIND,
    events: [
      { id: 1, day: '2026-09-12', time: '15:00', title: '好的' },
      { id: 2, day: '2026-13-01', time: '15:00', title: '坏日期' },
    ],
  }), 'utf8');
  const partialResult = readSchedule(partial, { now: NOW });
  assert.equal(partialResult.repaired, true);
  assert.deepEqual(partialResult.doc.events.map((event) => event.id), [1]);
});

test('3. id 从 1 起并从当前最大值继续, 删除后不复用; updated_at 只在变化时刷新', () => {
  const file = freshFile();
  const first = upsertEvents(file, [{ day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }], { now: NOW });
  assert.deepEqual([first.added, first.updated, first.unchanged], [1, 0, 0]);
  assert.deepEqual(first.doc.events.map((event) => event.id), [1]);

  const second = upsertEvents(file, [
    { day: '2026-09-13', time: '', title: '全天事项' },
    { day: '2026-09-14', time: '08:30', title: '早读' },
  ], { now: LATER });
  assert.deepEqual(second.doc.events.map((event) => event.id), [1, 2, 3]);
  assert.equal(second.doc.updated_at, localIso(LATER)); // 有变化 → 刷新

  const repeat = upsertEvents(file, [{ day: '2026-09-13', time: '', title: '全天事项' }], { now: NOW });
  assert.deepEqual([repeat.added, repeat.updated, repeat.unchanged], [0, 0, 1]);
  const reread = readSchedule(file);
  assert.equal(reread.doc.updated_at, localIso(LATER)); // 无变化 → 不刷新
  assert.deepEqual(reread.doc.events.map((event) => event.id), [1, 2, 3]);

  const removed = removeEvents(file, [3, 999], { now: NOW }); // 999 不存在, 忽略
  assert.deepEqual(removed.removed, [3]);
  assert.deepEqual(readSchedule(file).doc.events.map((event) => event.id), [1, 2]);

  const again = upsertEvents(file, [{ day: '2026-09-15', time: '10:00', title: '新事项' }], { now: NOW });
  assert.equal(again.added, 1);
  assert.deepEqual(again.doc.events.map((event) => event.id), [1, 2, 4]); // 不复用已删除的 3
});

test('4. matchId 原地更新并保留 id 与 created, 完全相同的条目记为 unchanged 而不重复添加', () => {
  const file = freshFile();
  const added = upsertEvents(file, [{ day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' }], { now: NOW });
  const id = added.doc.events[0].id;
  const updated = upsertEvents(file, [{ matchId: id, day: '2026-09-13', time: '16:30', title: '打球改期', note: '带水' }], { now: LATER });
  assert.deepEqual([updated.added, updated.updated, updated.unchanged], [0, 1, 0]);
  const [event] = updated.doc.events;
  assert.equal(event.id, id);
  assert.equal(event.created, added.doc.events[0].created);
  assert.deepEqual({ day: event.day, time: event.time, title: event.title, note: event.note },
    { day: '2026-09-13', time: '16:30', title: '打球改期', note: '带水' });

  const dupe = upsertEvents(file, [{ day: '2026-09-13', time: '16:30', title: '打球改期', note: '带水' }], { now: NOW });
  assert.deepEqual([dupe.added, dupe.updated, dupe.unchanged], [0, 0, 1]);
  assert.equal(dupe.doc.events.length, 1);

  assert.equal(sameSharedEvent(event, { day: '2026-09-13', time: '16:30', title: '打球改期', note: '带水' }), true);
  assert.equal(sameSharedEvent(event, { ...event, time: '16:31' }), false);
  assert.equal(sameSharedEvent({ day: '2026-09-13', time: '16:30', title: 'x' }, { day: '2026-09-13', time: '16:30', title: 'x', note: undefined }), true);
});

test('5. toLauncherEvents: 定时事件起止差一小时, 全天事件带 allDay, 无效条目被跳过', () => {
  const doc = {
    version: SCHEDULE_VERSION,
    kind: SCHEDULE_KIND,
    app: '测试',
    updated_at: localIso(NOW),
    events: [
      { id: 1, day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' },
      { id: 2, day: '2026-09-13', time: '', title: '全天事项', note: '' },
      { id: 3, day: '2026-09-15', time: '23:30', title: '晚自习', note: '' },
      { id: 4, day: '2026-9-12', time: '15:00', title: '日期无效' },
      { id: 5, day: '2026-02-30', time: '10:00', title: '不存在的日子' },
      { id: 6, day: '2026-09-16', time: '15:00', title: '   ' },
      { id: 7, day: '2026-09-17', time: '7:30', title: '时间无效' },
    ],
  };
  assert.deepEqual(toLauncherEvents(doc), [
    { sharedId: '1', date: '2026-09-12', start: '15:00', end: '16:00', title: '打球', notes: '带球拍' },
    { sharedId: '2', date: '2026-09-13', start: '', end: '', title: '全天事项', notes: '', allDay: true },
    { sharedId: '3', date: '2026-09-15', start: '23:30', end: '23:59', title: '晚自习', notes: '' },
  ]);
  // 23:00 之后开始的小时长事项至少保留 15 分钟
  assert.deepEqual(
    toLauncherEvents({ events: [{ id: 8, day: '2026-09-12', time: '23:10', title: '深夜', note: '' }] }, { durationMinutes: 5 }),
    [{ sharedId: '8', date: '2026-09-12', start: '23:10', end: '23:25', title: '深夜', notes: '' }],
  );
  assert.deepEqual(toLauncherEvents(null), []);
  assert.deepEqual(toLauncherEvents({}), []);
});

test('6. fromLauncherEvents 跳过每周重复与无日期事件, 全天转空时间, 简单事件可往返', () => {
  const launcherEvents = fromLauncherEvents([
    { id: 'weekly', title: '每周例会', date: '2026-09-12', start: '09:00', end: '10:00', notes: '', repeatWeekdays: [1, 3] },
    { id: 'nodate', title: '没有日期', start: '09:00', end: '10:00', notes: '' },
    { id: 'allday', title: '全天事项', date: '2026-09-13', start: '', end: '', notes: '休息' },
    { id: 'simple', title: '打球', date: '2026-09-12', start: '15:00', end: '16:00', notes: '带球拍' },
    { id: 'long', title: `标题${'很'.repeat(130)}`, date: '2026-09-14', start: '', end: '', notes: '备'.repeat(401) },
  ]);
  assert.deepEqual(fromLauncherEvents('不是数组'), []);
  assert.equal(launcherEvents.length, 3);
  assert.deepEqual(
    launcherEvents.find((item) => item.time === ''),
    { launcherId: 'allday', day: '2026-09-13', time: '', title: '全天事项', note: '休息' },
  );
  const simple = launcherEvents.find((item) => item.launcherId === 'simple');
  assert.deepEqual(simple, { launcherId: 'simple', day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' });
  const long = launcherEvents.find((item) => item.launcherId === 'long');
  assert.equal(long.title.length, 120);
  assert.equal(long.note.length, 400);

  // 往返: fromLauncherEvents → upsertEvents → toLauncherEvents, 标题/日期/时间保持不变
  const file = freshFile();
  upsertEvents(file, [{ day: simple.day, time: simple.time, title: simple.title, note: simple.note }], { now: NOW });
  const mapped = toLauncherEvents(readSchedule(file).doc);
  assert.deepEqual(
    mapped.map(({ date, start, title }) => ({ date, start, title })),
    [{ date: '2026-09-12', start: '15:00', title: '打球' }],
  );
  // launcherId 不是共享文件的数字 id 时, 内容相同的条目按 unchanged 处理, 不会重复添加
  const repeat = upsertEvents(file, [{ matchId: simple.launcherId, day: simple.day, time: simple.time, title: simple.title, note: simple.note }], { now: LATER });
  assert.deepEqual([repeat.added, repeat.updated, repeat.unchanged], [0, 0, 1]);
  assert.equal(readSchedule(file).doc.events.length, 1);
});

test('7. 时间戳带本地数字时区偏移且永不以 Z 结尾; localIso 与 parseOffset 互逆', () => {
  const file = freshFile();
  const result = upsertEvents(file, [{ day: '2026-09-12', time: '15:00', title: '打球' }], { now: NOW });
  const stamps = [result.doc.updated_at, result.doc.events[0].created, emptySchedule(NOW).updated_at];
  for (const stamp of stamps) {
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, stamp);
    assert.notEqual(parseOffset(stamp), null, stamp);
    assert.doesNotMatch(stamp, /Z$/, stamp);
  }
  for (const minutes of [0, 45, 480, -300, 330, 840, -840]) {
    assert.equal(parseOffset(localIso(NOW, minutes)), minutes, String(minutes));
  }
  assert.ok(localIso(NOW, 0).endsWith('+00:00'));
  assert.equal(localIso(NOW, 480).slice(-6), '+08:00');
  assert.equal(localIso(NOW, -300).slice(-6), '-05:00');
  assert.equal(parseOffset('2026-09-10T21:30:00Z'), null);
  assert.equal(parseOffset('2026-09-10T21:30:00'), null);
  assert.equal(parseOffset('不是时间戳'), null);
  assert.equal(parseOffset(localIso(NOW)), -NOW.getTimezoneOffset()); // 缺省用本机偏移
});

test('8. 写入原子落地: 无临时文件残留, UTF-8 无 BOM, 仅 \\n 换行, 重读内容一致', () => {
  const file = freshFile();
  const first = upsertEvents(file, [
    { day: '2026-09-12', time: '15:00', title: '打球', note: '带球拍' },
    { day: '2026-09-13', time: '', title: '全天事项' },
  ], { now: NOW });
  const leftovers = fs.readdirSync(tempDir).filter((name) => !/^Schedule-\d+$/.test(name));
  assert.deepEqual(leftovers, []);

  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff); // 无 BOM
  assert.ok(!text.includes('\r')); // 仅 \n
  const parsed = JSON.parse(text); // 合法 UTF-8 JSON
  assert.equal(parsed.kind, SCHEDULE_KIND);
  assert.equal(parsed.events.length, 2);

  const second = readSchedule(file, { now: NOW });
  assert.equal(second.exists, true);
  assert.equal(second.repaired, false);
  assert.deepEqual(second.doc.events, first.doc.events);
});

test('9. 并发: 写入前检测到他人修改则重做一次读-改-写, 对方的改动被合并保留', () => {
  const file = freshFile();
  upsertEvents(file, [{ day: '2026-09-12', time: '15:00', title: '已有事项' }], { now: NOW });

  const realStat = fs.statSync;
  let hookActive = false;
  let statCalls = 0;
  fs.statSync = (...args) => {
    // 模拟"另一个应用在我读取之后、写入之前修改了文件": 在第 3 次 stat(写入前那次)前注入
    if (hookActive && String(args[0]) === file && (statCalls += 1) === 3) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = doc.events.reduce((max, event) => Math.max(max, event.id), 0) + 100;
      doc.events.push({ id, day: '2026-09-20', time: '12:00', title: `对方写入${id}`, note: '' });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    }
    return realStat(...args);
  };
  let result;
  try {
    hookActive = true;
    result = upsertEvents(file, [{ day: '2026-09-21', time: '09:00', title: '我方新增' }], { now: LATER });
  } finally {
    hookActive = false;
    fs.statSync = realStat;
  }
  assert.equal(result.contended, undefined); // 重做一次后干净写入
  assert.equal(result.added, 1);
  assert.deepEqual(result.doc.events.map((event) => event.id), [1, 101, 102]);
  assert.ok(result.doc.events.some((event) => event.title === '对方写入101'));
  assert.ok(result.doc.events.some((event) => event.title === '我方新增'));
  assert.deepEqual(readSchedule(file).doc.events, result.doc.events);
});

test('10. 并发: 每一轮都撞车时按最后写入者胜出落盘, 并标记 contended: true', () => {
  const file = freshFile();
  upsertEvents(file, [{ day: '2026-09-12', time: '15:00', title: '已有事项' }], { now: NOW });

  const realStat = fs.statSync;
  let hookActive = false;
  let statCalls = 0;
  fs.statSync = (...args) => {
    // 每一轮读-改-写的写入前一次 stat 都注入一次外部修改, 逼出"照写 + contended"分支
    if (hookActive && String(args[0]) === file && (statCalls += 1) % 3 === 0) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = doc.events.reduce((max, event) => Math.max(max, event.id), 0) + 100;
      doc.events.push({ id, day: '2026-09-20', time: '12:00', title: `对方写入${id}`, note: '' });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    }
    return realStat(...args);
  };
  let result;
  try {
    hookActive = true;
    result = upsertEvents(file, [{ day: '2026-09-21', time: '09:00', title: '我方新增' }], { now: LATER });
  } finally {
    hookActive = false;
    fs.statSync = realStat;
  }
  assert.equal(result.contended, true);
  assert.equal(result.added, 1);
  const finalDoc = readSchedule(file).doc;
  assert.ok(finalDoc.events.some((event) => event.title === '我方新增')); // 我方写入最终落地
  assert.ok(finalDoc.events.some((event) => event.title.startsWith('对方写入'))); // 上一轮注入被合并
});
