'use strict';
/**
 * 应用内自动更新（PHL）。
 *
 * Windows（NSIS 安装版）：
 *   用 electron-updater 全自动：启动时静默检查 → 下载（后台）→ 退出时静默安装 → 重启。
 *   安装目录的用户数据（%APPDATA%）不受影响。
 *
 * macOS（未签名）：
 *   electron-updater 的 ShipIt 会因未签名拒绝安装，所以自己实现"下载 → 替换"：
 *     1. 调 /api/v1/update/check 拿新版本的 **.zip**（内含 .app）与 sha256
 *     2. 下载 → SHA256 校验 → 解压到 userData/.update-staging/
 *     3. 写一个脱离主进程的 bash 脚本：等本进程退出 → 旧 .app 移进废纸篓 →
 *        新 .app 复制到原位 → xattr 清 quarantine → codesign ad-hoc 重签 → open 重启
 *   **用户只需要在新版本首次启动时右键 →「打开」一次**（未签名应用的 Gatekeeper 限制），
 *   不需要自己下载。若自动替换失败（App Translocation、权限等），降级为：
 *   把新版放到「下载」目录并用 Finder 显示，提示用户拖拽替换。
 *
 * 更新源（清单由 phix-server 提供，安装包由官网托管）：
 *   Windows: https://phix.ing/updates/phl/latest.yml  （electron-builder 生成）
 *   macOS:   https://phix.ing/api/v1/update/check?product=phl&platform=mac
 */

const { app, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const CHECK_URL = 'https://phix.ing/api/v1/update/check?product=phl&platform=mac';
const DOWNLOAD_URL = 'https://phix.ing/download/';
const USER_AGENT = () => `PH-Launcher-${app.getVersion()}`;

let updaterStatus = ''; // '', 'checking', 'available', 'downloading', 'ready', 'not-available', 'error'
let skipAutoCheck = false;

function statusChanged(status) {
  updaterStatus = status;
  try {
    const win = require('./main.cjs').getMainWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:update-status', status);
    }
  } catch {
    /* 尚未初始化窗口时忽略 */
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
    }
  } catch {
    /* 通知失败不影响更新流程 */
  }
}

// ---------------- Windows：electron-updater 全自动 ----------------

function setupWindowsAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => statusChanged('checking'));
  autoUpdater.on('update-available', () => statusChanged('available'));
  autoUpdater.on('update-not-available', () => statusChanged('not-available'));
  autoUpdater.on('download-progress', () => statusChanged('downloading'));
  autoUpdater.on('update-downloaded', (info) => {
    statusChanged('ready');
    notify('PH Launcher 更新已就绪', `v${info.version} 将在退出时自动安装。`);
    try {
      // 静默安装并在安装完成后启动新版本（不打断用户当前操作）
      autoUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
    } catch {
      // 某些版本用旧式位置参数；两者都试
      autoUpdater.quitAndInstall(true, true);
    }
  });
  autoUpdater.on('error', (err) => {
    statusChanged('error');
    console.error('[auto-updater]', err);
  });
}

function checkWindowsUpdate() {
  if (skipAutoCheck) return;
  setupWindowsAutoUpdater();
  autoUpdater.checkForUpdates().catch((err) => {
    statusChanged('error');
    console.error('[auto-updater] check failed', err);
  });
}

// ---------------- macOS：半自动（未签名，提示打开下载页） ----------------

async function checkMacUpdate() {
  if (skipAutoCheck) return;
  statusChanged('checking');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(CHECK_URL, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT() } });
    clearTimeout(timer);
    if (!resp.ok) {
      statusChanged('not-available');
      return;
    }
    const data = await resp.json();
    if (!data.ok) {
      statusChanged('not-available');
      return;
    }
    const current = app.getVersion();
    const latest = String(data.latest_version || '');
    if (!latest || latest === current) {
      statusChanged('not-available');
      return;
    }
    statusChanged('available');

    // 下载 → 校验 → 解压 → 写替换脚本（用户只需在新版首次启动时右键打开一次）
    const ok = await downloadAndStageMac(data, latest);
    if (ok) {
      statusChanged('ready');
      notify('PH Launcher 更新已就绪',
        `v${latest} 将在退出后自动替换安装；下次打开时请右键 →「打开」一次。`);
    } else {
      // 自动替换准备失败 → 降级：把新版放到下载目录并用 Finder 显示
      await fallbackOpenDownloadPage(latest);
    }
  } catch (err) {
    console.error('[auto-updater] mac check failed', err);
    statusChanged('not-available');
  }
}

/** 下载 zip → SHA256 校验 → 解压到 staging → 写 bash 替换脚本并启动它。 */
async function downloadAndStageMac(entry, latest) {
  const url = entry.url;
  const sha = String(entry.sha256 || '').toLowerCase();
  if (!url || !sha || !url.endsWith('.zip')) return false;

  const staging = path.join(app.getPath('userData'), '.update-staging');
  const zipPath = path.join(staging, 'update.zip');
  const appPath = currentAppBundle();
  if (!appPath) return false; // 不在 .app 里运行（开发模式）→ 不自动替换

  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    statusChanged('downloading');
    await downloadFile(url, zipPath);

    // SHA256 校验：不匹配就丢弃（防篡改/半截包）
    if (sha256File(zipPath) !== sha) {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
    // 解压（macOS 自带 ditto；-x -k 解 zip，保留权限与符号链接）
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
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** 当前 .app 路径（从可执行文件上溯 Contents/MacOS/xxx → .app）。 */
function currentAppBundle() {
  try {
    let p = path.dirname(app.getPath('exe')); // .../X.app/Contents/MacOS
    for (let i = 0; i < 3; i += 1) {
      if (p.endsWith('.app')) return p;
      p = path.dirname(p);
    }
  } catch { /* ignore */ }
  return '';
}

/** staging 里找 .app（zip 顶层可能是 .app 或包一层目录）。 */
function findAppBundle(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(cur, e.name);
      if (e.name.endsWith('.app')) return full;
      stack.push(full);
    }
  }
  return '';
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const req = require('node:https').get(url, { headers: { 'User-Agent': USER_AGENT() } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    });
    req.on('error', (e) => { try { file.close(); fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } reject(e); });
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
 * 清 quarantine → ad-hoc 重签 → open 重启。
 * 用 `open -a` 之外的 shell（nohup）保证脚本在主进程退出后仍存活。
 */
function writeAndLaunchSwapScript(appPath, newApp, staging, latest) {
  const script = path.join(staging, 'swap.sh');
  const trashName = `${path.basename(appPath)}.old-${Date.now()}`;
  const trashDir = path.join(os.homedir(), '.Trash');
  const body = `#!/bin/bash
# PH Launcher 自动更新替换脚本（生成的）
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
  notify('PH Launcher 正在更新', `退出后将自动替换为 v${latest}。`);
  // 让主进程退出，把舞台交给替换脚本
  setTimeout(() => { app.quit(); }, 1200);
}

/** 降级路径：自动替换准备失败时，至少把用户送到能拿到新版的地方。 */
async function fallbackOpenDownloadPage(latest) {
  notify('发现新版本 PH Launcher', `v${latest} 已发布，前往下载页更新。`);
  try { await shell.openExternal(DOWNLOAD_URL); } catch { /* ignore */ }
}

/**
 * 应用启动时调用一次（由 main.cjs 在 app ready 后触发）。
 * Windows 全自动；macOS 半自动提示。启动后约 3 秒才检查，避免拖慢首屏。
 */
function initAutoUpdater() {
  if (process.platform === 'win32') {
    setTimeout(checkWindowsUpdate, 3000);
  } else if (process.platform === 'darwin') {
    setTimeout(checkMacUpdate, 3000);
  }
}

// 测试时（self-test / smoke-test）跳过自动更新，避免网络请求干扰
function disableAutoUpdater() {
  skipAutoCheck = true;
}

module.exports = { initAutoUpdater, disableAutoUpdater, getStatus: () => updaterStatus };
