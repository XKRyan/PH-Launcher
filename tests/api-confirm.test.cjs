const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
function harness() {
  const {window}=parseHTML('<html><body></body></html>');
  window.HTMLElement.prototype.showModal=function(){this.open=true;};
  window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  let language='zh-CN';window.i18n={locale:()=>language};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/api-confirm.js'),'utf8'),{window,document:window.document});
  return {window,dialog:()=>window.document.querySelector('dialog'),setLanguage(value){language=value;window.dispatchEvent(new window.Event('ph:language-changed'));}};
}
test('API consent is an in-app modal, bilingual and cancelled by Escape',async()=>{
  const h=harness(),p=h.window.confirmApiDisclosure();
  assert.ok(h.dialog().classList.contains('modal')); assert.match(h.dialog().textContent,/取消/);
  h.setLanguage('en'); assert.match(h.dialog().textContent,/Cancel/);
  h.dialog().dispatchEvent(new h.window.Event('cancel',{cancelable:true}));
  assert.equal(await p,false);assert.equal(h.dialog(),null);
});
test('only explicit confirmation succeeds; concurrent requests and close fail safely',async()=>{
  const h=harness(),p=h.window.confirmApiDisclosure();
  assert.equal(await h.window.confirmApiDisclosure(),false);
  h.dialog().querySelector('[data-accept]').onclick();assert.equal(await p,true);
  const next=h.window.confirmApiDisclosure();h.dialog().querySelector('[data-dismiss]').onclick();assert.equal(await next,false);
});
test('send path awaits consent and invalidates changed context without native confirm',()=>{
  const source=fs.readFileSync(require.resolve('../src/app.js'),'utf8');
  const flow=source.slice(source.indexOf('async function sendAiMessage()'),source.indexOf('async function sendAiMessage()')+2500);
  assert.match(flow,/await window.confirmApiDisclosure/); assert.match(flow,/before !== signature\(\)/);
  assert.doesNotMatch(flow,/window.confirm\(/);
});
test('delete confirmation uses text safely and never executes markup',async()=>{
  const h=harness(); const p=h.window.confirmAction('Delete <img src=x>?');
  assert.equal(h.dialog().querySelector('img'),null);
  assert.equal(h.dialog().querySelector('p').textContent,'Delete <img src=x>?');
  h.dialog().querySelector('[data-cancel]').onclick(); assert.equal(await p,false);
});
