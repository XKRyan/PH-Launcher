'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function mount() {
  const { window } = parseHTML('<!doctype html><html><body><section id="studyMateCard"></section></body></html>');
  const calls = [];
  window.ph = {
    system: {
      studyMateStatus: async () => ({ available: true, running: true, path: 'D:\\deepstudy', url: 'http://127.0.0.1:8765' }),
      openStudyMate: async () => { calls.push('open'); return { opened: true, running: true, spawned: false, url: 'http://127.0.0.1:8765' }; },
      openUrl: async () => {},
    },
  };
  const context = { window, document: window.document, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/studymate-ui.js'), 'utf8'), context);
  return { window, calls };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('StudyMate card renders the detected local app and opens it', async () => {
  const { window, calls } = mount();
  await tick();
  const card = window.document.getElementById('studyMateCard');
  assert.match(card.textContent, /StudyMate/);
  assert.match(card.textContent, /deepstudy/);
  const open = card.querySelector('[data-study-action="open"]');
  assert.ok(open);
  assert.equal(open.disabled, false);
  open.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(calls, ['open']);
  assert.match(card.textContent, /浏览器|启动/);
});

test('StudyMate card keeps the button disabled when no install is found', async () => {
  const { window } = parseHTML('<!doctype html><html><body><section id="studyMateCard"></section></body></html>');
  window.ph = { system: { studyMateStatus: async () => ({ available: false, running: false }), openStudyMate: async () => ({ opened: false }) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/studymate-ui.js'), 'utf8'), { window, document: window.document, console, setTimeout, clearTimeout });
  await tick();
  const card = window.document.getElementById('studyMateCard');
  const open = card.querySelector('[data-study-action="open"]');
  assert.equal(open.disabled, true);
  assert.match(card.textContent, /尚未检测到/);
});
