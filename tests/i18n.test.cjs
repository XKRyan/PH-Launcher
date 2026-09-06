'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function harness(markup = '') {
  const { window } = parseHTML(`<html><body>${markup}</body></html>`);
  const context = { window, document: window.document, console, queueMicrotask };
  for (const file of ['locales/en.js','i18n.js']) vm.runInNewContext(fs.readFileSync(require.resolve('../src/'+file),'utf8'),context);
  window.i18n.mount('zh-CN');
  return { window, document: window.document, i18n: window.i18n };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('language round trips preserve original nodes, listeners, field values and option IDs', () => {
  const { document, window, i18n } = harness('<button id="save"> 保存 </button><input value="保存" placeholder="密码"><select><option>设置</option></select>');
  const button=document.querySelector('button'); let calls=0; button.addEventListener('click',()=>calls++);
  i18n.apply('en');
  assert.equal(button.textContent,' Save ');
  assert.equal(document.querySelector('input').value,'保存');
  assert.equal(document.querySelector('input').placeholder,'Password');
  assert.equal(document.querySelector('option').value,'设置');
  assert.equal(document.querySelector('option').textContent,'Settings');
  button.dispatchEvent(new window.Event('click'));
  i18n.apply('zh-CN'); i18n.apply('en'); i18n.apply('zh-CN');
  assert.equal(button.textContent,' 保存 '); assert.equal(calls,1);
});
test('dynamic interface nodes and attributes translate without translating user material', async () => {
  const { document, i18n } = harness('<div id="root"></div><p class="chat-bubble">设置</p><div class="vocab-meaning">保存</div><p data-i18n-ignore>关闭</p><textarea>密码</textarea>');
  i18n.apply('en');
  document.querySelector('#root').innerHTML='<button title="关闭">保存</button>';
  await tick();
  const b=document.querySelector('button'); assert.equal(b.textContent,'Save'); assert.equal(b.title,'Close');
  b.textContent='取消'; await tick(); assert.equal(b.textContent,'Cancel');
  i18n.apply('zh-CN'); assert.equal(b.textContent,'取消');
  i18n.apply('en');
  assert.equal(document.querySelector('.chat-bubble').textContent,'设置');
  assert.equal(document.querySelector('.vocab-meaning').textContent,'保存');
  assert.equal(document.querySelector('textarea').textContent,'密码');
  assert.equal(document.querySelector('[data-i18n-ignore]').textContent,'关闭');
});
test('translation is anchored, text-only and unknown phrases are unchanged', () => {
  const { document,window,i18n }=harness('<p>保存</p>');
  window.PH_EN.exact['保存']='<img src=x onerror=alert(1)>';
  i18n.apply('en');
  assert.equal(document.querySelector('p').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(document.querySelector('img'),null);
  assert.equal(i18n.t('3 分钟'),'3 minutes');
  assert.equal(i18n.t('我的笔记包含 3 分钟 和其他内容'),'我的笔记包含 3 分钟 和其他内容');
});
test('language setting saves through dedicated IPC and rolls back the control on failure', async () => {
  const { document,window,i18n }=harness('<section data-settings-panel="general"></section>');
  const calls=[];
  window.ph={settings:{setLanguage:async language=>{ calls.push(language); return {language}; }}};
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value || this.querySelector('option')?.value || '';},set(value){for(const option of this.querySelectorAll('option')) option.toggleAttribute('selected',option.value===value);}});
  i18n.settings(); const select=document.querySelector('#interfaceLanguage');
  // Linkedom only provides a getter for select.value; emulate the browser setter.
  Object.defineProperty(select,'value',{value:'en',writable:true,configurable:true});
  select.dispatchEvent(new window.Event('change')); await tick();
  assert.deepEqual(calls,['en']); assert.equal(i18n.locale(),'en'); assert.equal(select.disabled,false);
  window.ph.settings.setLanguage=async()=>{ throw Error('disk full'); };
  select.value='zh-CN'; select.dispatchEvent(new window.Event('change')); await tick();
  assert.equal(i18n.locale(),'en'); assert.equal(select.value,'en');
});
