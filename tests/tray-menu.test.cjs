"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { trayMenu, TRAY_QUICK_ENTRIES } = require("../electron/tray-menu.cjs");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const entries = (menu) => menu.filter((item) => item.type !== "separator");

test("the tray menu offers quick entries that jump to a page", () => {
  const opened = [];
  const menu = trayMenu({ language: "zh-CN", open: () => opened.push("open"), openRoute: (route) => opened.push(route), quit: () => opened.push("quit") });
  const labels = entries(menu).map((item) => item.label);
  assert.equal(labels[0], "打开 PH Launcher");
  assert.equal(labels.at(-1), "退出");
  assert.deepEqual(labels.slice(1, -1), ["今天", "我的课表", "我的课程与作业", "我的日程", "平和邮箱", "心履", "计划"]);
  for (const item of entries(menu).slice(1, -1)) item.click();
  assert.deepEqual(opened, TRAY_QUICK_ENTRIES.map((entry) => entry.route), "every quick entry routes to its page");
});

test("the tray menu localises to English", () => {
  const labels = entries(trayMenu({ language: "en", open() {}, openRoute() {}, quit() {} })).map((item) => item.label);
  assert.equal(labels[0], "Open PH Launcher");
  assert.ok(labels.includes("My timetable"));
  assert.ok(labels.includes("Pinghe Mail"));
  assert.equal(labels.at(-1), "Quit");
});

test("quick entries fall back to opening the window when no router is given", () => {
  const opened = [];
  const menu = trayMenu({ language: "zh-CN", open: () => opened.push("open"), quit() {} });
  entries(menu)[1].click();
  assert.deepEqual(opened, ["open"]);
});

test("tray creation and quit are guarded against duplicate icons", () => {
  assert.match(mainSource, /if \(tray && !tray\.isDestroyed\(\)\) tray\.destroy\(\);/, "createTray destroys a previous tray");
  assert.match(mainSource, /function destroyTray\(\)/, "there is an explicit destroy helper");
  assert.match(mainSource, /app\.on\('will-quit', \(\) => \{[\s\S]{0,200}destroyTray\(\);/, "will-quit destroys the tray so no ghost icon is left");
});

test("a second launch focuses the existing window instead of opening another", () => {
  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /app\.on\('second-instance', \(_event, argv = \[\]\) => \{/);
  assert.match(mainSource, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\);/, "a minimized window is restored");
  assert.match(mainSource, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{ createWindow\(\); return; \}/, "a destroyed window is recreated rather than duplicated");
  assert.match(mainSource, /--route=/, "a requested route is honoured");
});
