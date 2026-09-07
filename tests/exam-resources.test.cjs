const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { resources } = require('../src/exam-resources.js');
test('standardized resources have bilingual descriptions and pinned HTTPS destinations', () => {
  assert.equal(new Set(resources.map(item => item.id)).size, resources.length);
  assert.deepEqual([...new Set(resources.map(item => item.exam))], ['TOEFL','IELTS','SAT','ACT']);
  for (const item of resources) {
    assert.equal(new URL(item.url).protocol, 'https:');
    assert.equal(item.name.length, 2); assert.equal(item.description.length, 2);
    assert.ok(!/[\u3400-\u9fff]/.test(item.name[1] + item.description[1]));
  }
});
test('exam filters round-trip languages and only a user click opens a website', async () => {
  const { window } = parseHTML('<html><body><section id="examResources"></section></body></html>');
  let language = 'zh-CN'; const calls = [];
  window.i18n = { locale: () => language }; window.ph = { system: { openUrl: async url => calls.push(url) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/exam-resources.js'),'utf8'), { window, document: window.document, URL });
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  assert.equal(calls.length, 0);
  window.document.querySelector('[data-exam-filter="SAT"]').click();
  assert.equal(window.document.querySelectorAll('[data-exam-resource]').length, 3);
  language = 'en'; window.dispatchEvent(new window.CustomEvent('ph:language-changed'));
  assert.ok(!/[\u3400-\u9fff]/.test(window.document.body.textContent));
  window.document.querySelector('[data-exam-resource="bluebook"]').click();
  assert.deepEqual(calls, ['https://bluebook.collegeboard.org/students']);
  language = 'zh-CN'; window.dispatchEvent(new window.CustomEvent('ph:language-changed'));
  assert.match(window.document.body.textContent, /标化备考资料/);
});
