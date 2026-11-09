/* ============================================================================
 * 全软件一致性审计的回归测试（2026-11-09 第二轮）
 *
 * 第一轮修的是"账号/同步"相关；这轮把同一类问题在全仓库扫了一遍：
 *   · IPC 返回 `{ok,data}` 却被当裸对象用（restore/profile/saveProfile/sync）；
 *   · preload 没暴露、渲染进程却在调用（心履 onStatus/setSettings、本机词典 lookup）；
 *   · 组件 CSS 的 display 覆盖 `hidden` 属性（按钮/行明明 hidden 还显示）；
 *   · CSP 是 script-src 'self'，index.html 里却还有内联脚本；
 *   · 同步失败仍 toast "已同步"。
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HERE = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const APP = read('src/app.js');
const PRELOAD = read('electron/preload.cjs');
const MAIN = read('electron/main.cjs');
const HTML = read('src/index.html');
const STYLES = read('src/styles.css');
const VOCAB = read('src/vocabulary-ui.js');
const COACH = read('src/vocabulary-coach-ui.js');

test('index.html 不再有内联脚本（CSP 允许 script-src self）', () => {
  const inline = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || [];
  assert.deepEqual(inline, [], `发现内联脚本：${inline.join(', ')}`);
  assert.match(HTML, /<script src="\.\/splash-start\.js"><\/script>/, '启动计时改成外部文件');
  const splashStart = read('src/splash-start.js');
  assert.match(splashStart, /window\.__phSplashStartedAt\s*=\s*Date\.now\(\)/);
});

test('所有 hidden 属性都真的隐藏（组件 display 不能覆盖）', () => {
  assert.match(STYLES, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/,
    'styles.css 需要全局 [hidden] 兜底');
});

test('phix restore/profile/saveProfile/sync 的 {ok,data} 包装都被解开', () => {
  assert.match(APP, /function unwrapPhixResult\(result\)/);
  assert.match(APP, /const result = unwrapPhixResult\(await window\.ph\.phix\.restore\(\)\)/,
    '启动恢复必须解包装，否则有令牌也当成未登录');
  assert.match(APP, /const profile = unwrapPhixResult\(await window\.ph\.phix\.profile\(\)\)/,
    '头像读取必须解包装，否则 Profile 有头像也不显示');
  assert.match(APP, /unwrapPhixResult\(await window\.ph\.phix\.saveProfile\(profile\)\)/,
    '保存头像不能把 {ok,data} 写进 Profile');
  assert.match(APP, /loggedIn = status\.data\.logged_in === true/,
    '退出登录后顶栏不能继续显示上一个账号的头像');
  assert.match(APP, /syncResult|sync\.ok === false|sync && sync\.ok === false/,
    '头像同步失败不能提示"已同步"');
});

test('心履：状态变化事件与设置保存都有 preload 桥和主进程广播', () => {
  assert.match(PRELOAD, /onStatus: \(callback\) => on\('xinlv:status', callback\)/);
  assert.match(PRELOAD, /setSettings: \(patch\) => ipcRenderer\.invoke\('xinlv:set-settings', patch\)/);
  assert.match(MAIN, /sendToRenderer\('xinlv:status'/);
  assert.match(MAIN, /XINLV_STATUS_CHANGING\.has\(name\)\) publishXinlvStatus\(\)/);
  assert.match(MAIN, /xinlvHandle\('set-settings'/);
  assert.match(APP, /window\.ph\.xinlv\?\.onChanged\?\.\(\(\) => \{ void refreshXinlvStatus\(\); \}\)/,
    '后台同步后应用外壳的心履状态也要刷新');
});

test('本机词典桥存在；词典数据缺失时返回 available:false，不抛错给界面', () => {
  assert.match(PRELOAD, /dictionary:\s*\{[\s\S]*?lookup: \(word\) => ipcRenderer\.invoke\('dictionary:lookup', word\)/);
  assert.match(MAIN, /ipcMain\.handle\('dictionary:lookup'/);
  assert.match(MAIN, /available: true, \.\.\.offlineDictionary\.lookup\(query\)/);
  assert.match(MAIN, /available: false, query, exact: null/);
  assert.match(VOCAB, /async function lookupOfflineWord\(word\)/);
  assert.match(VOCAB, /lookup\?\.available === false/);
  assert.match(COACH, /dictionaryBridge/);
  assert.match(COACH, /lookup\?\.available === false/);
  // 渲染进程里不能再有"没判断 bridge 存在就直接调用"的写法
  assert.doesNotMatch(VOCAB, /window\.ph\.dictionary\.lookup\(/);
  assert.doesNotMatch(COACH, /window\.ph\.dictionary\.lookup\(/);
});

test('首启引导的"上一步"按钮在第一步真的隐藏（hidden 属性兜底覆盖按钮 display）', () => {
  // 该按钮用 element.hidden 切换；.secondary-button 有 display:inline-flex，
  // 没有全局 [hidden] 规则时第一步会露出来。
  assert.match(APP, /\$\('#onboardingBack'\)\.hidden = state\.onboardingStep === 0/);
  assert.match(STYLES, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
