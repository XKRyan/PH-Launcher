'use strict';

/**
 * 应用内更新（PHL）接线测试。
 *
 * 2026-11-09 起的行为：
 *   启动后静默检查更新；发现新版本**静默下载**（不弹通知、不显示进度）；
 *   卡片只在启动发现更新 / 用户手动检查更新时出现；没下完显示进度条，
 *   下载完由用户点「重启并安装」才安装。绝不自动安装。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../electron/auto-updater.cjs'), 'utf8');
const mainSrc = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const preloadSrc = fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8');
const appSrc = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const cssSrc = fs.readFileSync(require.resolve('../src/styles.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));

test('Windows：仍关掉 electron-updater 的自动下载与自动安装', () => {
  assert.match(source, /autoUpdater\.autoDownload = false/,
    '下载由我们显式调用，便于维护进度状态');
  assert.match(source, /autoUpdater\.autoInstallOnAppQuit = false/,
    '必须关掉退出时自动安装');
  assert.doesNotMatch(source, /autoUpdater\.autoDownload = true/);
  assert.doesNotMatch(source, /autoUpdater\.autoInstallOnAppQuit = true/);
});

test('启动后静默检查并静默下载：检查结果一到就自动下载', () => {
  assert.match(source, /function initAutoUpdater\(injected, options = \{\}\)/);
  assert.match(source, /setTimeout\(\(\) => \{ startSilentCheck\(\)\.catch\(\(\) => \{\}\); \}, 3000\)/);
  assert.match(source, /if \(result\.status === 'new'\) \{[\s\S]{0,900}?void startSilentDownload\(\);/,
    'startSilentCheck 发现新版本后必须自动开始静默下载');
  assert.match(source, /function startSilentDownload\(\)/);
  // 自动下载只能出现在 startSilentDownload 里（用户点「更新」也会复用它，不算重复下载）
  assert.ok(source.includes('autoUpdater.downloadUpdate()'), '要调用 electron-updater 下载');
  const dlBlock = source.slice(source.indexOf('function startSilentDownload'), source.indexOf('// ---------------- 启动静默检查'));
  assert.match(dlBlock, /autoUpdater\.downloadUpdate\(\)/);
  assert.match(dlBlock, /prepareMacDownload\(pendingMacEntry, state\.version\)/);
});

test('检查/下载期间不弹系统通知（静默）', () => {
  assert.doesNotMatch(source, /Notification/, '不能有任何系统通知');
  assert.doesNotMatch(source, /notify\(/, '不能残留 notify 调用');
  assert.doesNotMatch(source, /app:update-progress/, '旧的会触发界面的进度事件不应再发');
});

test('下载完成事件只更新状态，绝不自动安装', () => {
  const dlIdx = source.indexOf("autoUpdater.on('update-downloaded'");
  assert.ok(dlIdx > 0, '要有 update-downloaded 处理');
  const handler = source.slice(dlIdx, source.indexOf("autoUpdater.on('error'"));
  assert.doesNotMatch(handler, /quitAndInstall/, '下载完成时不能自动退出安装');
  // quitAndInstall 只能由用户点「重启并安装」触发的 installWindowsUpdate 调用
  const installAt = source.indexOf('function installWindowsUpdate()');
  assert.ok(installAt > 0);
  const qi = source.indexOf('autoUpdater.quitAndInstall', installAt);
  assert.ok(qi > installAt, 'quitAndInstall 必须在 installWindowsUpdate 内');
  assert.equal([...source.matchAll(/autoUpdater\.quitAndInstall/g)].length, 2,
    '只允许安装函数里的主/兜底两次调用');
  assert.match(source, /if \(state\.downloaded\) \{[\s\S]{0,120}?installWindowsUpdate\(\)/,
    '只有已下载且用户点 update 才安装');
});

test('进度状态会广播给卡片：阶段 + 百分比 + 已下载标记', () => {
  assert.match(source, /hooks\.sendToRenderer\('app:update-state'/);
  assert.match(source, /autoUpdater\.on\('download-progress', \(p\) =>/);
  assert.match(source, /percent: pct/);
  assert.match(source, /downloaded: true/);
  assert.match(source, /getPendingUpdate\(\)/);
  assert.match(source, /function getUpdateState\(\)|getUpdateState: publicState/);
  assert.match(preloadSrc, /onUpdateState: \(callback\) => on\('app:update-state', callback\)/);
  assert.doesNotMatch(preloadSrc, /onUpdateAvailable|onUpdateProgress/);
});

test('跳过本版本只拦相同版本（更高的版本仍会提示），且跳过版本不再下载', () => {
  assert.match(source, /function isSkipped\(version\)/);
  assert.match(source, /if \(isSkipped\(result\.version\)\) \{[\s\S]{0,300}?status: 'skipped'/);
  assert.match(source, /if \(isSkipped\(state\.version\)\) \{/);
  assert.match(mainSrc, /skippedUpdateVersion: ''/);
  assert.match(mainSrc, /secureStore\.data\.settings\.skippedUpdateVersion = String\(version \|\| ''\)/);
});

test('卡片：启动/手动检查时弹出，带版本号、更新内容和三个按钮', () => {
  assert.match(htmlSrc, /id="updateDialog"/);
  assert.match(htmlSrc, /id="updateVersion"/);
  assert.match(htmlSrc, /id="updateNotes"/);
  assert.match(htmlSrc, /id="updateCancel"/);
  assert.match(htmlSrc, /id="updateSkip"/);
  assert.match(htmlSrc, /id="updateNow"/);
  assert.match(appSrc, /function showUpdateCard\(info\)/);
  assert.match(appSrc, /function handleUpdateState\(info\)/);
  assert.match(appSrc, /window\.ph\.onUpdateState\?\.\(\(info\) => handleUpdateState\(info\)\)/);
  assert.match(appSrc, /window\.ph\.updatePending\?\.\(\)/);
  assert.match(appSrc, /新版本 v\$\{latest\}（当前 v\$\{current\}）/, '卡片要显示版本号');
});

test('卡片有下载进度条，且进度只更新不重新弹卡片', () => {
  assert.match(htmlSrc, /id="updateProgressRow"/);
  assert.match(htmlSrc, /id="updateProgressFill"/);
  assert.match(htmlSrc, /id="updateProgressLabel"/);
  assert.match(cssSrc, /\.update-progress-track/);
  assert.match(cssSrc, /\.update-progress-fill/);
  assert.match(appSrc, /function paintUpdateCard\(info\)/);
  assert.match(appSrc, /fill\.style\.width = `\$\{percent\}%`/);
  assert.match(appSrc, /正在后台下载新版本… \$\{percent\}%/);
  assert.match(appSrc, /if \(downloaded\) \{[\s\S]{0,400}?now\.textContent = '重启并安装'/);
  assert.match(appSrc, /phase === 'error'[\s\S]{0,400}?now\.textContent = '重试下载'/);
  // 进度事件不能把用户已经关掉的卡片重新弹出来
  assert.match(appSrc, /if \(String\(info\.version\) === updateDismissedVersion\) return;/);
  assert.match(appSrc, /updateDismissedVersion = updateShowingVersion;/);
  assert.doesNotMatch(appSrc, /handleUpdateProgress/);
});

test('三个选择：cancel 只关卡片 / skip 记住版本 / update 按状态下载或安装', () => {
  assert.match(source, /if \(choice === 'cancel'\) return \{ ok: true, action: 'cancel' \};/);
  assert.match(source, /if \(choice === 'skip'\) \{[\s\S]{0,200}?hooks\.setSkippedVersion\(version\)/);
  assert.match(source, /if \(choice !== 'update'\) return \{ ok: false, action: 'unknown' \};/);
  assert.match(source, /if \(state\.phase === 'downloading' \|\| downloadInFlight\)/,
    '下载中再点更新不应重复下载');
});

test('macOS：静默下载 zip → SHA256 校验 → 暂存；用户确认后才解压替换', () => {
  assert.match(source, /MAC_CHECK_URL/);
  assert.match(source, /url\.endsWith\('\.zip'\)/, '只接受 zip 载荷');
  assert.match(source, /async function prepareMacDownload\(entry, latest\)/);
  assert.match(source, /sha256File\(zipPath\) !== sha/, 'SHA256 不匹配要丢弃');
  assert.match(source, /fs\.writeFileSync\(stagingMetaPath\(\), JSON\.stringify\(\{ version: latest, sha256: sha \}\)/,
    '要记住已下载的版本/SHA，下次启动直接复用');
  assert.match(source, /async function installMacUpdate\(\)/);
  assert.match(source, /const ok = await installMacUpdate\(\)/, '安装只在用户点更新后');
  assert.match(source, /execFileSync\('\/usr\/bin\/ditto', \['-x', '-k', zipPath, extractDir\]\)/);
  assert.match(source, /function writeAndLaunchSwapScript/);
  assert.match(source, /kill -0 "\$PID"/, '脚本要等主进程退出');
  assert.match(source, /\.Trash/, '旧包进废纸篓（可捞回）');
  assert.match(source, /xattr -dr com\.apple\.quarantine/);
  assert.match(source, /codesign --sign - --deep --force/);
  assert.doesNotMatch(source, /notify\('PH Launcher 正在更新'/,
    '静默下载阶段不能弹通知');
});

test('开发模式（不在 .app 内）不下载替换包，准备失败才降级到下载页', () => {
  assert.match(source, /function currentAppBundle\(\)/);
  assert.match(source, /if \(!appPath\) return false; \/\/ 开发模式（不在 \.app 内）不下载替换包/);
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

test('按 Esc 关掉卡片也算「取消」，且不重复上报；关掉后进度不重弹', () => {
  assert.match(appSrc, /let updateChoiceSent = false;/);
  assert.match(appSrc, /\$\('#updateDialog'\)\?\.addEventListener\('close'/,
    'dialog 的 close 事件（Esc）要当成取消');
  assert.match(appSrc, /if \(updateChoiceSent\) return;/, 'close 回调里要防重复上报');
  assert.match(appSrc, /updateDismissedVersion = updateShowingVersion;/);
  assert.match(appSrc, /updateDismissedVersion = '';\s*\n\s*updateChoiceSent = false;/, '弹卡片时重置已关闭标记');
  for (const choice of ['cancel', 'skip', 'update']) {
    const at = appSrc.indexOf(`window.ph.updateChoice?.('${choice}')`);
    assert.ok(at > 0, `缺 ${choice} 的回传`);
    assert.ok(appSrc.lastIndexOf('updateChoiceSent = true;', at) > 0,
      `${choice} 按钮要先置 updateChoiceSent`);
  }
});

test('渲染层启动时主动拉当前更新状态（IPC 早到也不会丢，含下载进度）', () => {
  assert.match(source, /function getPendingUpdate\(\)/);
  assert.match(source, /if \(state\.phase === 'idle' \|\| state\.phase === 'checking'\) return null;/);
  assert.match(source, /return publicState\(\);/, '待办要带 phase/percent/downloaded 供卡片画进度');
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

// ---- 手动「检查更新」（设置 → 关于 →「检查更新」按钮） ----

test('设置里有「关于」条目，且面板包含必备块', () => {
  assert.match(htmlSrc, /data-settings-section="about"/, '设置导航要有「关于」入口');
  assert.match(htmlSrc, /data-settings-panel="about"/, '要有对应的设置面板');
  const at = htmlSrc.indexOf('data-settings-panel="about"');
  const panel = htmlSrc.slice(at);
  assert.match(panel, /id="aboutCurrentVersion"/);
  assert.match(panel, /id="checkUpdateButton"[\s\S]{0,80}?检查更新/);
  assert.match(panel, /上海民办平和学校 · 维修社 · 用代码装点校园生活/);
  assert.match(panel, /norine\.liu@icloud\.com \/ huaziqian40@gmail\.com/);
  assert.match(panel, /18901712280 \/ 13675821816/);
  assert.match(panel, /微信：Norine2010 \/ int_32_2147483647/);
  assert.match(panel, /id="aboutBilibili"/);
  assert.match(panel, /© 2026 phix/);
  assert.match(panel, /id="visitOfficialSite"/);
});

test('手动检查必定回一个结果：失败≠已是最新版本（离线/服务器挂了要分开报）', () => {
  assert.match(source, /async function manualCheck\(\)/, '要有手动检查函数');
  assert.match(source, /status: 'up-to-date'/, '已是最新版本是一种明确结果');
  assert.match(source, /status: 'failed'/, '检查失败是另一种明确结果，绝不能与已是最新混在一起');
  assert.match(source, /probeWindows\([\s\S]{0,900}?检查失败，请稍后再试/);
  assert.match(source, /probeMac\([\s\S]{0,900}?检查失败，请稍后再试/);
  assert.match(source, /error: result\?\.error \|\| '检查失败，请稍后再试'/);
  assert.match(appSrc, /检查失败，请稍后再试/, '界面上失败文案');
  assert.match(appSrc, /已是最新版本/, '界面要有「已是最新版本」的文案');
});

test('手动检查发现新版本时，卡片会带上下载状态/进度', () => {
  assert.match(source, /function updateResult\(\)/);
  assert.match(source, /phase: state\.phase/);
  assert.match(source, /percent: state\.percent/);
  assert.match(source, /downloaded: state\.downloaded/);
  assert.match(appSrc, /showUpdateCard\(result\)/);
  assert.match(appSrc, /result\.downloaded[\s\S]{0,160}?更新已下载/,
    '手动检查要如实说明已经下载好了');
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
  assert.match(mainSrc, /ipcMain\.handle\('system:version', \(\) => app\.getVersion\(\)\)/);
  assert.match(appSrc, /state\.appVersion = appVersion;/, '界面把版本存进 state');
  assert.match(appSrc, /\$\('#aboutCurrentVersion'\)[\s\S]{0,80}?v\$\{appVersion\}/, '当前版本显示来自 state.appVersion');
});

test('回包缺版本号 = 检查失败，不能报「已是最新版本」', () => {
  const win = source.slice(source.indexOf('async function probeWindows'), source.indexOf('async function probeMac'));
  const winMissing = win.indexOf('if (!info.version)');
  assert.ok(winMissing > 0, 'Windows 要单独处理"有 info 但没有 version"');
  assert.match(win.slice(winMissing, winMissing + 300), /status: 'failed'/,
    '缺 version 的分支必须返回 failed');
  assert.doesNotMatch(win.slice(winMissing, winMissing + 120), /status: 'up-to-date'/,
    '缺 version 不能混进 up-to-date');
  const mac = source.slice(source.indexOf('async function probeMac'), source.indexOf('// ---------------- Windows 下载'));
  const macMissing = mac.indexOf('if (!latest)');
  assert.ok(macMissing > 0, 'macOS 要单独处理"缺 latest_version"');
  assert.match(mac.slice(macMissing, macMissing + 300), /status: 'failed'/,
    '缺 latest_version 的分支必须返回 failed');
  assert.doesNotMatch(mac.slice(macMissing, macMissing + 120), /status: 'up-to-date'/,
    '缺 latest_version 不能混进 up-to-date');
});
