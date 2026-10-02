'use strict';

/**
 * 应用内更新（PHL）接线测试。
 *
 * 核心不变式：**只检查、只提示，绝不自动更新**。
 * 进入软件后检查一次；发现新版本弹卡片（版本号 + 更新内容 + 取消/跳过本版本/更新）；
 * 只有用户点「更新」才会下载并安装。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../electron/auto-updater.cjs'), 'utf8');
const mainSrc = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const preloadSrc = fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8');
const appSrc = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));

test('Windows：关掉 electron-updater 的自动下载与自动安装', () => {
  assert.match(source, /autoUpdater\.autoDownload = false/,
    '必须关掉自动下载 —— 用户没点更新前不该下任何东西');
  assert.match(source, /autoUpdater\.autoInstallOnAppQuit = false/,
    '必须关掉退出时自动安装');
  assert.doesNotMatch(source, /autoUpdater\.autoDownload = true/);
  assert.doesNotMatch(source, /autoUpdater\.autoInstallOnAppQuit = true/);
});

test('只有用户在卡片上点「更新」才会下载/安装', () => {
  assert.match(source, /async function handleUserChoice\(choice\)/);
  const fn = source.slice(source.indexOf('async function handleUserChoice'));
  const body = fn.slice(0, fn.indexOf('\n// ---------------- macOS'));
  assert.match(body, /autoUpdater\.downloadUpdate\(\)/, '点更新后才下载');

  // downloadUpdate 全局只应出现一次，且必须在 handleUserChoice 里
  // （检查阶段只注册事件，绝不主动下载）
  const calls = [...source.matchAll(/autoUpdater\.downloadUpdate\(\)/g)].length;
  assert.equal(calls, 1, `downloadUpdate 只该在用户点更新时调用一次，实际 ${calls} 处`);
  const at = source.indexOf('autoUpdater.downloadUpdate()');
  assert.ok(at > source.indexOf('async function handleUserChoice'), '必须在 handleUserChoice 内');
  assert.ok(at < source.indexOf('async function stageMacUpdate'), '且不能在 macOS 分支之后');

  // 安装只能在下载完成的回调里（不是检查时）。
  // 注意从 update-downloaded 之后再找 —— 文件头部注释里也提到过 quitAndInstall。
  const dlIdx = source.indexOf("autoUpdater.on('update-downloaded'");
  assert.ok(dlIdx > 0, '要有 update-downloaded 处理');
  const qI = source.indexOf('quitAndInstall', dlIdx);
  assert.ok(qI > dlIdx, 'quitAndInstall 必须在 update-downloaded 回调内');

  // 检查函数里不能主动下载/安装
  const checkWin = source.slice(source.indexOf('async function checkWindows'),
                                source.indexOf('async function checkMac'));
  const checkWinNoHandlers = checkWin.replace(/autoUpdater\.on\([\s\S]*?\n  \}\);/g, '');
  assert.doesNotMatch(checkWinNoHandlers, /autoUpdater\.downloadUpdate\(\)/, '检查阶段绝不下载');
  assert.doesNotMatch(checkWinNoHandlers, /qtAndInstall/, '检查阶段绝不安装');
});

test('三个选择：cancel 什么都不做 / skip 记住版本 / update 才执行', () => {
  assert.match(source, /if \(choice === 'cancel'\) return \{ ok: true, action: 'cancel' \};/);
  assert.match(source, /if \(choice === 'skip'\) \{[\s\S]{0,200}?hooks\.setSkippedVersion\(version\)/);
  assert.match(source, /if \(choice !== 'update'\) return \{ ok: false, action: 'unknown' \};/);
});

test('「跳过本版本」只拦相同版本（更高的版本仍会提示）', () => {
  assert.match(source, /if \(String\(hooks\.getSkippedVersion\(\) \|\| ''\) === String\(info\.version\)\)/);
  assert.match(source, /if \(String\(hooks\.getSkippedVersion\(\) \|\| ''\) === latest\)/);
  // 存储字段
  assert.match(mainSrc, /skippedUpdateVersion: ''/, 'settings 里要有这个字段');
  assert.match(mainSrc, /secureStore\.data\.settings\.skippedUpdateVersion = String\(version \|\| ''\)/);
});

test('检查到新版本 → 通知渲染层弹卡片（不是自己下载）', () => {
  assert.match(source, /hooks\.sendToRenderer\('app:update-available'/);
  assert.match(source, /function askUser\(version, notes\)/);
  assert.match(preloadSrc, /onUpdateAvailable: \(callback\) => on\('app:update-available', callback\)/);
  assert.match(preloadSrc, /updateChoice: \(choice\) => ipcRenderer\.invoke\('app:update-choice', choice\)/);
  assert.match(preloadSrc, /onUpdateProgress: \(callback\) => on\('app:update-progress', callback\)/);
});

test('卡片里有版本号、更新内容和三个按钮', () => {
  assert.match(htmlSrc, /id="updateDialog"/);
  assert.match(htmlSrc, /id="updateVersion"/);
  assert.match(htmlSrc, /id="updateNotes"/);
  assert.match(htmlSrc, /id="updateCancel"/);
  assert.match(htmlSrc, /id="updateSkip"/);
  assert.match(htmlSrc, /id="updateNow"/);
  assert.match(appSrc, /function showUpdateCard\(info\)/);
  assert.match(appSrc, /新版本 v\$\{latest\}（当前 v\$\{current\}）/, '卡片要显示版本号');
  assert.match(appSrc, /window\.ph\.updateChoice\?\.\('cancel'\)/);
  assert.match(appSrc, /window\.ph\.updateChoice\?\.\('skip'\)/);
  assert.match(appSrc, /window\.ph\.updateChoice\?\.\('update'\)/);
});

test('macOS：用户确认后才下载 zip → 校验 → 解压 → 替换 → 清 quarantine → 重签 → 重启', () => {
  assert.match(source, /MAC_CHECK_URL/);
  assert.match(source, /url\.endsWith\('\.zip'\)/, '只接受 zip 载荷');
  assert.match(source, /sha256File\(zipPath\) !== sha/, 'SHA256 不匹配要丢弃');
  assert.match(source, /execFileSync\('\/usr\/bin\/ditto', \['-x', '-k', zipPath, staging\]\)/);
  assert.match(source, /function writeAndLaunchSwapScript/);
  assert.match(source, /kill -0 "\$PID"/, '脚本要等主进程退出');
  assert.match(source, /\.Trash/, '旧包进废纸篓（可捞回）');
  assert.match(source, /xattr -dr com\.apple\.quarantine/);
  assert.match(source, /codesign --sign - --deep --force/);
  assert.match(source, /spawn\('\/bin\/bash', \[script\], \{ detached: true/);
  // 替换只能由 handleUserChoice('update') 触发
  assert.match(source, /const ok = await stageMacUpdate\(pendingUpdate\.macEntry, pendingUpdate\.version\)/);
});

test('开发模式（不在 .app 内）不替换，准备失败才降级到下载页', () => {
  assert.match(source, /function currentAppBundle\(\)/);
  assert.match(source, /if \(!appPath\) return false; \/\/ 开发模式（不在 \.app 内）不自动替换/);
  assert.match(source, /function findAppBundle\(dir\)/);
  assert.match(source, /await shell\.openExternal\(DOWNLOAD_URL\)/, '只有准备失败才打开下载页');
});

test('main.cjs 注入存储与渲染桥，自检/冒烟模式不联网', () => {
  assert.match(mainSrc, /autoUpdater\.initAutoUpdater\(\{/);
  assert.match(mainSrc, /getSkippedVersion: \(\) => String\(secureStore\?\.data\?\.settings\?\.skippedUpdateVersion/);
  assert.match(mainSrc, /sendToRenderer: \(channel, payload\) => sendToRenderer\(channel, payload\)/);
  assert.match(mainSrc, /ipcMain\.handle\('app:update-choice'/);
  assert.match(mainSrc, /if \(IS_HEADLESS\) \{\s*\n\s*autoUpdater\.disableAutoUpdater\(\);/);
  assert.match(source, /if \(skipAutoCheck\) return;/, 'disableAutoUpdater 要真的生效');
});

test('按 Esc 关掉卡片也算「取消」，且不重复上报', () => {
  assert.match(appSrc, /let updateChoiceSent = false;/);
  assert.match(appSrc, /\$\('#updateDialog'\)\?\.addEventListener\('close'/,
    'dialog 的 close 事件（Esc）要当成取消');
  assert.match(appSrc, /if \(updateChoiceSent\) return;/, 'close 回调里要防重复上报');
  assert.match(appSrc, /updateChoiceSent = false;\s*\n\s*if \(!dialog\.open\) dialog\.showModal\(\);/,
    '每次弹卡片都要重置标记');
  // 三个按钮都必须先把标记置上，免得 close 回调再补发一次
  for (const choice of ['cancel', 'skip', 'update']) {
    const at = appSrc.indexOf(`window.ph.updateChoice?.('${choice}')`);
    assert.ok(at > 0, `缺 ${choice} 的回传`);
    assert.ok(appSrc.lastIndexOf('updateChoiceSent = true;', at) > 0,
      `${choice} 按钮要先置 updateChoiceSent`);
  }
});

test('渲染层启动时主动拉一次待办更新（IPC 早到也不会丢）', () => {
  // 检查跟渲染层初始化是并发的：先发现新版本的话，app:update-available
  // 发出去时还没人监听，消息就没了 —— 所以渲染层要能反过来取一次。
  assert.match(source, /function getPendingUpdate\(\)/);
  assert.match(source, /if \(phase !== 'waiting-user' \|\| !pendingUpdate\?\.version\) return null;/);
  assert.match(source, /getPendingUpdate,/, '要导出给 main.cjs 用');
  assert.match(mainSrc, /ipcMain\.handle\('app:update-pending'/);
  assert.match(preloadSrc, /updatePending: \(\) => ipcRenderer\.invoke\('app:update-pending'\)/);
  assert.match(appSrc, /window\.ph\.updatePending\?\.\(\)/);
});

test('发布配置与 macOS 构建产出 zip（自动替换的前提）', () => {
  assert.equal(pkg.build.publish.provider, 'generic');
  assert.equal(pkg.build.publish.url, 'https://phix.ing/updates/phl');
  const buildScript = fs.readFileSync(require.resolve('../scripts/macos_build_phl.py'), 'utf8');
  assert.match(buildScript, /electron-builder --mac dmg zip/);
  assert.match(buildScript, /for name in dmgs \+ zips:/);
});
