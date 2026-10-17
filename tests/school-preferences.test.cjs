"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

// The renderer's drag-and-drop save was silently dropped because this handler
// has an explicit key whitelist. Test the real function instead of a mock.
const mainSource = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
const start = mainSource.indexOf("function updateSchoolPreferences(input) {");
const end = mainSource.indexOf("\nfunction importSchoolPlan()", start);
assert.ok(start >= 0 && end > start, "updateSchoolPreferences must be extractable");

function harness(initial = {}, options = {}) {
  const state = { data: { settings: { schoolPreferences: { ...initial } } }, saved: 0 };
  const context = {
    COURSE_REMINDER_OPTIONS: [null, 0, 5, 10, 15, 30, 60],
    secureStore: {
      data: state.data,
      save() { state.saved += 1; if (options.saveError) throw new Error('disk full'); },
    },
    schoolCache: { edupage: options.edupage === undefined ? { accountKey: 'acc-1', options: [{ key: 'g1' }, { key: 'g2' }] } : options.edupage },
    scheduleReminderTick() { state.ticked = (state.ticked || 0) + 1; },
    schoolSnapshot: () => ({ preferences: state.data.settings.schoolPreferences }),
  };
  vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.updateSchoolPreferences = updateSchoolPreferences;`, context);
  return { update: context.updateSchoolPreferences, state, context };
}

test("course order from drag-and-drop is persisted and returned", () => {
  const ui = harness();
  const result = ui.update({ courseOrder: ['c3', 'c1', 'c2'] });
  assert.equal(JSON.stringify(ui.state.data.settings.schoolPreferences.courseOrder), JSON.stringify(['c3', 'c1', 'c2']));
  assert.equal(ui.state.saved, 1, "the store is written");
  assert.equal(JSON.stringify(result.preferences.courseOrder), JSON.stringify(['c3', 'c1', 'c2']), "the renderer receives the saved order back");
});

test("course order is sanitised: only short strings, capped at 500", () => {
  const ui = harness();
  const noisy = [...Array(600).keys()].map((index) => `c${index}`);
  ui.update({ courseOrder: ['ok', 42, null, 'x'.repeat(200), ...noisy] });
  const saved = ui.state.data.settings.schoolPreferences.courseOrder;
  assert.equal(saved[0], 'ok');
  assert.equal(saved.includes(42), false, "non-strings are dropped");
  assert.equal(saved.includes(null), false);
  assert.equal(saved.some((id) => id.length >= 120), false, "overlong ids are dropped");
  assert.ok(saved.length <= 500, `capped at 500, got ${saved.length}`);
});

test("course order survives alongside other preference writes", () => {
  const ui = harness({ courseOrder: ['c9'] });
  ui.update({ autoSync: true });
  assert.equal(JSON.stringify(ui.state.data.settings.schoolPreferences.courseOrder), JSON.stringify(['c9']), "unrelated writes keep the order");
  ui.update({ courseOrder: ['c1', 'c9'] });
  assert.equal(ui.state.data.settings.schoolPreferences.autoSync, true, "and the order write keeps other settings");
});

test("a failed save rolls the preference back", () => {
  const ui = harness({ courseOrder: ['c1'] }, { saveError: true });
  assert.throws(() => ui.update({ courseOrder: ['c2', 'c1'] }), /disk full/);
  assert.equal(JSON.stringify(ui.state.data.settings.schoolPreferences.courseOrder), JSON.stringify(['c1']), "memory matches disk after a failed write");
});
