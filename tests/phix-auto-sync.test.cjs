'use strict';
// phix 云同步的「一秒一轮变更探测」（用户 2026-09-19：
// 「每次产生选课，账号，日程等的更改都和服务器同步一次，服务器端产生更改也同步，
// 用轮询的方法，一秒一次，但是不要让用户察觉」）。
//
// 这一层只做**判断**：本地指纹变了就推、云端清单变了就拉、都没变就什么都不做。
// 完整同步本身（三方合并）在 cloudsync 的测试里管，这里只钉住"什么时候该动"。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const phixSession = require('../electron/phix-session.cjs');
const cloudsync = require('../electron/cloudsync.cjs');

const DEK = Buffer.alloc(32, 7);

/** 一个只记「谁问过我什么」的假客户端 + 一个自己的数据目录。 */
function harness({ manifestObjects = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phix-poll-'));
  const calls = { manifest: 0, syncs: [] };
  phixSession.configure({ dataDir: root });
  const session = new phixSession.PhixSession({ log: () => {} });
  session.stopped = true;
  session.client = { manifest: async () => { calls.manifest += 1; return { objects: manifestObjects }; } };
  session.dek = DEK;
  session.userId = 7;
  session.username = 'tester';
  // 只测判断逻辑：把"真同步"换成一个记录器。
  session.sync = async () => { calls.syncs.push(Date.now()); return { ok: true }; };
  return { session, calls, root };
}

test('本地没动、云端也没动 → 一轮轮询只问一次清单，什么都不写', async () => {
  const { session, calls } = harness({ manifestObjects: [{ name: 'settings.accounts', revision: 1 }] });
  session.localSignature = '';
  session.manifestSignature = 'settings.accounts@1';
  session.lastFullSyncAt = Date.now();
  // 让"本地指纹"稳定：先跑一轮把指纹记下来
  await session.pollOnce();
  calls.syncs.length = 0;
  const verdict = await session.pollOnce();
  assert.equal(verdict, 'none');
  assert.equal(calls.syncs.length, 0, '没变化就不该动');
  assert.ok(calls.manifest >= 1, '只问清单（最轻的那个接口）');
});

test('本地改了选课/账号（settings.yaml 变了）→ 立刻同步一次', async () => {
  const { session, calls, root } = harness();
  session.localSignature = 'stale';
  session.manifestSignature = '';
  session.lastFullSyncAt = Date.now();
  fs.writeFileSync(path.join(root, 'settings.yaml'), 'accounts:\n  edupage:\n    username: student\n', 'utf8');
  const verdict = await session.pollOnce();
  assert.equal(verdict, 'local');
  assert.equal(calls.syncs.length, 1, '本地一改就推一轮');
});

test('本地改了日程（Schedule 变了）也会同步', async () => {
  const { session, calls, root } = harness();
  session.localSignature = 'stale';
  session.lastFullSyncAt = Date.now();
  fs.writeFileSync(path.join(root, 'Schedule'), JSON.stringify({ events: [] }), 'utf8');
  assert.equal(await session.pollOnce(), 'local');
  assert.equal(calls.syncs.length, 1);
});

test('云端 revision 变了 → 拉一轮（服务器端改动也要同步）', async () => {
  const { session, calls } = harness({ manifestObjects: [{ name: 'settings.lessons', revision: 9 }] });
  session.localSignature = '';
  session.manifestSignature = 'settings.lessons@8';   // 上次看到的是 8
  session.lastFullSyncAt = Date.now();
  const verdict = await session.pollOnce();
  assert.equal(verdict, 'remote');
  assert.equal(calls.syncs.length, 1);
  assert.equal(session.manifestSignature, 'settings.lessons@9', '记住新的清单指纹');
});

test('到了兜底间隔（sync_interval_minutes）无论如何完整同步一次', async () => {
  const { session, calls } = harness({ manifestObjects: [{ name: 'settings.ui', revision: 1 }] });
  session.localSignature = '';
  session.manifestSignature = 'settings.ui@1';
  session.lastFullSyncAt = Date.now() - 60 * 60 * 1000;  // 一小时前
  const verdict = await session.pollOnce();
  assert.equal(verdict, 'due');
  assert.equal(calls.syncs.length, 1);
});

test('没登录（没有 client / dek）时轮询不做事', async () => {
  const { session, calls } = harness();
  session.client = null;
  assert.equal(await session.pollOnce(), 'idle');
  assert.equal(calls.manifest, 0);
});

test('一秒一次：startAutoSync 用的是 1000ms 的轮询间隔', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/phix-session.cjs'), 'utf8');
  assert.match(source, /const AUTO_POLL_MS = 1000/);
  assert.match(source, /this\.#schedule\(AUTO_POLL_MS\)/);
  assert.equal(phixSession.AUTO_POLL_MS, 1000);
});

test('被同步的本地文件就是用户说的那几样：账号/选课/日程/课表/学校/头像', () => {
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('settings.accounts'), '账号');
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('settings.lessons'), '选课');
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('schedule'), '日程');
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('timetable'), '课表');
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('school'), '学校数据');
});
