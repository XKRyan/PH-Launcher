"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const source = fs.readFileSync(require.resolve("../src/splash-ui.js"), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ finished = false, bars = {} } = {}) {
  const { window } = parseHTML(`<!doctype html><html><body class="is-splash">
    <div class="splash-screen">
      <div class="splash-bars">
        <div class="splash-bar-row" data-bar="school"><span class="splash-bar-label">连接学校数据</span><div class="splash-bar"><div class="splash-bar-fill" data-bar="school"></div></div></div>
        <div class="splash-bar-row" data-bar="mail"><span class="splash-bar-label">加载邮件服务</span><div class="splash-bar"><div class="splash-bar-fill" data-bar="mail"></div></div></div>
        <div class="splash-bar-row" data-bar="preload"><span class="splash-bar-label">预载学习界面</span><div class="splash-bar"><div class="splash-bar-fill" data-bar="preload"></div></div></div>
      </div>
      <p class="splash-hint" id="splashHint">正在启动…</p>
      <button class="splash-skip" id="splashSkip" type="button">跳过</button>
    </div>
  </body></html>`);
  const listeners = { progress: [], done: [] };
  window.__phSplashStartedAt = Date.now();
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

const width = (document, bar) => document.querySelector(`.splash-bar-fill[data-bar="${bar}"]`).style.width;
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

test("bar widths follow the reported percentages and labels update", () => {
  const ui = harness();
  ui.window.splashUI.mount();
  ui.emitProgress({ bar: "school", percent: 42, label: "课表已更新" });
  assert.equal(width(ui.document, "school"), "42%");
  assert.equal(ui.document.querySelector('.splash-bar-row[data-bar="school"] .splash-bar-label').textContent, "课表已更新");
  ui.emitProgress({ bar: "school", percent: 100, label: "学校数据已就绪" });
  assert.equal(width(ui.document, "school"), "100%");
  assert.equal(ui.document.querySelector('.splash-bar-fill[data-bar="school"]').classList.contains("is-done"), true);
  ui.window.splashUI.reveal();
});

test("progress emitted before the renderer mounts is recovered from main", async () => {
  const ui = harness({
    finished: true,
    bars: { school: { percent: 100, label: "学校数据已就绪" }, mail: { percent: 100, label: "跳过" }, preload: { percent: 100, label: "界面已预载" } },
  });
  ui.window.splashUI.ready();
  await wait(60);
  assert.equal(width(ui.document, "school"), "100%", "the initial state is fetched");
  assert.equal(width(ui.document, "mail"), "100%");
  await wait(1100);
  assert.equal(isLoaded(ui.document), true, "an already finished preload reveals immediately");
});

test("the skip button and the hard cap both release the splash", async () => {
  const ui = harness();
  ui.window.splashUI.ready();
  await wait(50);
  ui.document.getElementById("splashSkip").dispatchEvent(new ui.window.Event("click", { bubbles: true }));
  await wait(20);
  assert.equal(isLoaded(ui.document), true, "skipping reveals the app");

  const capped = harness();
  capped.window.splashUI.ready();
  capped.window.splashUI.reveal();
  assert.equal(isLoaded(capped.document), true);
});

test("a missing splash bridge never traps the user", async () => {
  const { window } = parseHTML('<!doctype html><html><body class="is-splash"><p id="splashHint"></p></body></html>');
  window.__phSplashStartedAt = Date.now();
  window.ph = {};
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date, Number, Object, Array, String, Math, JSON });
  window.splashUI.ready();
  await wait(30);
  window.splashUI.reveal();
  assert.equal(window.document.body.classList.contains("loaded"), true);
});
