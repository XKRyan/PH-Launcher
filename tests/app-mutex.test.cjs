'use strict';
// 同系列互斥运行锁：PHL 与 PHL Lite 共享同一批文件，不能同时运行。
// "另一个实例"用真实的子进程模拟（存活 PID 才算数）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire, readMarker, release } = require('../electron/app-mutex.cjs');

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

test.after(() => {
  for (const child of children) { try { child.kill(); } catch { /* no-op */ } }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ }
});
