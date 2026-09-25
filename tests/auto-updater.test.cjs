'use strict';

/**
 * 应用内自动更新（PHL）接线测试。
 *
 * Windows：electron-updater 全自动（下载→静默安装→重启）。
 * macOS（未签名）：自研"下载 zip → 校验 → 解压 → 替换 .app → 清 quarantine →
 *   ad-hoc 重签 → 重启"，用户只需在新版首次启动时右键打开一次；
 *   准备失败才降级到打开的下载页。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../electron/auto-updater.cjs'), 'utf8');
const mainSrc = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));

test('Windows 走 electron-updater 全自动（下载→静默安装→重启）', () => {
  assert.match(source, /const \{ autoUpdater \} = require\('electron-updater'\)/);
  assert.match(source, /autoUpdater\.autoDownload = true/);
  assert.match(source, /autoUpdater\.autoInstallOnAppQuit = true/);
  assert.match(source, /quitAndInstall\(\{ isSilent: true, isForceRunAfter: true \}\)/,
    '退出时静默安装并自动重启');
});

test('macOS 自动下载 zip 并校验 SHA256（不是只提示用户去下载）', () => {
  assert.match(source, /https:\/\/phix\.ing\/api\/v1\/update\/check\?product=phl&platform=mac/);
  assert.match(source, /url\.endsWith\('\.zip'\)/, '只接受 zip 载荷（dmg 无法自动替换）');
  assert.match(source, /sha256File\(zipPath\) !== sha/, 'SHA256 不匹配要丢弃');
  assert.match(source, /downloadFile\(url, zipPath\)/, '自己下载');
});

test('macOS 解压与替换：ditto 解包、旧包进废纸篓、清 quarantine、ad-hoc 重签、重启', () => {
  assert.match(source, /execFileSync\('\/usr\/bin\/ditto', \['-x', '-k', zipPath, staging\]\)/,
    '用 ditto 解 zip（保留权限与符号链接）');
  assert.match(source, /function writeAndLaunchSwapScript/, '要有替换脚本');
  assert.match(source, /kill -0 "\$PID"/, '脚本要等主进程退出');
  assert.match(source, /\.Trash/, '旧包移进废纸篓而不是直接删（可捞回）');
  assert.match(source, /xattr -dr com\.apple\.quarantine/, '清隔离属性，避免"应用已损坏"');
  assert.match(source, /codesign --sign - --deep --force/, 'ad-hoc 重签');
  assert.match(source, /\/usr\/bin\/open "\$TARGET"/, '重启新版');
  assert.match(source, /spawn\('\/bin\/bash', \[script\], \{ detached: true/, '脚本要脱离主进程');
});

test('macOS 定位当前 .app，不在 .app 内运行（开发模式）时不自动替换', () => {
  assert.match(source, /function currentAppBundle\(\)/, '要从可执行文件上溯找 .app');
  assert.match(source, /if \(!appPath\) return false; \/\/ 不在 \.app 里运行（开发模式）→ 不自动替换/);
  assert.match(source, /function findAppBundle\(dir\)/, 'staging 里要能找出 .app（可能包一层目录）');
});

test('macOS 自动替换失败时才降级到下载页', () => {
  assert.match(source, /async function fallbackOpenDownloadPage/);
  assert.match(source, /const ok = await downloadAndStageMac\(data, latest\);/);
  assert.match(source, /await fallbackOpenDownloadPage\(latest\);/, '准备失败才降级');
  assert.match(source, /shell\.openExternal\(DOWNLOAD_URL\)/);
});

test('发布配置指向 phix 的 generic 服务器，Windows 用 latest.yml', () => {
  assert.equal(pkg.build.publish.provider, 'generic');
  assert.equal(pkg.build.publish.url, 'https://phix.ing/updates/phl');
});

test('main.cjs 在窗口创建后启动自动更新，且自检/冒烟模式禁用', () => {
  assert.match(mainSrc, /autoUpdater\.initAutoUpdater\(\)/);
  assert.match(mainSrc, /if \(IS_HEADLESS\) \{\s*\n\s*autoUpdater\.disableAutoUpdater\(\);/,
    '自检/冒烟/截图模式不联网检查');
});

test('macOS 构建产出 zip 载荷（自动替换的前提）', () => {
  const buildScript = fs.readFileSync(require.resolve('../scripts/macos_build_phl.py'), 'utf8');
  assert.match(buildScript, /electron-builder --mac dmg zip/, '要带 zip target');
  assert.match(buildScript, /zips = \[l\.split\(\)\[-1\]/, '要收集 zip');
  assert.match(buildScript, /for name in dmgs \+ zips:/, 'zip 也要拉回本地');
});
