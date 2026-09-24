"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 本周一。原来这里写死 `2026-09-07`，而 school-ui 打开课表时读的是**当前这一周**
 * （`state.week = monday()`），于是过了一周这份 fixture 就变成"另一周的数据"：
 * `currentWeek()` 取不到 → 界面走空态 → `[data-school-action="groups"]` 根本不存在，
 * 6 个用例集体报 `missing [data-school-action="groups"]`（典型的定时炸弹测试）。
 * 改成按当天算，任何时候跑都是同一周。
 */
const weekStart = (() => {
  const now = new Date();
  const offset = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
})();

function lesson(date, start, course, groupKey, groups, teacher, room) {
  return { id: `${course}-${groupKey}-${start}`, date, start, end: `${start.slice(0, 2)}:45`, course, teacher, room, groups, groupKey, cancelled: false };
}

// Two subjects: 数学 has two groups (one teacher each), 班会 has one.
function snapshot(selectedGroups = null) {
  const options = [
    { key: "g-math-a", course: "Mathematics", teacher: "Ms A", groups: ["A"], label: "Mathematics · A · Ms A", rooms: ["A301"], times: [`${weekStart} 08:00–08:45`] },
    { key: "g-math-b", course: "Mathematics", teacher: "Mr B", groups: ["B"], label: "Mathematics · B · Mr B", rooms: ["B202"], times: [`${weekStart} 09:00–09:45`] },
    { key: "g-eng-native", course: "English Native", teacher: "Ms C", groups: ["N"], label: "English Native · N · Ms C", rooms: ["C101"], times: [`${weekStart} 10:00–10:45`] },
    { key: "g-homeroom", course: "班会", teacher: "Mr D", groups: ["H"], label: "班会 · H · Mr D", rooms: ["D1"], times: [`${weekStart} 11:00–11:45`] },
  ];
  return {
    edupage: { weekStart, accountKey: "acc-1", fetchedAt: new Date().toISOString(), options, missingDates: [], warnings: [], lessons: [lesson(weekStart, "08:00", "Mathematics", "g-math-a", ["A"], "Ms A", "A301")] },
    managebac: null,
    preferences: { accountKey: "acc-1", groups: selectedGroups },
    status: {},
  };
}

function harness(snapshotValue) {
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  const document = window.document;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  let current = snapshotValue;
  const calls = { preferences: [] };
  const api = {
    get: async () => current,
    sync: async () => current,
    login: async () => ({ ok: true, snapshot: current }),
    preferences: async (change) => { calls.preferences.push(change); current = { ...current, preferences: { ...current.preferences, ...change } }; return current; },
  };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, openSite: async () => {} }, document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/school-selection-inference.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/course-order.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/school-ui.js"), "utf8"), context);
  return { context, window, document, calls };
}

const click = (window, document, selector) => {
  const node = document.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  node.dispatchEvent(new window.Event("click", { bubbles: true }));
  return node;
};

async function openGroups(ui) {
  ui.context.window.schoolUI.open("timetable");
  await settle();
  // `open()` 会先渲染、再异步 `refresh()`（拿快照 + 建周缓存），所以第一次 tick 时
  // 工具条还是空态。等到「选择教学组」真的出现再点，别靠固定 tick 数赌时序。
  for (let i = 0; i < 8 && !ui.document.querySelector('[data-school-action="groups"]'); i += 1) await settle();
  click(ui.window, ui.document, '[data-school-action="groups"]');
  await settle();
  return ui.document.querySelector("dialog");
}

test("teaching groups are grouped by subject and collapsed by default", async () => {
  const ui = harness(snapshot());
  const dialog = await openGroups(ui);
  const groups = [...dialog.querySelectorAll("[data-school-subject-group]")];
  assert.equal(groups.length, 3, "one section per subject: English Native, Mathematics, 班会");
  assert.deepEqual(groups.map((group) => group.querySelector("summary strong").textContent).sort(), ["English Native", "Mathematics", "班会"].sort(), "one section per subject");
  assert.equal(groups.every((group) => !group.hasAttribute("open")), true, "sections start collapsed");
  assert.match(groups.find((group) => group.dataset.subject === "Mathematics").querySelector("summary").textContent, /2 个教学组/);
});

test("expanding a subject shows its teaching groups with teacher, room and time", async () => {
  const ui = harness(snapshot());
  const dialog = await openGroups(ui);
  const math = dialog.querySelector('[data-school-subject-group][data-subject="Mathematics"]');
  math.setAttribute("open", "");
  const rows = [...math.querySelectorAll("[data-school-group-option]")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /A/);
  assert.match(rows[0].textContent, /Ms A/);
  assert.match(rows[0].textContent, /教室 A301/);
  // 断言跟着 fixture 的周走，别写死日期（同 weekStart 的理由）。
  assert.match(rows[0].textContent, new RegExp(`时间 ${weekStart.replace(/-/g, "\\-")} 08:00`));
});

test("native courses and homeroom are checked by default on a fresh profile", async () => {
  const ui = harness(snapshot());
  const dialog = await openGroups(ui);
  const checked = [...dialog.querySelectorAll('[name="school-group"]:checked')].map((input) => input.value);
  assert.deepEqual(checked.sort(), ["g-eng-native", "g-homeroom"], "only native + homeroom start checked");
});

test("an existing selection wins over the defaults", async () => {
  const ui = harness(snapshot(["g-math-b"]));
  const dialog = await openGroups(ui);
  const checked = [...dialog.querySelectorAll('[name="school-group"]:checked')].map((input) => input.value);
  assert.deepEqual(checked, ["g-math-b"]);
});

test("an explicit empty selection stays empty when reopening the dialog", async () => {
  const ui = harness(snapshot([]));
  const dialog = await openGroups(ui);
  assert.equal(dialog.querySelectorAll('[name="school-group"]:checked').length, 0);
});

test("automatic inference does not recheck a course explicitly removed by the user", async () => {
  const fixture = snapshot(["g-math-b"]);
  fixture.edupage.personalGroupKeys = ["g-math-a", "g-homeroom"];
  fixture.edupage.personalGroupSource = 'authenticated-personal-groups';
  const ui = harness(fixture);
  // Isolate the UI decision from the inference algorithm's source whitelist.
  ui.context.window.schoolSelectionInference = { ...ui.context.window.schoolSelectionInference, inferTeachingGroups: () => ({ status: 'automatic', keys: ['g-math-a', 'g-homeroom'], ambiguous: [], unmatched: [] }) };
  const dialog = await openGroups(ui);
  const checked = [...dialog.querySelectorAll('[name="school-group"]:checked')].map(input => input.value);
  assert.deepEqual(checked, ['g-math-b']);
});

test("search filters rows, opens matching subjects and hides empty ones", async () => {
  const ui = harness(snapshot());
  const dialog = await openGroups(ui);
  const search = dialog.querySelector('[data-school-field="group-query"]');
  search.value = "B202";
  search.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await settle();
  const visibleGroups = [...dialog.querySelectorAll("[data-school-subject-group]")].filter((group) => !group.hidden);
  assert.equal(visibleGroups.length, 1, "only the subject with a matching room stays visible");
  assert.equal(visibleGroups[0].dataset.subject, "Mathematics");
  assert.equal(visibleGroups[0].open, true, "a match opens the subject");
  assert.match(dialog.querySelector(".school-group-count").textContent, /显示 1 项/);
});

test("saving keeps the chosen teaching groups", async () => {
  const ui = harness(snapshot());
  const dialog = await openGroups(ui);
  const mathB = dialog.querySelector('input[value="g-math-b"]');
  mathB.checked = true;
  mathB.setAttribute("checked", "");
  click(ui.window, ui.document, '[data-school-action="save-groups"]');
  await settle();
  assert.equal(ui.calls.preferences.length, 1);
  assert.deepEqual([...ui.calls.preferences[0].groups].sort(), ["g-eng-native", "g-homeroom", "g-math-b"]);
});
