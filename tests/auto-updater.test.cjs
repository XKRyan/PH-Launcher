'use strict';

/**
 * 应用内自动更新（PHL）接线测试。
 *
 * Windows 用 electron-updater 全自动；macOS 未签名走半自动（检查 /api/v1/update/check
 * 后提示打开下载页）。这里做源码形态断言 + 逻辑单元测试。
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

test('macOS 未签名走半自动：检查 /api/v1/update/check 后提示打开下载页', () => {
  assert.match(source, /https:\/\/phix\.ing\/api\/v1\/update\/check\?product=phl&platform=mac/);
  assert.match(source, /shell\.openExternal\(DOWNLOAD_URL\)/,
    '有新版本时提供打开下载页的入口');
  assert.match(source, /latest === current/, '版本相同则不提示');
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