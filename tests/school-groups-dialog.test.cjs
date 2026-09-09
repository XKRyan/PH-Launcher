"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const weekStart = "2026-09-07";

function lesson(date, start, course, groupKey, groups, teacher, room) {
  return { id: `${course}-${groupKey}-${start}`, date, start, end: `${start.slice(0, 2)}:45`, course, teacher, room, groups, groupKey, cancelled: false };
}

// Two subjects: 数学 has two groups (one teacher each), 班会 has one.
function snapshot(selectedGroups = []) {
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
  assert.match(rows[0].textContent, /时间 2026-09-07 08:00–08:45/);
});

test("native courses and homeroom are checked by default on a fresh profile", async () => {
  const ui = harness(snapshot([]));
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
