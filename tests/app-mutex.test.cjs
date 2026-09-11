'use strict';
// 同系列互斥运行锁：PHL 与 PHL Lite 共享同一批文件，不能同时运行。
// "另一个实例"用真实的子进程模拟（存活 PID 才算数）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire, markerFresh, readMarker, release, touch } = require('../electron/app-mutex.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-app-mutex-'));
const children = [];
let counter = 0;

function freshDir() { const dir = path.join(temp, `case-${++counter}`); fs.mkdirSync(dir, { recursive: true }); return dir; }
function liveForeignMarker(dir, kind) {
  // 一个真实存活、但不是本进程的 PID（保持到用例结束）
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  fs.writeFileSync(path.join(dir, `.${kind}-running`), `${JSON.stringify({ kind, pid: child.pid })}\n`);
  return child;
}

test('第一个进程拿到标记；另一个同软件实例（不同 PID）被拒', () => {
  const dir = freshDir();
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  const marker = readMarker(dir, 'phl');
  assert.equal(marker.pid, process.pid);
  const foreign = liveForeignMarker(dir, 'phl');
  const second = acquire({ dataDir: dir, kind: 'phl' });
  assert.equal(second.ok, false);
  assert.equal(second.conflict, 'phl');
  assert.equal(second.name, 'PH Launcher');
  assert.equal(second.pid, foreign.pid);
});

test('同系列另一个软件在运行 → 冲突并报出对方名字', () => {
  const dir = freshDir();
  liveForeignMarker(dir, 'pll');
  const conflict = acquire({ dataDir: dir, kind: 'phl' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, 'pll');
  assert.equal(conflict.name, 'Pinghe Launcher Lite（PHL Lite）');
  // 反方向同样成立：PHL 在运行时 Lite 会被拒
  fs.rmSync(path.join(dir, '.pll-running'));
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  const liteMarker = liveForeignMarker(dir, 'phl');
  const liteConflict = acquire({ dataDir: dir, kind: 'pll' });
  assert.equal(liteConflict.ok, false);
  assert.equal(liteConflict.conflict, 'phl');
  assert.equal(liteConflict.pid, liteMarker.pid);
});

test('崩溃残留的死 PID 标记不会挡住下次启动', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, '.pll-running'), `${JSON.stringify({ kind: 'pll', pid: 999999 })}\n`);
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  fs.writeFileSync(path.join(dir, '.phl-running'), `${JSON.stringify({ kind: 'phl', pid: 999999 })}\n`);
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  assert.equal(readMarker(dir, 'phl').pid, process.pid, '过期标记被自己的标记覆盖');
});

test('release 只删自己的标记，且删除后可以再次获取', () => {
  const dir = freshDir();
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  assert.equal(release({ dataDir: dir, kind: 'phl' }), true);
  assert.equal(readMarker(dir, 'phl'), null);
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  release({ dataDir: dir, kind: 'phl' });
});

test('心跳过期的标记当作对方已不在（PID 被系统回收也不能挡住启动）', () => {
  const dir = freshDir();
  // 一个真实存活、心跳却很旧的标记：PID 可能是被回收给别的进程的，不能信。
  const child = liveForeignMarker(dir, 'pll');
  const markerFile = path.join(dir, '.pll-running');
  fs.writeFileSync(markerFile, `${JSON.stringify({ kind: 'pll', pid: child.pid, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })}\n`);
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });

  // 心跳是新的 → 仍然按"对方在运行"处理
  const other = freshDir();
  const fresh = liveForeignMarker(other, 'pll');
  fs.writeFileSync(path.join(other, '.pll-running'), `${JSON.stringify({ kind: 'pll', pid: fresh.pid, updatedAt: new Date().toISOString() })}\n`);
  assert.equal(acquire({ dataDir: other, kind: 'phl' }).ok, false);
});

test('旧版本写的标记没有时间戳 → 保守当作仍然有效', () => {
  const dir = freshDir();
  const child = liveForeignMarker(dir, 'pll');
  assert.equal(acquire({ dataDir: dir, kind: 'phl' }).ok, false);
  assert.equal(readMarker(dir, 'pll').updatedAt, '', '没有时间戳的标记原样读出');
  assert.equal(markerFresh({ updatedAt: '' }), true, '读不到时间就当心跳仍然有效');
  assert.equal(markerFresh({ updatedAt: 'not-a-date' }), true);
  assert.equal(markerFresh({ updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }), false);
  assert.equal(child.pid > 0, true);
});

test('touch 刷新自己的标记，不覆盖别人的标记', () => {
  const dir = freshDir();
  assert.deepEqual(acquire({ dataDir: dir, kind: 'phl' }), { ok: true });
  const first = readMarker(dir, 'phl').updatedAt;
  assert.equal(touch({ dataDir: dir, kind: 'phl', now: () => new Date(Date.now() + 60_000) }), true);
  assert.notEqual(readMarker(dir, 'phl').updatedAt, first, '心跳时间被刷新');
  // 标记换成别人的 → touch 不能抢
  fs.writeFileSync(path.join(dir, '.phl-running'), `${JSON.stringify({ kind: 'phl', pid: 999998 })}\n`);
  assert.equal(touch({ dataDir: dir, kind: 'phl' }), false);
  assert.equal(readMarker(dir, 'phl').pid, 999998, '别人的标记保持原样');
});

test.after(() => {
  for (const child of children) { try { child.kill(); } catch { /* no-op */ } }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ }
});
