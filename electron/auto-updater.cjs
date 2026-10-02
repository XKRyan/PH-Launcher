'use strict';
/**
 * 应用内更新（PHL）—— **只检查、只提示，绝不自动更新**。
 *
 * 统一交互（与心履 Android 端一致）：进入软件后检查一次；发现新版本就弹卡片，
 * 卡片上写版本号 + 本次更新内容 + 三个按钮：
 *   · 取消        这次先不选，继续用软件（下次启动还会提示）
 *   · 跳过本版本  记住这个版本号，之后不再提示（**更高的版本仍会提示**）
 *   · 更新        这时才下载并安装
 *
 * Windows：用 electron-updater，但把它的自动下载与自动安装都关掉
 *   （autoDownload=false、autoInstallOnAppQuit=false），改为用户确认后
 *   才 downloadUpdate() → quitAndInstall()。
 * macOS（未签名）：自研流程 —— 用户确认后下载 zip → SHA256 校验 → ditto 解压 →
 *   退出后替换 .app → 清 com.apple.quarantine → codesign ad-hoc 重签 → open 重启。
 *   用户只需在新版本首次打开时右键 →「打开」一次。
 *
 * 更新源：清单由 phix-server 提供，载荷由官网托管。
 *   Windows: https://phix.ing/updates/phl/latest.yml（electron-updater 用）
 *   两端版本说明: https://phix.ing/api/v1/update/check?product=phl&platform=…
 */

const { app, shell, Notification } = require('electron');
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
};

let skipAutoCheck = false;
/** 当前待用户决定的新版本：{ version, notes, macEntry } */
let pendingUpdate = null;
/** 'idle' | 'checking' | 'waiting-user' | 'downloading' | 'applying' | 'error' */
let phase = 'idle';

function userAgent() {
  try {
    return `PH-Launcher-${app.getVersion()}`;
  } catch {
    return 'PH-Launcher';
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch {
    /* 通知失败不影响流程 */
  }
}

function progress(stage, extra = {}) {
  phase = stage;
  try {
    hooks.sendToRenderer('app:update-progress', { stage, ...extra });
  } catch {
    /* 渲染层可能还没准备好 */
  }
}

/**
 * 把"发现新版本"告诉渲染层（由它弹卡片）。
 * 同时记进 pendingUpdate —— 渲染层要是还没注册好监听（IPC 消息会丢），
 * 它启动后可以调 getPendingUpdate() 把这条取走。
 */
function askUser(version, notes) {
  phase = 'waiting-user';
  pendingUpdate = { ...(pendingUpdate || {}), version, notes };
  try {
    hooks.sendToRenderer('app:update-available', {
      version,
      current: app.getVersion(),
      notes: notes || '',
    });
  } catch {
    /* 窗口没准备好就等下次启动再提示 */
  }
}

function shortNotes(text, limit = 400) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

/**
 * 还没被用户处理的那条更新（渲染层启动时主动来拉一次）。
 *
 * 为什么要"拉"：更新检查是并发的，很可能在渲染层注册好
 * `app:update-available` 监听之前就把消息发过去了 —— IPC 发出去没人接就没了，
 * 卡片永远不弹。渲染层启动时调这个把待办取走，就不用赌时序。
 * 用户已经选过（cancel 会保持 waiting-user，skip/update 会离开）时按状态返回。
 */
function getPendingUpdate() {
  if (phase !== 'waiting-user' || !pendingUpdate?.version) return null;
  try {
    return {
      version: pendingUpdate.version,
      current: app.getVersion(),
      notes: pendingUpdate.notes || '',
    };
  } catch {
    return null;
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

async function checkWindows() {
  phase = 'checking';
  // 关掉自动下载与自动安装：一切等用户在卡片上点「更新」。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('download-progress', (p) => {
    progress('downloading', { percent: p?.percent || 0 });
  });
  autoUpdater.on('update-downloaded', () => {
    progress('applying', { message: '更新已下载，正在安装并重启…' });
    try {
      autoUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
    } catch {
      autoUpdater.quitAndInstall(true, true);
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err);
    progress('error', { message: String(err?.message || err) });
  });

  let info = null;
  try {
    const result = await autoUpdater.checkForUpdates();
    info = result?.updateInfo || null;
  } catch (err) {
    console.error('[auto-updater] check failed', err);
    phase = 'idle';
    return;
  }
  if (!info?.version || info.version === app.getVersion()) {
    phase = 'idle';
    return;
  }
  // 用户点过「跳过本版本」→ 同版本不再提示
  if (String(hooks.getSkippedVersion() || '') === String(info.version)) {
    phase = 'idle';
    return;
  }
  // 版本说明走接口（latest.yml 里没有 releaseNotes）
  const data = await fetchCheck(WIN_CHECK_URL);
  pendingUpdate = { version: info.version, macEntry: null };
  askUser(info.version, shortNotes(data?.release_notes));
}

async function checkMac() {
  phase = 'checking';
  const data = await fetchCheck(MAC_CHECK_URL);
  if (!data) {
    phase = 'idle';
    return;
  }
  const latest = String(data.latest_version || '');
  if (!latest || latest === app.getVersion()) {
    phase = 'idle';
    return;
  }
  if (String(hooks.getSkippedVersion() || '') === latest) {
    phase = 'idle';
    return;
  }
  pendingUpdate = { version: latest, macEntry: data };
  askUser(latest, shortNotes(data.release_notes));
}

// ---------------- 用户在卡片上的选择 ----------------

/**
 * 'cancel' → 什么都不做，继续用软件（下次启动还会提示）
 * 'skip'   → 记住版本号，该版本不再提示（更高的版本仍会提示）
 * 'update' → 这时才真正下载并安装
 */
async function handleUserChoice(choice) {
  if (choice === 'cancel') return { ok: true, action: 'cancel' };
  if (choice === 'skip') {
    const version = pendingUpdate?.version || '';
    if (version) hooks.setSkippedVersion(version);
    pendingUpdate = null;
    phase = 'idle';
    return { ok: true, action: 'skip', version };
  }
  if (choice !== 'update') return { ok: false, action: 'unknown' };
  if (!pendingUpdate) return { ok: false, action: 'nothing-pending' };

  if (process.platform === 'win32') {
    progress('downloading', { percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
      // 下载完成后由 update-downloaded 事件接管安装
      return { ok: true, action: 'update' };
    } catch (err) {
      progress('error', { message: String(err?.message || err) });
      return { ok: false, action: 'update', message: String(err?.message || err) };
    }
  }
  if (process.platform === 'darwin') {
    progress('downloading', { percent: 0 });
    const ok = await stageMacUpdate(pendingUpdate.macEntry, pendingUpdate.version);
    if (ok) {
      progress('applying', { message: '正在替换应用，稍后会自动重启。' });
      notify('PH Launcher 正在更新', `退出后将自动替换为 v${pendingUpdate.version}。`);
      setTimeout(() => app.quit(), 1500);
      return { ok: true, action: 'update' };
    }
    progress('error', { message: '自动替换没能准备好，已为你打开下载页。' });
    try {
      await shell.openExternal(DOWNLOAD_URL);
    } catch {
      /* ignore */
    }
    return { ok: false, action: 'update', message: 'prepare-failed' };
  }
  return { ok: false, action: 'unsupported-platform' };
}

// ---------------- macOS：用户确认后才下载并替换 ----------------

async function stageMacUpdate(entry, latest) {
  const url = String(entry?.url || '');
  const sha = String(entry?.sha256 || '').toLowerCase();
  if (!url.endsWith('.zip') || !sha) return false;

  const appPath = currentAppBundle();
  if (!appPath) return false; // 开发模式（不在 .app 内）不自动替换

  const staging = path.join(app.getPath('userData'), '.update-staging');
  const zipPath = path.join(staging, 'update.zip');
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await downloadFile(url, zipPath, (percent) => progress('downloading', { percent }));
    if (sha256File(zipPath) !== sha) {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
    execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, staging]);
    fs.rmSync(zipPath, { force: true });

    const newApp = findAppBundle(staging);
    if (!newApp) {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
    writeAndLaunchSwapScript(appPath, newApp, staging, latest);
    return true;
  } catch (err) {
    console.error('[auto-updater] mac stage failed', err);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
 * 清 quarantine → ad-hoc 重签 → open 重启。**只在用户点过「更新」后才会走到这里。**
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
 * 应用启动后调用一次（main.cjs 在窗口创建后触发）。
 * 只**检查并提示**；用户点「更新」之前不会有任何下载或安装动作。
 */
function initAutoUpdater(injected) {
  if (injected) hooks = { ...hooks, ...injected };
  if (skipAutoCheck) return;   // 自检/冒烟/截图模式不联网
  if (process.platform === 'win32') {
    setTimeout(() => { checkWindows().catch(() => {}); }, 3000);
  } else if (process.platform === 'darwin') {
    setTimeout(() => { checkMac().catch(() => {}); }, 3000);
  }
}

// 测试时（self-test / smoke-test）跳过自动检查，避免网络请求干扰
function disableAutoUpdater() {
  skipAutoCheck = true;
}

module.exports = {
  initAutoUpdater,
  disableAutoUpdater,
  handleUserChoice,
  getPendingUpdate,
  getStatus: () => phase,
};
