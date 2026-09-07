const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
test('global font size defaults to 16, preserves valid saved sizes, and rejects invalid values',()=>{
  const {window}=parseHTML('<html><body><div id="appearanceSettings"></div></body></html>');
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/appearance-ui.js'),'utf8'),{window,document:window.document});
  window.appearanceUI.apply();window.appearanceUI.render();
  assert.equal(window.document.documentElement.style.fontSize,'16px');
  assert.match(window.document.querySelector('#appearanceSettings').textContent,/全局字号/);
  assert.match(window.document.querySelector('#appearanceSettings').textContent,/默认 16 px/);
  assert.deepEqual([...window.document.querySelectorAll('#appearanceScale option')].map((option) => Number(option.value)),[14,16,18,20,22,24]);
  window.appearanceUI.apply({fontSize:18});assert.equal(window.document.documentElement.style.fontSize,'18px');
  window.appearanceUI.apply({fontSize:24});assert.equal(window.document.documentElement.style.fontSize,'24px');
  window.appearanceUI.apply({fontSize:999});assert.equal(window.document.documentElement.style.fontSize,'16px');
});
