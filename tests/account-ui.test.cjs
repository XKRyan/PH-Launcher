'use strict';

/**
 * phix 账号界面（account-ui.js）的契约测试。
 *
 * 用户 2026-09-28 要求：整体模仿微软的首次开机流程 —— 设置页里的账号卡片、
 * 占满窗口的登录/注册、登录后问「本地覆盖云端 / 云端覆盖本地」、
 * 选完先显示「我们正在为你准备你的软件」再进软件；**PHL 与 PHL Lite 用同一套界面**。
 *
 * 这里只做静态断言（界面本身由浏览器渲染验证），重点是三件事：
 *   1. 该有的界面元素与文案都在；
 *   2. PHL 与 PHL Lite 的那份 account-ui.js **字节完全相同**（共用一套）；
 *   3. 宿主桥（account-bridge.js）把 CONTRACT 的每个方法都实现了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HERE = path.resolve(__dirname, '..');
const UI = fs.readFileSync(path.join(HERE, 'src/account-ui.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(HERE, 'src/account-bridge.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(HERE, 'electron/preload.cjs'), 'utf8');
const APP = fs.readFileSync(path.join(HERE, 'src/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(HERE, 'src/index.html'), 'utf8');
/**
 * PHL Lite 的那一份 account-ui.js。
 *
 * 两个仓库不一定是兄弟目录（本机是 D:\phl-dev\PH-Launcher 与 D:\phl-lite-dev），
 * 所以按候选路径找，找不到时**明确报出来**而不是静默跳过 ——
 * "两端共用同一套登录界面"正是这个测试要守住的东西。
 */
function liteCopy() {
  const candidates = [
    process.env.PHL_LITE_DIR && path.join(process.env.PHL_LITE_DIR, 'ui/account-ui.js'),
    path.resolve(HERE, '..', 'phl-lite-dev', 'ui', 'account-ui.js'),
    path.resolve(HERE, '..', '..', 'phl-lite-dev', 'ui', 'account-ui.js'),
    'D:/phl-lite-dev/ui/account-ui.js',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

test('账号卡片：已登录显示资料卡片 + 退出登录，未登录显示占位头像 + 登录', () => {
  assert.match(UI, /paui-account-card/, '要有账号卡片');
  assert.match(UI, /paui-avatar.+placeholder|placeholder.+paui-avatar/, '未登录要有占位头像');
  assert.match(UI, /账号未登录/, '未登录文案');
  assert.match(UI, /退出登录/, '已登录要有退出登录');
  assert.match(UI, /platformChips/, '要显示各平台的账号名与登录情况');
});

test('登录界面占满窗口：账号密码 + 「没有账号？去注册」 + 右上角「暂时跳过」', () => {
  assert.match(UI, /\.paui-root\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/, '要占满整个窗口');
  assert.match(UI, /viewLogin/, '要有登录页');
  assert.match(UI, /没有账号？/, '下面那行小字');
  assert.match(UI, /去注册/, '点它可以跳注册');
  assert.match(UI, /暂时跳过/, '右上角的跳过');
  assert.match(UI, /viewRegister/, '要有注册页');
  assert.match(UI, /注册成功，请登录|open\('login'\)/, '注册完要跳回登录页');
});

test('登录后问方向，选完先显示「正在准备」再进软件', () => {
  assert.match(UI, /本地覆盖云端/, '方向一');
  assert.match(UI, /云端覆盖本地/, '方向二');
  assert.match(UI, /open\('direction'\)/, '登录之后要问一次方向');
  assert.match(UI, /我们正在为你准备你的软件/, '微软那种准备页');
  assert.match(UI, /paui-step/, '要有逐项进度');
  assert.match(UI, /viewPrepare/, '准备页');
  // 准备页必须出现在方向选择之后，而不是直接关掉界面
  assert.match(UI, /startPrepare\(direction\)/, '选完方向进入准备流程');
});

test('首次打开软件也走同一套流程', () => {
  assert.match(UI, /async firstRun\(options\)/, '要有 firstRun');
  assert.match(APP, /AccountUI\?\.firstRun|AccountUI\?\.login/, '启动时要调用它');
  assert.match(HTML, /account-ui\.js/, 'index.html 要加载界面模块');
  assert.match(HTML, /account-bridge\.js/, 'index.html 要加载宿主桥');
});

test('宿主桥把 CONTRACT 的每个方法都实现了', () => {
  for (const method of ['status', 'probe', 'login', 'register', 'logout', 'sync',
    'preparePlan', 'prepareStep', 'saveProfile']) {
    assert.match(BRIDGE, new RegExp(`\\b${method}\\s*\\(`), `桥缺 ${method}`);
  }
  assert.match(BRIDGE, /window\.AccountUI\.init\(\{ bridge \}\)/, '要初始化界面');
  assert.match(PRELOAD, /preparePlan: \(\) => ipcRenderer\.invoke\('phix:prepare-plan'\)/,
    'preload 要暴露准备步骤');
  assert.match(PRELOAD, /prepareStep: \(id\) => ipcRenderer\.invoke\('phix:prepare-step', id\)/,
    'preload 要暴露单步执行');
});

test('PHL 与 PHL Lite 用的是同一份 account-ui.js（字节相同）', () => {
  const lite = liteCopy();
  if (!lite) {
    assert.fail('找不到 PHL Lite 的 ui/account-ui.js；'
      + '可用环境变量 PHL_LITE_DIR 指定 PHL Lite 仓库根目录');
  }
  const a = fs.readFileSync(path.join(HERE, 'src/account-ui.js'));
  const b = fs.readFileSync(lite);
  assert.equal(a.length, b.length, `两份长度不同（${a.length} vs ${b.length}）—— 改了一边没同步另一边`);
  assert.ok(a.equals(b), '两份内容不同 —— PHL 与 PHL Lite 必须共用同一套登录界面');
});

test('同步方向真的传到了同步引擎（prefer）', () => {
  const cloudsync = fs.readFileSync(path.join(HERE, 'electron/cloudsync.cjs'), 'utf8');
  const session = fs.readFileSync(path.join(HERE, 'electron/phix-session.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(HERE, 'electron/main.cjs'), 'utf8');
  assert.match(cloudsync, /function applyPreference\(/, '要有 applyPreference');
  assert.match(cloudsync, /applyPreference\(name, prefer, local, remote/, '合并处要调用它');
  assert.match(cloudsync, /async _syncOne\(name, remoteEntry, stateEntry, dryRun, prefer/, '_syncOne 要接收 prefer');
  assert.match(session, /prefer: options\.prefer/, '会话层要往下传');
  assert.match(main, /prefer: input\?\.prefer === 'local'/, 'IPC 要接受 prefer');
  assert.match(cloudsync, /isBlank\(winner\) \|\| isBlank\(loser\)/, '空的一边不许覆盖另一边');
});

test('准备阶段会把课表/日程/学校账号也缓存好（不只是同步对象）', () => {
  const main = fs.readFileSync(path.join(HERE, 'electron/main.cjs'), 'utf8');
  for (const id of ['accounts', 'school', 'timetable', 'calendar', 'profile']) {
    assert.match(main, new RegExp(`id: '${id}'`), `准备步骤缺 ${id}`);
  }
  assert.match(main, /startupSchoolSync\(\{ force: true \}\)/, '要真的去登录学校账号');
});
