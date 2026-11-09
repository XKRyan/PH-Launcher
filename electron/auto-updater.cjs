'use strict';
/**
 * 应用内更新（PHL）—— **静默检查、静默下载，用户决定何时安装**。
 *
 * 行为约定（2026-11-09 用户要求）：
 *   1. 每次启动后静默检查更新，发现新版本立即静默下载；检查/下载期间不弹任何
 *      通知、不显示进度，用户完全可以继续用软件。
 *   2. 启动时若已有更新（下载中/已下载/下载失败）就弹卡片；用户点「关于」→
 *      「检查更新」时也弹同一张卡片。
 *   3. 卡片上如实显示下载进度条：没下完显示百分比，下载完显示「重启并安装」，
 *      下载失败显示原因和「重试下载」。
 *   4. **安装永远由用户点卡片触发**：autoInstallOnAppQuit 保持 false，
 *      update-downloaded 事件本身绝不 quitAndInstall。
 *
 * Windows：electron-updater —— autoDownload=false（我们自己调 downloadUpdate），
 *   autoInstallOnAppQuit=false；下载缓存由 electron-updater 负责，下次启动会复用
 *   已下好的文件，不会重复下载。
 * macOS（未签名）：自研流程 —— 静默下载 zip → SHA256 校验 → 存到 userData 暂存；
 *   用户点「重启并安装」后才 ditto 解压 → 替换 .app → 清 quarantine → ad-hoc 重签 →
 *   open 重启。用户只需在新版本首次打开时右键 →「打开」一次。
 *
 * 更新源：清单由 phix-server 提供，载荷由官网托管。
 *   Windows: https://phix.ing/updates/phl/latest.yml（electron-updater 用）
 *   两端版本说明: https://phix.ing/api/v1/update/check?product=phl&platform=…
 */

const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const MAC_CHECK_URL = 'https://phix.ing/api/v1/update/check?product=phl&platform=mac';
const WIN_CHECK_URL = 'https://phix.ing/api/v1/update/check?product=phl&platform=win';
const DOWNLOAD_URL = 'https://phix.ing/download/';

/** 由 main.cjs 注入：读/写"跳过本版本"、给渲染层发消息、取窗口 */
let hooks = {
  getSkippedVersion: () => '',
  setSkippedVersion: () => {},
  sendToRenderer: () => {},
  getMainWindow: () => null,
  // 生产环境就是 process.platform；测试里可以注入 win32/darwin 分别验证两套流程。
  getPlatform: () => process.platform,
};

function platform() {
  try {
    return String(hooks.getPlatform() || process.platform);
  } catch {
    return process.platform;
  }
}

let skipAutoCheck = false;
/** 同一个 autoUpdater 事件处理器只挂一次（启动检查与手动检查共用，避免重复监听）。 */
let windowsArmed = false;
/** 正在进行的检查 / 下载（并发去重：启动检查还没结束时用户又点手动检查）。 */
let checkInFlight = null;
let downloadInFlight = null;
/** macOS 的更新条目（含下载 url / sha256），只在内存里用。 */
let pendingMacEntry = null;
/**
 * 当前更新状态。phase:
 *   idle → checking → available → downloading → downloaded → installing
 *   任意阶段下载出错 → error（可重试）
 */
let state = freshState();

function currentVersion() {
  try {
    return app.getVersion();
  } catch {
    return '';
  }
}

function freshState() {
  return {
    phase: 'idle',
    version: '',
    current: currentVersion(),
    notes: '',
    percent: 0,
    downloaded: false,
    error: '',
    checkedAt: '',
  };
}

function publicState() {
  return { ...state, current: currentVersion() };
}

function emitState() {
  try {
    hooks.sendToRenderer('app:update-state', publicState());
  } catch {
    /* 渲染层可能还没准备好；启动时它会用 app:update-pending 补拉 */
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  emitState();
}

function skippedVersion() {
  try {
    return String(hooks.getSkippedVersion() || '');
  } catch {
    return '';
  }
}

function isSkipped(version) {
  return Boolean(version) && skippedVersion() === String(version);
}

function shortNotes(text, limit = 400) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

function userAgent() {
  try {
    return `PH-Launcher-${currentVersion()}`;
  } catch {
    return 'PH-Launcher';
  }
}

// ---------------- 检查 ----------------

async function fetchCheck(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': userAgent() } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && data.ok ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只检查、不下载：返回 { status:'new', version, notes, macEntry } /
 * { status:'up-to-date' } / { status:'failed', error }。
 * 检查失败和"没有新版本"严格区分，手动检查时如实报给界面。
 */
async function probeWindows() {
  armWindowsUpdater();
  let info = null;
  try {
    const result = await autoUpdater.checkForUpdates();
    info = result?.updateInfo || null;
  } catch (error) {
    console.error('[auto-updater] check failed', error);
    return { status: 'failed', error: '检查失败，请稍后再试' };
  }
  if (!info) return { status: 'up-to-date' };
  if (!info.version) return { status: 'failed', error: '检查失败，请稍后再试' };
  if (String(info.version) === String(currentVersion())) return { status: 'up-to-date' };
  // 版本说明走接口（latest.yml 里没有 releaseNotes）；接口失败不影响更新本身。
  const data = await fetchCheck(WIN_CHECK_URL);
  return {
    status: 'new',
    version: String(info.version),
    notes: shortNotes(data?.release_notes),
    macEntry: null,
  };
}

async function probeMac() {
  const data = await fetchCheck(MAC_CHECK_URL);
  if (!data) return { status: 'failed', error: '检查失败，请稍后再试' };
  const latest = String(data.latest_version || '');
  if (!latest) return { status: 'failed', error: '检查失败，请稍后再试' };
  if (latest === String(currentVersion())) return { status: 'up-to-date' };
  return {
    status: 'new',
    version: latest,
    notes: shortNotes(data.release_notes),
    macEntry: data,
  };
}

// ---------------- Windows 下载 ----------------

/**
 * 给 electron-updater 挂事件处理器。下载进度只更新内部状态（渲染层只有卡片打开
 * 时才画进度条；没打开就没有任何界面变化）。
 * **只挂一次**：启动检查与手动检查共用同一套。
 */
function armWindowsUpdater() {
  if (windowsArmed) return;
  windowsArmed = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // QA/本地验收：用 dev-app-update.yml + 本地假更新源验证"静默下载/进度条"真实界面。
  // 只有显式设置环境变量才生效，正式安装包不受影响。
  if (!app.isPackaged && process.env.PHL_UPDATE_DEV_CONFIG === '1') {
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.on('download-progress', (p) => {
    if (!state.version) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
    state = { ...state, phase: 'downloading', percent: pct, downloaded: false, error: '' };
    emitState();
  });
  autoUpdater.on('update-downloaded', () => {
    if (!state.version) return;
    state = { ...state, phase: 'downloaded', percent: 100, downloaded: true, error: '' };
    emitState();
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err);
    if (!state.version) return;
    if (state.phase === 'downloading' || state.phase === 'available') {
      state = { ...state, phase: 'error', error: String(err?.message || err || '下载失败') };
      emitState();
    }
  });
}

/** 下载当前发现的更新。启动时自动调用；下载是静默的，不会弹通知或窗口。 */
function startSilentDownload() {
  if (!state.version || state.downloaded) return Promise.resolve(true);
  if (downloadInFlight) return downloadInFlight;
  setState({ phase: 'downloading', percent: 0, error: '' });

  downloadInFlight = (async () => {
    try {
      if (platform() === 'win32') {
        await autoUpdater.downloadUpdate();
        // 正常情况下 update-downloaded 事件已经置好；这里兜底（事件没触发时）。
        if (state.downloaded !== true) {
          state = { ...state, phase: 'downloaded', percent: 100, downloaded: true, error: '' };
          emitState();
        }
      } else if (platform() === 'darwin') {
        const ok = await prepareMacDownload(pendingMacEntry, state.version);
        if (!ok) throw new Error('下载失败，请稍后重试');
        // prepareMacDownload 内部已把状态置为 downloaded；这里再兜底一次。
        if (state.downloaded !== true) {
          state = { ...state, phase: 'downloaded', percent: 100, downloaded: true, error: '' };
          emitState();
        }
      } else {
        throw new Error('当前平台不支持自动下载');
      }
      return true;
    } catch (error) {
      if (state.version) {
        state = { ...state, phase: 'error', error: String(error?.message || error || '下载失败') };
        emitState();
      }
      return false;
    } finally {
      downloadInFlight = null;
    }
  })();
  return downloadInFlight;
}

// ---------------- 启动静默检查 / 手动检查 ----------------

/**
 * 启动后的静默检查：发现新版本 → 记状态 → 立刻静默下载。
 * 没有任何通知/卡片由这里弹出；渲染层收到状态后，只有"启动时发现更新"这一种
 * 情况会主动弹卡片（用户点了取消后不会再被进度事件重新弹出来）。
 */
function startSilentCheck() {
  if (skipAutoCheck) return Promise.resolve(null);
  if (checkInFlight) return checkInFlight;

  const task = (async () => {
    state = { ...freshState(), phase: 'checking' };
    let result;
    try {
      if (platform() === 'win32') result = await probeWindows();
      else if (platform() === 'darwin') result = await probeMac();
      else result = { status: 'unsupported' };
    } catch (error) {
      console.error('[auto-updater] probe failed', error);
      result = { status: 'failed', error: '检查失败，请稍后再试' };
    }

    if (result.status === 'new') {
      if (isSkipped(result.version)) {
        state = { ...freshState(), phase: 'idle' };
        return { ...result, status: 'skipped' };
      }
      pendingMacEntry = result.macEntry || null;
      state = {
        ...freshState(),
        phase: 'available',
        version: result.version,
        notes: result.notes || '',
        checkedAt: new Date().toISOString(),
      };
      emitState();
      // 静默下载：不 await、不弹任何东西；卡片会根据状态显示进度。
      void startSilentDownload();
    } else {
      state = { ...freshState(), phase: 'idle' };
    }
    return result;
  })();

  checkInFlight = task.finally(() => { checkInFlight = null; });
  return checkInFlight;
}

/**
 * 手动「检查更新」：**必定回一个明确结果**。
 *   · status:'new'        发现新版本（卡片同时会弹出；含当前下载状态/进度）
 *   · status:'up-to-date' 已是最新（或被跳过的版本）
 *   · status:'failed'     检查失败（离线 / 服务器异常）——绝不能报成已是最新
 * 已有更新在下载/已下载时不再重复联网检查，直接返回当前状态。
 */
async function manualCheck() {
  if (state.version && state.phase !== 'idle' && state.phase !== 'checking') {
    if (isSkipped(state.version)) {
      return { ok: true, status: 'up-to-date', current: currentVersion() };
    }
    if (state.phase === 'error') void startSilentDownload();
    return updateResult();
  }

  let result = null;
  if (checkInFlight) {
    result = await checkInFlight;
  } else {
    result = await startSilentCheck();
  }

  if (state.version && !isSkipped(state.version)) return updateResult();
  if (result?.status === 'up-to-date' || result?.status === 'skipped') {
    return { ok: true, status: 'up-to-date', current: currentVersion() };
  }
  return {
    ok: false,
    status: 'failed',
    error: result?.error || '检查失败，请稍后再试',
  };
}

function updateResult() {
  return {
    ok: true,
    status: 'new',
    version: state.version,
    current: currentVersion(),
    notes: state.notes,
    phase: state.phase,
    percent: state.percent,
    downloaded: state.downloaded,
    error: state.error,
  };
}

// ---------------- 用户在卡片上的选择 ----------------

/**
 * 'cancel' → 关掉卡片，继续用软件（后台下载继续，下次启动/手动检查仍会提示）
 * 'skip'   → 记住版本号，该版本不再提示（更高的版本仍会提示）
 * 'update' → 已下载：立即安装并重启；下载中：什么都不用做（进度条会继续走）；
 *            出错：重试下载
 */
async function handleUserChoice(choice) {
  if (choice === 'cancel') return { ok: true, action: 'cancel' };
  if (choice === 'skip') {
    const version = state.version || '';
    if (version) hooks.setSkippedVersion(version);
    pendingMacEntry = null;
    state = { ...freshState(), phase: 'idle' };
    emitState();
    return { ok: true, action: 'skip', version };
  }
  if (choice !== 'update') return { ok: false, action: 'unknown' };
  if (!state.version) return { ok: false, action: 'nothing-pending' };
  if (state.phase === 'installing') return { ok: true, action: 'installing' };

  if (state.downloaded) {
    setState({ phase: 'installing' });
    if (platform() === 'win32') {
      installWindowsUpdate();
      return { ok: true, action: 'install' };
    }
    if (platform() === 'darwin') {
      const ok = await installMacUpdate();
      if (!ok) {
        setState({ phase: 'error', error: '安装失败，请重新下载' });
        // 自动替换准备失败时给用户一个明确出口（开发模式/权限问题时尤其需要）。
        try {
          await shell.openExternal(DOWNLOAD_URL);
        } catch {
          /* ignore */
        }
        return { ok: false, action: 'install' };
      }
      return { ok: true, action: 'install' };
    }
    return { ok: false, action: 'unsupported-platform' };
  }

  if (state.phase === 'downloading' || downloadInFlight) {
    // 用户点得早了一点：下载已经自动开始了，卡片会继续显示进度。
    return { ok: true, action: 'downloading' };
  }

  void startSilentDownload();
  return { ok: true, action: 'download-started' };
}

/** Windows：下载完成后由用户点卡片触发安装（绝不自动安装）。 */
function installWindowsUpdate() {
  setTimeout(() => {
    try {
      // electron-updater 的签名是布尔参数：isSilent, isForceRunAfter。
      // 传对象会被当成 true，安装后可能不会自动重启，所以这里必须显式两个 true。
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      try {
        autoUpdater.quitAndInstall();
      } catch {
        setState({ phase: 'error', error: `安装失败：${String(error?.message || error)}` });
      }
    }
  }, 250);
}

// ---------------- macOS：静默下载 + 用户确认后替换 ----------------

function stagingDir() {
  return path.join(app.getPath('userData'), '.update-staging');
}

function stagingZipPath() {
  return path.join(stagingDir(), 'update.zip');
}

function stagingMetaPath() {
  return path.join(stagingDir(), 'meta.json');
}

function readStagingMeta() {
  try {
    return JSON.parse(fs.readFileSync(stagingMetaPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 静默下载 macOS 更新 zip（不安装）。下载到 userData/.update-staging/update.zip，
 * SHA256 校验通过后写 meta.json；下次启动发现同一版本会直接复用，不重复下载。
 */
async function prepareMacDownload(entry, latest) {
  const url = String(entry?.url || '');
  const sha = String(entry?.sha256 || '').toLowerCase();
  if (!url.endsWith('.zip') || !sha) return false;
  const appPath = currentAppBundle();
  if (!appPath) return false; // 开发模式（不在 .app 内）不下载替换包

  const staging = stagingDir();
  const zipPath = stagingZipPath();
  try {
    const meta = readStagingMeta();
    if (meta.version === latest && meta.sha256 === sha && fs.existsSync(zipPath)) {
      // 已经下过且版本/哈希对得上：直接复用（启动时无需再下载 240MB）。
      state = { ...state, phase: 'downloaded', percent: 100, downloaded: true, error: '' };
      emitState();
      return true;
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await downloadFile(url, zipPath, (percent) => {
      if (!state.version) return;
      state = { ...state, phase: 'downloading', percent, downloaded: false, error: '' };
      emitState();
    });
    if (sha256File(zipPath) !== sha) {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
    fs.writeFileSync(stagingMetaPath(), JSON.stringify({ version: latest, sha256: sha }), 'utf8');
    state = { ...state, phase: 'downloaded', percent: 100, downloaded: true, error: '' };
    emitState();
    return true;
  } catch (error) {
    console.error('[auto-updater] mac download failed', error);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 用户点「重启并安装」后：解压已下好的 zip → 替换 .app → 重启。 */
async function installMacUpdate() {
  const zipPath = stagingZipPath();
  const meta = readStagingMeta();
  if (!fs.existsSync(zipPath) || !meta.sha256) return false;
  if (String(meta.version) !== String(state.version)) return false;
  if (sha256File(zipPath) !== String(meta.sha256).toLowerCase()) return false;

  const appPath = currentAppBundle();
  if (!appPath) return false;
  const staging = stagingDir();
  const extractDir = path.join(staging, 'extract');
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    const newApp = findAppBundle(extractDir);
    if (!newApp) return false;
    writeAndLaunchSwapScript(appPath, newApp, staging, state.version);
    setTimeout(() => app.quit(), 800);
    return true;
  } catch (error) {
    console.error('[auto-updater] mac install failed', error);
    return false;
  }
}

/** 当前 .app 路径（从可执行文件上溯 Contents/MacOS/xxx → .app）。 */
function currentAppBundle() {
  try {
    let p = path.dirname(app.getPath('exe'));
    for (let i = 0; i < 3; i += 1) {
      if (p.endsWith('.app')) return p;
      p = path.dirname(p);
    }
  } catch {
    /* ignore */
  }
  return '';
}

function findAppBundle(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(cur, e.name);
      if (e.name.endsWith('.app')) return full;
      stack.push(full);
    }
  }
  return '';
}

function downloadFile(url, dest, onPercent) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const req = require('node:https').get(url, { headers: { 'User-Agent': userAgent() } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        downloadFile(res.headers.location, dest, onPercent).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let seen = 0;
      res.on('data', (chunk) => {
        seen += chunk.length;
        if (total && onPercent) onPercent(Math.round((seen / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
    });
    req.on('error', (e) => {
      try {
        file.close();
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      reject(e);
    });
    req.setTimeout(600000, () => req.destroy(new Error('download timeout')));
  });
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/**
 * 写替换脚本：等本进程退出 → 旧 .app 移进废纸篓 → 新 .app 就位 →
 * 清 quarantine → ad-hoc 重签 → open 重启。**只在用户点过「重启并安装」后才会走到这里。**
 */
function writeAndLaunchSwapScript(appPath, newApp, staging, latest) {
  const script = path.join(staging, 'swap.sh');
  const trashName = `${path.basename(appPath)}.old-${Date.now()}`;
  const trashDir = path.join(os.homedir(), '.Trash');
  const body = `#!/bin/bash
# PH Launcher 自动更新替换脚本（用户已确认更新后生成）
set -u
TARGET="${appPath}"
NEW="${newApp}"
STAGING="${staging}"
TRASH="${trashDir}/${trashName}"
PID="${process.pid}"
# VERSION="${latest}"

# 1) 等主进程退出（最多 60 秒）
for i in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done
sleep 1

# 2) 旧包移进废纸篓（不是直接删除：出问题用户可以捞回来）
if [ -d "$TARGET" ]; then
  mkdir -p "${trashDir}" 2>/dev/null || true
  mv "$TARGET" "$TRASH" 2>/dev/null || rm -rf "$TARGET"
fi

# 3) 新包就位
/usr/bin/ditto "$NEW" "$TARGET" || exit 1

# 4) 未签名应用的后续处理：清隔离属性 + ad-hoc 重签，避免"应用已损坏"
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
/usr/bin/codesign --sign - --deep --force "$TARGET" 2>/dev/null || true

# 5) 重启新版本
/usr/bin/open "$TARGET" 2>/dev/null || true

# 6) 清理暂存
rm -rf "$STAGING" 2>/dev/null || true
`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ---------------- 入口 ----------------

/**
 * 应用启动后调用一次（main.cjs 在窗口创建后触发）：静默检查 + 静默下载。
 * 不会弹通知；发现更新时只更新状态，渲染层据状态弹卡片并画进度。
 */
function initAutoUpdater(injected, options = {}) {
  if (injected) hooks = { ...hooks, ...injected };
  if (skipAutoCheck) return;
  if (options.schedule === false) return; // 测试里手动调用 startSilentCheck()
  const timer = setTimeout(() => { startSilentCheck().catch(() => {}); }, 3000);
  timer.unref?.();
}

// 测试时（self-test / smoke-test）跳过自动检查，避免网络请求干扰
function disableAutoUpdater() {
  skipAutoCheck = true;
}

/**
 * 渲染层启动时主动来拉一次当前更新状态（检查/下载比监听注册更早时补弹卡片）。
 * 没有更新、正在检查、已跳过都返回 null。
 */
function getPendingUpdate() {
  if (!state.version) return null;
  if (state.phase === 'idle' || state.phase === 'checking') return null;
  if (isSkipped(state.version)) return null;
  return publicState();
}

module.exports = {
  initAutoUpdater,
  disableAutoUpdater,
  handleUserChoice,
  getPendingUpdate,
  getUpdateState: publicState,
  manualCheck,
  startSilentCheck,
  getStatus: () => state.phase,
};
