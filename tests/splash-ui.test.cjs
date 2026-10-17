"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const source = fs.readFileSync(require.resolve("../src/splash-ui.js"), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ finished = false, bars = {}, startedAgoMs = 0 } = {}) {
  // 2026-09-20 用户要求：三端统一成"开机画面"——墨绿底、中间 logo、
  // 下面**一根**细进度条、没有任何文字。
  const { window } = parseHTML(`<!doctype html><html><body class="is-splash">
    <div class="splash-screen" id="splashScreen">
      <div class="splash-logo" aria-hidden="true"><svg width="96" height="96"></svg></div>
      <div class="splash-bar" role="progressbar" aria-label="启动进度"><div class="splash-bar-fill" id="splashProgress"></div></div>
    </div>
  </body></html>`);
  const listeners = { progress: [], done: [] };
  window.__phSplashStartedAt = Date.now() - startedAgoMs;
  window.ph = {
    system: {
      splashState: async () => ({ finished, bars }),
      onSplashProgress: (callback) => { listeners.progress.push(callback); return () => {}; },
      onSplashDone: (callback) => { listeners.done.push(callback); return () => {}; },
    },
  };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date, Number, Object, Array, String, Math, JSON });
  return {
    window,
    document: window.document,
    emitProgress: (payload) => listeners.progress.forEach((callback) => callback(payload)),
    emitDone: (payload) => listeners.done.forEach((callback) => callback(payload)),
  };
}

const width = (document) => document.getElementById('splashProgress').style.width;
const isLoaded = (document) => document.body.classList.contains("loaded");

test("the splash stays until every preload bar finishes", async () => {
  const ui = harness();
  let revealed = 0;
  ui.window.splashUI.ready(() => { revealed += 1; });
  ui.emitProgress({ bar: "school", percent: 100, label: "学校数据已就绪" });
  ui.emitProgress({ bar: "mail", percent: 100, label: "收件箱已同步" });
  await wait(1100);
  assert.equal(isLoaded(ui.document), false, "two of three bars is not enough");
  assert.equal(revealed, 0);

  ui.emitProgress({ bar: "preload", percent: 100, label: "界面已预载" });
  ui.emitDone({ bars: { school: { percent: 100 }, mail: { percent: 100 }, preload: { percent: 100 } } });
  await wait(1100);
  assert.equal(isLoaded(ui.document), true);
  assert.equal(revealed, 1, "the reveal callback runs exactly once");
});

test("只有一根进度条：宽度 = 三件真实工作的平均值，全程没有文字", () => {
  const ui = harness();
  ui.window.splashUI.mount();
  ui.emitProgress({ bar: "school", percent: 42, label: "课表已更新" });
  // 42/0/0 的平均 = 14%
  assert.equal(width(ui.document), "14%");
  ui.emitProgress({ bar: "school", percent: 100, label: "学校数据已就绪" });
  ui.emitProgress({ bar: "mail", percent: 100, label: "收件箱已同步" });
  assert.equal(width(ui.document), "66.66666666666667%", "三件里两件好了就是 2/3");
  ui.emitProgress({ bar: "preload", percent: 100, label: "界面已预载" });
  assert.equal(width(ui.document), "100%");
  ui.window.splashUI.reveal();
});

test("开机画面上一个字都没有（只有 logo 和那根条）", () => {
  const ui = harness();
  const screen = ui.document.getElementById('splashScreen');
  assert.equal(screen.textContent.trim(), '', '启动画面里不能有任何文字');
  assert.ok(screen.querySelector('.splash-logo svg'), '中间要有 logo');
  assert.equal(screen.querySelectorAll('.splash-bar').length, 1, '只有一根进度条');
  const html = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
  const splash = html.slice(html.indexOf('id="splashScreen"'), html.indexOf('<svg class="svg-sprite"'));
  assert.ok(!/>[^<]*[\u4e00-\u9fa5]/.test(splash), '启动画面的标记里不许出现中文文案');
  const css = fs.readFileSync(require.resolve('../src/styles.css'), 'utf8');
  // 墨绿是**写死**的 #102d25（三端同一个值），不跟外观主题走 ——
  // 否则用户换主题时开机画面会变，和右上角那块窗口控件底色对不上。
  assert.match(css, /\.splash-screen \{[^}]*background: #102d25/, '墨绿底');
  const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  assert.match(main, /const SPLASH_INK = '#102d25'/, '窗口控件那块底色用同一个墨绿');
});

test("进度条走到 100% 之后先停半秒再淡出（用户要求：要看得见条走完）", async () => {
  // startedAgoMs 让"最短显示 900ms"这条约束不再挡路，剩下的就只有那 500ms 停顿。
  const ui = harness({ startedAgoMs: 5000 });
  ui.window.splashUI.ready();
  ui.emitProgress({ bar: "school", percent: 100 });
  ui.emitProgress({ bar: "mail", percent: 100 });
  ui.emitProgress({ bar: "preload", percent: 100 });
  ui.emitDone({ bars: { school: { percent: 100 }, mail: { percent: 100 }, preload: { percent: 100 } } });
  assert.equal(width(ui.document), "100%");
  await wait(250);
  assert.equal(isLoaded(ui.document), false, "刚走完不该立刻淡出（半秒内还在停着）");
  await wait(500);
  assert.equal(isLoaded(ui.document), true, "半秒之后才开始淡出");
});

test("progress emitted before the renderer mounts is recovered from main", async () => {
  const ui = harness({
    finished: true,
    bars: { school: { percent: 100 }, mail: { percent: 100 }, preload: { percent: 100 } },
  });
  ui.window.splashUI.ready();
  await wait(60);
  assert.equal(width(ui.document), "100%", "the initial state is fetched");
  await wait(1100);
  assert.equal(isLoaded(ui.document), true, "an already finished preload reveals immediately");
});

test("点一下开机画面（或到 25 秒硬上限）就进去", async () => {
  const ui = harness();
  ui.window.splashUI.ready();
  await wait(50);
  ui.document.getElementById("splashScreen").dispatchEvent(new ui.window.Event("click", { bubbles: true }));
  await wait(20);
  assert.equal(isLoaded(ui.document), true, "点一下就进（原来那个写着「跳过」的按钮去掉了）");

  const capped = harness();
  capped.window.splashUI.ready();
  capped.window.splashUI.reveal();
  assert.equal(isLoaded(capped.document), true);
});

test("a missing splash bridge never traps the user", async () => {
  const { window } = parseHTML('<!doctype html><html><body class="is-splash"><div id="splashScreen"></div></body></html>');
  window.__phSplashStartedAt = Date.now();
  window.ph = {};
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date, Number, Object, Array, String, Math, JSON });
  window.splashUI.ready();
  await wait(30);
  window.splashUI.reveal();
  assert.equal(window.document.body.classList.contains("loaded"), true);
});
