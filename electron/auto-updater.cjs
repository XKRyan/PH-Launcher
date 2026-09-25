'use strict';
/**
 * 应用内自动更新（PHL）。
 *
 * Windows（NSIS 安装版）：
 *   用 electron-updater 全自动：启动时静默检查 → 下载（后台）→ 退出时静默安装 → 重启。
 *   安装目录的用户数据（%APPDATA%）不受影响。
 *
 * macOS（未签名）：
 *   electron-updater 的 ShipIt 会因未签名拒绝安装；Gatekeeper 也会拦未签名 .app。
 *   所以 macOS 走"半自动"：启动时调用同一个 /api/v1/update/check 检查新版本，
 *   有新版就提示用户 → 打开官网下载页手动下载 dmg。
 *
 * 更新源（清单由 phix-server 提供，安装包由官网托管）：
 *   Windows: https://phix.ing/updates/phl/latest.yml  （electron-builder 生成）
 *   macOS:   https://phix.ing/api/v1/update/check?product=phl&platform=mac
 */

const { app, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_URL = 'https://phix.ing/api/v1/update/check?product=phl&platform=mac';
const DOWNLOAD_URL = 'https://phix.ing/download/';

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
    const resp = await fetch(CHECK_URL, { signal: ctrl.signal });
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
    // 提示用户去官网下载（未签名 macOS 无法自动替换，这是最可靠的路径）
    notify('PH Launcher 有新版本', `v${latest} 已发布，点此前往下载页更新。`);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '发现新版本 PH Launcher',
        body: `v${latest} 已发布。点击前往下载页更新（macOS 未签名版需手动下载）。`,
        silent: false,
      });
      n.on('click', () => shell.openExternal(DOWNLOAD_URL));
      n.show();
    }
  } catch (err) {
    console.error('[auto-updater] mac check failed', err);
    statusChanged('not-available');
  }
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
