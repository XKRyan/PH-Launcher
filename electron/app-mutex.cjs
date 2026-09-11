'use strict';
// PH Launcher and Pinghe Launcher Lite must not run at the same time against the
// same data folder (they share settings.yaml / Schedule / agent/). Each app
// writes one PID marker into the shared data root and checks the other's:
//   * same app already running → the caller shows "already running" and exits
//     (for the common case the existing single-instance lock focuses the window)
//   * the sibling app running → the caller shows a conflict message and exits
// A stale marker (crash / power loss) is detected by PID liveness, so a dead
// process never blocks the next launch.
const fs = require('node:fs');
const path = require('node:path');

const MARKERS = Object.freeze({ phl: '.phl-running', pll: '.pll-running' });
const APP_NAMES = Object.freeze({ phl: 'PH Launcher', pll: 'Pinghe Launcher Lite（PHL Lite）' });
const HEARTBEAT_MS = 30000;
const HEARTBEAT_STALE_MS = 90000;

function markerPath(dataDir, kind) {
  const marker = MARKERS[kind];
  if (!marker) throw new Error('未知的运行锁类型');
  return path.join(dataDir, marker);
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // 存在但无权限 = 活着
  }
}

function readMarker(dataDir, kind) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(dataDir, kind), 'utf8'));
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: String(parsed.startedAt || ''), updatedAt: String(parsed.updatedAt || parsed.startedAt || ''), kind: parsed.kind === 'pll' ? 'pll' : 'phl' };
  } catch {
    return null;
  }
}

/**
 * 运行标记是不是"还在跳"的心跳：每 HEARTBEAT_MS 刷新一次，超过
 * HEARTBEAT_STALE_MS 没动静就当对方已经不在（崩溃、被强杀、断电）。
 * 只看 PID 不够：PID 会被系统回收给别人，那样会误判成"对方在运行"而打不开程序。
 * 旧版本写的标记没有时间戳，只能当作仍然有效（保守，不改变升级前的行为）。
 */
function markerFresh(marker, now = Date.now()) {
  const stamp = String(marker?.updatedAt || '');
  if (!stamp) return true;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return true;
  return now - at < HEARTBEAT_STALE_MS;
}

function writeMarker(dataDir, kind, now) {
  const temporary = `${markerPath(dataDir, kind)}.tmp`;
  const stamp = now().toISOString();
  fs.writeFileSync(temporary, `${JSON.stringify({ kind, pid: process.pid, startedAt: stamp, updatedAt: stamp })}\n`, 'utf8');
  fs.renameSync(temporary, markerPath(dataDir, kind));
}

/**
 * Acquires this app's run marker and reports conflicts.
 * @returns {{ ok: true } | { ok: false, conflict: 'phl' | 'pll', pid: number, name: string }}
 */
function acquire({ dataDir, kind, now = () => new Date() } = {}) {
  if (!MARKERS[kind]) throw new Error('未知的运行锁类型');
  fs.mkdirSync(dataDir, { recursive: true });
  // 对面软件在运行 → 弹提示并不启动（两个程序共享同一批文件，同时写会互相覆盖）。
  const sibling = kind === 'phl' ? 'pll' : 'phl';
  const siblingMarker = readMarker(dataDir, sibling);
  if (siblingMarker && pidAlive(siblingMarker.pid) && markerFresh(siblingMarker, now().getTime())) {
    return { ok: false, conflict: sibling, pid: siblingMarker.pid, name: APP_NAMES[sibling] };
  }
  // 同类软件在另一个用户数据目录里运行 → 同样不能共享这份文件。
  const own = readMarker(dataDir, kind);
  if (own && own.pid !== process.pid && pidAlive(own.pid) && markerFresh(own, now().getTime())) {
    return { ok: false, conflict: kind, pid: own.pid, name: APP_NAMES[kind] };
  }
  writeMarker(dataDir, kind, now);
  return { ok: true };
}

/** 刷新自己的心跳；标记已被别人接管时不动它。 */
function touch({ dataDir, kind, now = () => new Date() } = {}) {
  try {
    const marker = readMarker(dataDir, kind);
    if (marker && marker.pid !== process.pid) return false;
    writeMarker(dataDir, kind, now);
    return true;
  } catch {
    return false;
  }
}

/** Removes this app's marker; only our own PID is ever deleted. */
function release({ dataDir, kind } = {}) {
  try {
    const marker = readMarker(dataDir, kind);
    if (marker && marker.pid !== process.pid) return false;
    fs.rmSync(markerPath(dataDir, kind), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { APP_NAMES, HEARTBEAT_MS, HEARTBEAT_STALE_MS, MARKERS, acquire, markerFresh, pidAlive, readMarker, release, touch };
