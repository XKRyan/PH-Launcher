const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function harness({ messages = [], busy = false, ai = {} } = {}) {
  const { window } = parseHTML(`<html><body>
    <button type="button" data-agent-mode="chat">聊天</button>
    <button type="button" data-agent-mode="confirm">确认操作</button>
    <button type="button" data-agent-mode="full">完整权限</button>
    <div id="agentSessions"></div>
    <span id="agentModel"></span>
    <button type="button" id="agentNewChat">新会话</button>
    <input type="checkbox" id="aiControlToggle">
    <button type="button" id="agentConfigure">配置</button>
    <button type="button" id="aiEditConfig">编辑配置</button>
  </body></html>`);
  const state = { data: { settings: { ai } }, aiMessages: messages, aiBusy: busy };
  let renderAiCalls = 0;
  window.renderAi = () => { renderAiCalls += 1; };
  const context = { window, document: window.document, state, Event: window.Event, Date };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/agent-ui.js'), 'utf8'), context);
  const click = (selector) => {
    const node = window.document.querySelector(selector);
    assert.ok(node, `missing ${selector}`);
    node.dispatchEvent(new window.Event('click', { bubbles: true }));
  };
  return { window, state, click, get renderAiCalls() { return renderAiCalls; } };
}

test('render derives permission mode and the current session from existing state', () => {
  const ui = harness({
    messages: [{ role: 'user', content: '分析今天的学习任务' }, { role: 'assistant', content: '好的' }],
    ai: { provider: 'local', localModel: 'qwen-test', launcherControlEnabled: true, controlConsentVersion: 1 },
  });
  ui.window.agentUI.render();
  assert.equal(ui.window.document.querySelector('[data-agent-mode="confirm"]').classList.contains('active'), true);
  assert.equal(ui.window.document.querySelector('[data-agent-mode="chat"]').classList.contains('active'), false);
  assert.equal(ui.window.document.querySelectorAll('[data-agent-session]').length, 1);
  assert.match(ui.window.document.querySelector('[data-agent-session]').textContent, /分析今天的学习任务/);
  assert.equal(ui.window.document.querySelector('#agentModel').textContent, '本地 · qwen-test');
});

test('full mode requires the current complete-data consent version', () => {
  const full = harness({ ai: { launcherControlEnabled: true, controlConsentVersion: 1, permissionMode: 'full', mailReadEnabled: true, mailConsentVersion: 2 } });
  full.window.agentUI.render();
  assert.equal(full.window.document.querySelector('[data-agent-mode="full"]').classList.contains('active'), true);
  const incomplete = harness({ ai: { launcherControlEnabled: true, controlConsentVersion: 1, permissionMode: 'full', mailReadEnabled: true, mailConsentVersion: 0 } });
  incomplete.window.agentUI.render();
  assert.equal(incomplete.window.document.querySelector('[data-agent-mode="confirm"]').classList.contains('active'), true);
  assert.equal(incomplete.window.document.querySelector('[data-agent-mode="full"]').classList.contains('active'), false);
  const legacy = harness({ ai: { launcherControlEnabled: true, controlConsentVersion: 1, permissionMode: 'full', mailReadEnabled: true, mailConsentVersion: 1 } });
  legacy.window.agentUI.render();
  assert.equal(legacy.window.document.querySelector('[data-agent-mode="confirm"]').classList.contains('active'), true, 'the old inbox-only consent must be re-authorized');
});

test('new chat preserves prior messages and the prior session can be restored', () => {
  const original = [{ role: 'user', content: '旧会话问题' }, { role: 'assistant', content: '旧会话回答' }];
  const ui = harness({ messages: original });
  ui.window.agentUI.mount(); ui.window.agentUI.render();
  const originalId = ui.window.document.querySelector('[data-agent-session]').dataset.agentSession;
  ui.click('#agentNewChat');
  assert.notEqual(ui.state.aiMessages, original);
  assert.deepEqual(Array.from(ui.state.aiMessages), []);
  assert.equal(ui.window.document.querySelectorAll('[data-agent-session]').length, 2);
  ui.click(`[data-agent-session="${originalId}"]`);
  assert.equal(ui.state.aiMessages, original);
  assert.equal(ui.state.aiMessages[1].content, '旧会话回答');
  assert.equal(ui.renderAiCalls, 2);
});

test('busy state disables creation and prevents switching sessions', () => {
  const original = [{ role: 'user', content: '旧会话' }];
  const ui = harness({ messages: original });
  ui.window.agentUI.mount(); ui.window.agentUI.render();
  const originalId = ui.window.document.querySelector('[data-agent-session]').dataset.agentSession;
  ui.click('#agentNewChat');
  const second = ui.state.aiMessages;
  second.push({ role: 'user', content: '新会话' });
  ui.window.agentUI.render();
  ui.state.aiBusy = true; ui.window.agentUI.render();
  const calls = ui.renderAiCalls;
  ui.click(`[data-agent-session="${originalId}"]`);
  ui.click('#agentNewChat');
  assert.equal(ui.state.aiMessages, second);
  assert.equal(ui.renderAiCalls, calls);
  assert.equal(ui.window.document.querySelector('#agentNewChat').disabled, true);
  assert.equal([...ui.window.document.querySelectorAll('[data-agent-session]')].every((button) => button.disabled), true);
});

test('permission mode click delegates through the existing toggle change event only', () => {
  const ai = { launcherControlEnabled: false, controlConsentVersion: 0 };
  const ui = harness({ messages: [], ai });
  const toggle = ui.window.document.querySelector('#aiControlToggle');
  let changes = 0; let observed = null;
  toggle.addEventListener('change', () => { changes += 1; observed = toggle.checked; });
  ui.window.agentUI.mount(); ui.window.agentUI.render();
  ui.click('[data-agent-mode="confirm"]');
  assert.equal(changes, 1);
  assert.equal(observed, true);
  assert.equal(toggle.checked, true);
  assert.equal(ui.state.data.settings.ai.launcherControlEnabled, false);
  assert.equal(ui.state.data.settings.ai.controlConsentVersion, 0);
});

test('full mode requests the existing toggle flow with its mode marker', () => {
  const ui = harness({ messages: [], ai: { launcherControlEnabled: false, controlConsentVersion: 0 } });
  const toggle = ui.window.document.querySelector('#aiControlToggle');
  let observed = null;
  toggle.addEventListener('change', () => { observed = { checked: toggle.checked, mode: toggle.dataset.agentMode }; });
  ui.window.agentUI.mount(); ui.window.agentUI.render();
  ui.click('[data-agent-mode="full"]');
  assert.deepEqual(observed, { checked: true, mode: 'full' });
});

test('malicious session titles are rendered as inert text', () => {
  const title = '<img src=x onerror="globalThis.agentOwned=true">';
  const ui = harness({ messages: [{ role: 'user', content: title }] });
  ui.window.agentUI.render();
  const session = ui.window.document.querySelector('[data-agent-session]');
  assert.equal(session.querySelector('img'), null);
  assert.match(session.textContent, /^<img src=x onerror=/);
  assert.equal(ui.window.agentOwned, undefined);
});
