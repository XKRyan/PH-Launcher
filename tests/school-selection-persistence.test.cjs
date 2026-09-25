'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sharedLessons = require('../electron/shared-lessons.cjs');
const sharedSettings = require('../electron/settings-yaml.cjs');
const cs = require('../electron/cloudsync.cjs');
const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const code = main.slice(main.indexOf('function publishSelectedLessons('), main.indexOf('\nfunction importSchoolPlan()'));
const options = [
  { key: 'a', course: 'Physics', teacher: "O'Brien", groups: ['A'] },
  { key: 'b', course: 'Native History', teacher: 'Tutor', groups: [] },
];
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-selection-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.yaml');
  fs.writeFileSync(file, 'version: 1\nui:\n  theme: blue\n');
  const store = { data: { settings: { schoolPreferences: { accountKey: 'test', groups: ['a', 'b'] } } }, save() {} };
  const ctx = { sharedLessons, sharedSettings, sharedSettingsFile: () => file, secureStore: store,
    schoolCache: { edupage: { options, accountKey: 'test' } }, startupMark() {}, scheduleReminderTick() {},
    schoolSnapshot: () => ({ preferences: store.data.settings.schoolPreferences }), console };
  vm.runInNewContext(code, ctx);
  return { ctx, file, store, root };
}
test('deselected mandatory course stays removed after actual publish and repeated re-import', (t) => {
  const { ctx, file, store } = harness(t);
  ctx.updateSchoolPreferences({ groups: ['a'] });
  assert.deepEqual(sharedLessons.readSelection(fs.readFileSync(file, 'utf8')), [{ subject: 'Physics', teacher: "O'Brien", group: 'A' }]);
  for (let i = 0; i < 3; i++) ctx.applySharedLessonSelection();
  assert.equal(JSON.stringify(store.data.settings.schoolPreferences.groups), '["a"]');
  assert.match(fs.readFileSync(file, 'utf8'), /theme: blue/);
});
test('clear all persists as explicit [] and re-import clears stale saved groups', (t) => {
  const { ctx, file, store } = harness(t);
  ctx.updateSchoolPreferences({ groups: [] });
  assert.match(fs.readFileSync(file, 'utf8'), /^lessons: \[\]$/m);
  store.data.settings.schoolPreferences.groups = ['a', 'b'];
  ctx.applySharedLessonSelection();
  assert.equal(JSON.stringify(store.data.settings.schoolPreferences.groups), '[]');
});
test('missing or broken selections never erase saved choices', (t) => {
  const { ctx, file, store } = harness(t);
  for (const text of ['', 'lessons:\n', 'lessons: broken\n', 'lessons:\n- teacher: Missing subject\n']) {
    fs.writeFileSync(file, text);
    ctx.applySharedLessonSelection();
    assert.equal(JSON.stringify(store.data.settings.schoolPreferences.groups), '["a","b"]');
    assert.equal(sharedLessons.readSelection(text), null);
  }
});
test('cloud YAML format and comments preserve selection, including an empty list', (t) => {
  const { file } = harness(t);
  for (const rows of [[{ subject: 'Physics', group: 'A', teacher: "O'Brien" }], []]) {
    cs.writeSettingsSection(file, 'lessons', rows);
    const source = fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
    assert.deepEqual(sharedLessons.readSelection(source), rows);
  }
  assert.deepEqual(sharedLessons.readSelection('lessons:\n# retained comment\n- subject: Physics\n  group: A\n'), [{ subject: 'Physics', group: 'A' }]);
});
test('shared fallback reflects empty selections and never restores mandatory defaults', (t) => {
  const { ctx, file, store } = harness(t);
  const source = main.slice(main.indexOf('function schoolSnapshot('), main.indexOf('\nfunction invalidateSchoolSnapshots('));
  Object.assign(ctx, { credentialStatus: () => ({ sites: {} }), schoolState: { snapshot: () => ({ edupage: null }) },
    schoolSectionFromShared: (site) => site === 'edupage' ? { accountKey: 'shared', options } : null });
  vm.runInNewContext(source, ctx);
  fs.writeFileSync(file, 'lessons: []\n');
  assert.equal(JSON.stringify(ctx.schoolSnapshot().preferences.groups), '[]');
  assert.equal(ctx.schoolSnapshot().preferences.accountKey, 'shared');
  assert.deepEqual(store.data.settings.schoolPreferences.groups, ['a', 'b'], 'read fallback must not mutate local preferences');
});

test('failed shared-file write reports failure and rolls back saved selections', (t) => {
  const { ctx, store } = harness(t);
  ctx.sharedSettings = { ...sharedSettings, atomicWriteFileSync() { throw Error('disk full'); } };
  assert.throws(() => ctx.updateSchoolPreferences({ groups: [] }), /选课保存失败/);
  assert.deepEqual(store.data.settings.schoolPreferences.groups, ['a', 'b']);
});

test('mail contact harvesting exposed by preload is also registered in main', () => {
  const registration = /for \(const name of (\['status', 'list', 'read'[^\n]+)\) \{/.exec(main);
  assert.ok(registration);
  assert.match(registration[1], /'harvestContacts'/);
});
