'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const pageSource = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');

function harness(ai, messages = []) {
  const { window } = parseHTML(pageSource);
  const calls = { ai: 0, hidden: 0, inputFocus: 0, homeFocus: 0 };
  window.ph = {
    ai: new Proxy({}, { get: () => () => { calls.ai += 1; } }),
    sites: { hide: () => { calls.hidden += 1; } },
  };
  window.document.querySelector('#aiInput').focus = () => { calls.inputFocus += 1; };
  window.document.querySelector('[data-route="today"]').focus = () => { calls.homeFocus += 1; };
  const context = {
    window,
    document: window.document,
    console,
    URL,
    Date,
    Intl,
    crypto: { randomUUID: () => 'test-id' },
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
  };
  vm.runInNewContext(`${appSource}\nrenderDashboard = () => {}; loadHardwareProfile = () => {}; this.__aiNavigation = { state, renderAi, beginAiEditing, handleBodyClick, isAiConfigured };`, context);
  const runtime = context.__aiNavigation;
  runtime.state.data = { settings: { ai: { ...ai } }, tasks: [], schedule: [], focusSessions: [], customSites: [] };
  runtime.state.aiMessages = messages;
  runtime.state.route = 'ai';
  return { window, calls, runtime };
}

function click(window, selector) {
  const node = window.document.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  node.dispatchEvent(new window.Event('click', { bubbles: true }));
}

test('configured AI gets one return-to-chat button that only restores the chat view', () => {
  const originalAi = { enabled: true, provider: 'local', localModel: 'qwen-test', apiModel: '' };
  const messages = [{ role: 'user', content: '保留这段对话' }];
  const ui = harness(originalAi, messages);

  ui.runtime.beginAiEditing();
  ui.runtime.state.data.settings.ai.provider = 'api';
  ui.runtime.state.data.settings.ai.enabled = false;
  ui.runtime.renderAi();
  ui.runtime.renderAi();

  const buttons = ui.window.document.querySelectorAll('#aiBackNavigation');
  assert.equal(buttons.length, 1, 're-render must not duplicate the navigation button');
  assert.equal(buttons[0].textContent, '← 返回对话');
  click(ui.window, '#aiBackNavigation');

  assert.equal(ui.runtime.state.route, 'ai');
  assert.deepEqual({ ...ui.runtime.state.data.settings.ai }, originalAi);
  assert.equal(ui.runtime.state.aiMessages, messages);
  assert.equal(ui.window.document.querySelector('#aiChat').classList.contains('hidden'), false);
  assert.equal(ui.calls.ai, 0, 'returning must not configure, deploy, or chat over IPC');
  assert.equal(ui.calls.inputFocus, 1);
});

test('unconfigured AI returns home instead of opening an unusable chat', () => {
  const ui = harness({ enabled: false, provider: 'off', localModel: '', apiModel: '' });
  ui.runtime.renderAi();
  assert.equal(ui.window.document.querySelector('#aiBackNavigation').textContent, '← 返回首页');

  const localChoice = ui.window.document.querySelector('[data-ai-provider="local"]');
  ui.runtime.handleBodyClick({ target: localChoice });
  click(ui.window, '#aiBackNavigation');

  assert.equal(ui.runtime.state.route, 'today');
  assert.equal(ui.runtime.state.data.settings.ai.provider, 'off');
  assert.equal(ui.calls.ai, 0);
  assert.equal(ui.calls.homeFocus, 1);
});

test('connection status requires enabled provider and its provider-specific model field', () => {
  const ui = harness({ enabled: false, provider: 'local', localModel: 'qwen-test' });
  const configured = ui.runtime.isAiConfigured;
  assert.equal(configured({ enabled: true, provider: 'local', localModel: 'qwen-test' }), true);
  assert.equal(configured({ enabled: true, provider: 'local', apiModel: 'wrong-field' }), false);
  assert.equal(configured({ enabled: true, provider: 'api', apiModel: 'gpt-test' }), true);
  assert.equal(configured({ enabled: true, provider: 'api', localModel: 'wrong-field' }), false);
  assert.equal(configured({ enabled: false, provider: 'api', apiModel: 'gpt-test' }), false);
});

test('agent model label uses apiModel for API connections', () => {
  const source = fs.readFileSync(require.resolve('../src/agent-ui.js'), 'utf8');
  assert.match(source, /ai\.provider === 'api' \? ai\.apiModel/);
  assert.doesNotMatch(source, /ai\.model \|\| ai\.localModel/);
});
