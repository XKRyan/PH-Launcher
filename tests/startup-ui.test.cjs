const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const source = fs.readFileSync(require.resolve('../src/startup-ui.js'), 'utf8');
function harness(failSite, now) {
  const { window } = parseHTML('<html><body><p id="startupSyncStatus"></p></body></html>');
  const calls = [];
  window.ph = { school: { sync: async (site, options) => { calls.push([site, options]); if(site==='edupage') assert.match(options.weekStart, /^\d{4}-\d{2}-\d{2}$/); if(site===failSite) throw Error('private provider details'); return {}; } } };
  window.mailUI = { open: async () => { calls.push(['mail']); return true; } };
  window.schoolUI = { refresh: async () => {} };
  const Clock = class extends Date { constructor(...args) { super(...(args.length ? args : [now || Date.now()])); } };
  vm.runInNewContext(source,{window,document:window.document,Date:Clock});
  return {window,calls};
}
test('startup sync reads each saved account once without a force login or UI navigation',async()=>{
  const {window,calls}=harness('managebac');
  const accounts={edupage:{saved:true},managebac:{saved:true},mail:{saved:true}};
  const result=await window.startupSyncUI.run({accounts});
  await window.startupSyncUI.run({accounts});
  assert.equal(calls.length,3); assert.equal(calls[0][1].force,false);
  assert.equal(result.filter(r=>r.ok).length,2);
  assert.match(window.document.body.textContent,/课程未更新/);
  assert.doesNotMatch(window.document.body.textContent,/private provider/);
});
test('startup sync respects opt out and never probes unsaved accounts',async()=>{
  const {window,calls}=harness();
  await window.startupSyncUI.run({enabled:false,accounts:{edupage:{saved:true}}});
  assert.equal(calls.length,0);
  await window.startupSyncUI.run({accounts:{mail:{saved:true}}});
  assert.deepEqual(calls,[['mail']]);
});

test('global text uses accessible default and no obsolete clean-display controls remain',()=>{
  const html=fs.readFileSync(require.resolve('../src/index.html'),'utf8');
  assert.doesNotMatch(html,/siteCleanToggle|简洁显示|语境背词/);
  assert.match(html,/startupSyncSetting/);
  const css=fs.readFileSync(require.resolve('../src/styles.css'),'utf8');
  assert.doesNotMatch(css,/font-size:\s*(?:[0-9]|1[01])px/);
});

test('startup EduPage request includes Shanghai Monday across UTC and year boundaries',async()=>{
  for (const [now, monday] of [['2026-09-06T23:30:00Z','2026-09-07'],['2025-12-31T18:00:00Z','2025-12-29']]) {
    const {window,calls}=harness(null,now);
    const result=await window.startupSyncUI.run({accounts:{edupage:{saved:true}}});
    assert.equal(result[0].ok,true);
    assert.equal(calls[0][1].weekStart,monday);
  }
});
