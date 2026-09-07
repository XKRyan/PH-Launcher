const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const main = read('electron', 'main.cjs');
const preload = read('electron', 'preload.cjs');
const renderer = read('src', 'app.js');

test('school plan imports update only the schedule, preserving pending renderer edits', () => {
  const importPlan = main.slice(main.indexOf('function importSchoolPlan()'), main.indexOf('function enrichVocabularyEntries('));
  assert.match(importPlan, /sendToRenderer\('school:plan-imported', next\)/);
  assert.doesNotMatch(importPlan, /publishDataChange\(\)/);
  assert.match(preload, /onPlanImported:\s*\(callback\)\s*=>\s*on\('school:plan-imported', callback\)/);
  assert.match(renderer, /window\.ph\.school\.onPlanImported\(\(schedule\)\s*=>\s*\{\s*state\.data\.schedule\s*=\s*schedule;/);

  // This mirrors the save reconciliation: a remote response may update only
  // fields unchanged since submission, so typing while an IPC save is pending
  // cannot be overwritten by the older response.
  const submitted = { notes: [{ body: 'before import' }], schedule: [] };
  const current = { notes: [{ body: 'still typing' }], schedule: [] };
  const saved = { notes: [{ body: 'before import' }], schedule: [{ id: 'dated-lesson' }] };
  for (const key of Object.keys(saved)) {
    if (JSON.stringify(current[key]) === JSON.stringify(submitted[key])) current[key] = saved[key];
  }
  assert.equal(current.notes[0].body, 'still typing');
  assert.deepEqual(current.schedule, [{ id: 'dated-lesson' }]);
});

test('opening a school portal invalidates that source and pending automatic logins', () => {
  const invalidator = main.slice(main.indexOf('function invalidateSchoolSnapshots(source)'), main.indexOf('async function syncSchool('));
  const showSite = main.slice(main.indexOf('async function showSite('), main.indexOf('function hideSites()'));
  assert.match(invalidator, /schoolState\.invalidate\(source\)/);
  assert.match(invalidator, /schoolAuthenticator\?\.invalidate\(site\)/);
  assert.match(showSite, /if \(SITE_IDS\.includes\(siteId\)\) invalidateSchoolSnapshots\(siteId\)/);
});

test('calendar and course reminders share a rolling scheduler without clearing dedupe each tick', () => {
  const reminder = main.slice(main.indexOf('function scheduleReminderTick()'), main.indexOf('function runCommand('));
  assert.match(reminder, /reminderScheduler\.syncCalendar/);
  assert.match(reminder, /reminderScheduler\.syncGroup\('course:'/);
  assert.doesNotMatch(reminder, /fired\.clear|reminderKeys/);
  assert.match(main, /setInterval\(scheduleReminderTick, 15_000\)/);
  assert.match(main, /onCancel:.*reminderWindows/);
});
