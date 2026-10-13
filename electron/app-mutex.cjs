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
    // 时间戳**两种拼法都要认**：本应用写 camelCase（startedAt/updatedAt），
    // Pinghe Launcher Lite 写 snake_case（started_at/updated_at）。
    // 只认自己那一种的后果是**跨程序的心跳过期判定等于关掉** —— 读不到对方的时间戳，
    // markerFresh 就按"当作仍然有效"处理，冲突只剩"PID 还活着吗"一条判据；
    // 而 PID 一旦被系统回收给别人，就会误判成"对方正在运行"、程序打不开，
    // 用户只能手动去删标记文件。这正是 markerFresh 注释里说要防的那件事
    // （2026-10-12 实测确认过：两边互相读不到时间戳）。
    const updated = parsed.updatedAt || parsed.updated_at
      || parsed.startedAt || parsed.started_at || '';
    const started = parsed.startedAt || parsed.started_at || '';
    return { pid, startedAt: String(started), updatedAt: String(updated),
             kind: parsed.kind === 'pll' ? 'pll' : 'phl' };
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
  // **两种拼法都写**（camelCase + snake_case）：对方是 Python 那份实现，历史上只读
  // snake_case；而已经装在用户机器上的旧版本也只会读自己那一种。两种都写上，
  // 新旧版本互相都读得到心跳（见 readMarker 的注释）。
  fs.writeFileSync(temporary, `${JSON.stringify({
    kind, pid: process.pid,
    startedAt: stamp, updatedAt: stamp,
    started_at: stamp, updated_at: stamp,
  })}\n`, 'utf8');
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
