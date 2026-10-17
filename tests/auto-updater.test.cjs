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

// ---- 「关于软件」· 手动检查更新（设置 → 关于 →「检查更新」按钮） ----

test('设置里有「关于」条目，且面板包含四个必备块', () => {
  // 导航里有「关于」按钮，且有对应的 data-settings-panel="about" 面板。
  assert.match(htmlSrc, /data-settings-section="about"/, '设置导航要有「关于」入口');
  assert.match(htmlSrc, /data-settings-panel="about"/, '要有对应的设置面板');
  const at = htmlSrc.indexOf('data-settings-panel="about"');
  const panel = htmlSrc.slice(at);
  // 当前版本（不硬编码，由主进程 app.getVersion() 填）
  assert.match(panel, /id="aboutCurrentVersion"/);
  // 手动「检查更新」按钮
  assert.match(panel, /id="checkUpdateButton"[\s\S]{0,80}?检查更新/);
  // 作者信息（与官网页脚一致）
  assert.match(panel, /上海民办平和学校 · 维修社 · 用代码装点校园生活/);
  assert.match(panel, /norine\.liu@icloud\.com \/ huaziqian40@gmail\.com/);
  assert.match(panel, /18901712280 \/ 13675821816/);
  assert.match(panel, /微信：Norine2010 \/ int_32_2147483647/);
  assert.match(panel, /id="aboutBilibili"/);
  assert.match(panel, /© 2026 phix/);
  // 「访问官网」按钮
  assert.match(panel, /id="visitOfficialSite"/);
});

test('手动检查必定回一个结果：失败≠已是最新版本（离线/服务器挂了要分开报）', () => {
  assert.match(source, /async function manualCheck\(\)/, '要有手动检查函数');
  assert.match(source, /status: 'up-to-date'/, '已是最新版本是一种明确结果');
  assert.match(source, /status: 'failed'/, '检查失败是另一种明确结果，绝不能与已是最新混在一起');
  // Windows / macOS 两套手动检查都必须把「服务器没回」判成 failed 而不是 up-to-date
  assert.match(source, /manualCheckWindows\([\s\S]{0,1200}?检查失败，请稍后再试/);
  assert.match(source, /manualCheckMac\([\s\S]{0,1200}?检查失败，请稍后再试/);
  assert.match(source, /return \{ ok: false, status: 'failed', error: '检查失败，请稍后再试' \};/);
  assert.match(appSrc, /检查失败，请稍后再试/, '界面上失败文案');
  assert.match(appSrc, /已是最新版本/, '界面要有「已是最新版本」的文案');
});

test('按钮处理绝不能把失败抛出（兜底 catch + finally 恢复可点）', () => {
  assert.match(appSrc, /async function manualUpdateCheck\(\)/);
  const fn = appSrc.slice(appSrc.indexOf('async function manualUpdateCheck'));
  assert.match(fn, /catch \(error\) \{/, '要有兜底 catch');
  assert.match(fn, /finally \{[\s\S]{0,120}?button\.disabled = false/, 'finally 里必须恢复按钮可点');
  assert.match(preloadSrc, /updateCheck: \(\) => ipcRenderer\.invoke\('app:update-check'\)/, 'preload 要暴露手动检查');
  assert.match(mainSrc, /ipcMain\.handle\('app:update-check'/, '主进程要接住手动检查');
});

test('「关于」里的当前版本来自单一事实源（app.getVersion），不硬编码', () => {
  // 版本号由主进程 system:version → app.getVersion() 提供；界面只是回显。
  assert.match(mainSrc, /ipcMain\.handle\('system:version', \(\) => app\.getVersion\(\)\)/);
  assert.match(appSrc, /state\.appVersion = appVersion;/, '界面把版本存进 state');
  assert.match(appSrc, /\$\('#aboutCurrentVersion'\)[\s\S]{0,80}?v\$\{appVersion\}/, '当前版本显示来自 state.appVersion');
  // 手动检查默认不动重启检查；两套检查共用同一套“跳过本版本”判定（不重置跳过记录）
  assert.match(source, /manualCheckWindows\([\s\S]{0,900}?hooks\.getSkippedVersion/);
});
