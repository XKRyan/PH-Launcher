const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
test('plan shows tasks and focus only; retired calendar destination is absent',()=>{
  const {document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
  assert.deepEqual([...document.querySelectorAll('[data-tab-group="plan"] button')].map(b=>b.getAttribute('data-tab')),['tasks','focus']);
  assert.equal(document.querySelector('[data-tab-panel="schedule"]'),null);
  assert.ok(document.querySelector('[data-route="calendar"]'));
});
test('AI instructions distinguish calendar from tasks and retain genuine confirmation',()=>{
  const source=fs.readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.match(source,/Product map: Plan contains only actionable tasks/);
  assert.match(source,/Never substitute create_tasks/);
  assert.match(source,/awaiting_user_confirmation are NOT writes/);
  assert.match(source,/filter\(tool => !\['upsert_schedule', 'list_schedule', 'preview_edupage_timetable'\]/);
});
