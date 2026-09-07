'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function harness({ provider = 'local', snapshot } = {}) {
  const { window } = parseHTML(`<html><body>
    <button data-agent-mode="chat"></button><button data-agent-mode="confirm"></button><button data-agent-mode="full"></button>
    <input id="aiControlToggle"><button id="aiEditConfig"></button><button id="agentConfigure"></button>
    <button id="agentNewChat"></button><div id="agentHistoryStatus"></div><p id="agentSessionNotice" class="hidden"></p><div id="agentSessions"></div>
    <details id="agentMemoryPanel"><div id="agentMemories"></div><form id="agentMemoryForm"><input id="agentMemoryId"><textarea id="agentMemoryText"></textarea><button id="agentMemorySave" type="submit"></button><button id="agentMemoryCancel" type="button" class="hidden"></button></form></details>
    <input id="aiUseMemories" type="checkbox"><small id="aiMemoryRisk"></small><span id="agentModel"></span>
  </body></html>`);
  let stored = structuredClone(snapshot || { available: true, connectionKey: 'local-key', sessions: [], memories: [] });
  const calls = { save: [], removeSession: [], saveMemory: [], removeMemory: [] };
  const history = {
    get: async () => structuredClone(stored),
    saveSession: async (input) => {
      calls.save.push(structuredClone(input));
      const session = { ...input, updatedAt: 1 };
      stored.sessions = [session, ...stored.sessions.filter((item) => item.id !== session.id)];
      return structuredClone(stored);
    },
    removeSession: async (id) => { calls.removeSession.push(id); stored.sessions = stored.sessions.filter((item) => item.id !== id); return structuredClone(stored); },
    saveMemory: async (input) => {
      calls.saveMemory.push(structuredClone(input));
      const memory = { id: input.id || 'new-memory', text: input.text, updatedAt: 2 };
      stored.memories = [memory, ...stored.memories.filter((item) => item.id !== memory.id)];
      return structuredClone(stored);
    },
    removeMemory: async (id) => { calls.removeMemory.push(id); stored.memories = stored.memories.filter((item) => item.id !== id); return structuredClone(stored); },
  };
  const state = {
    data: { settings: { ai: { provider, localModel: 'local-test', apiModel: 'api-test' } } },
    aiMessages: [], aiBusy: false, aiLocalWarmup: { localWarmup: 'idle' }, aiUseMemories: undefined, aiMemoryProvider: '',
  };
  let renderAiCalls = 0;
  window.renderAi = () => { renderAiCalls += 1; };
  window.ph = { ai: { history } };
  const context = { window, document: window.document, state, Event: window.Event, Date, setTimeout, clearTimeout, structuredClone, globalThis: { crypto: { randomUUID: () => 'new-session' } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/agent-ui.js'), 'utf8'), context);
  const click = (selector) => { const item = window.document.querySelector(selector); assert.ok(item, `missing ${selector}`); item.dispatchEvent(new window.Event('click', { bubbles: true })); };
  return { window, state, calls, history, click, get stored() { return stored; }, get renderAiCalls() { return renderAiCalls; } };
}

test('saved sessions restore locally, but a session from another connection starts fresh before continuing', async () => {
  const ui = harness({ snapshot: {
    available: true, connectionKey: 'local-key', memories: [],
    sessions: [
      { id: 'same', title: '本地记录', connectionKey: 'local-key', messages: [{ role: 'user', content: '本地问题' }, { role: 'assistant', content: '本地回答' }], updatedAt: 2 },
      { id: 'remote', title: '远程记录', connectionKey: 'api-key', messages: [{ role: 'user', content: '私密旧问题' }, { role: 'assistant', content: '旧回答' }], updatedAt: 1 },
    ],
  } });
  ui.window.agentUI.mount();
  await ui.window.agentUI.loadHistory();
  assert.equal(ui.window.agentUI.currentSession().id, 'same');
  assert.equal(ui.state.aiMessages[0].content, '本地问题');
  ui.click('[data-agent-session="remote"]');
  assert.equal(ui.state.aiMessages[0].content, '私密旧问题');
  assert.match(ui.window.document.querySelector('#agentSessionNotice').textContent, /另一项 AI 连接/);
  const session = ui.window.agentUI.prepareForSend();
  assert.equal(session.id, 'new-session');
  assert.equal(ui.state.aiMessages.length, 0);
  assert.equal(session.connectionKey, 'local-key');
});

test('saving keeps only plain user and assistant content, and memory actions use the history API', async () => {
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions: [], memories: [{ id: 'm1', text: '先举例', updatedAt: 1 }] } });
  ui.state.aiMessages.push(
    { role: 'user', content: '解释函数' },
    { role: 'assistant', content: '好的', proposal: { id: 'write' } },
    { role: 'assistant', content: '流式内容', streaming: true },
    { role: 'tool', content: 'never save' },
  );
  ui.window.agentUI.render();
  await ui.window.agentUI.loadHistory();
  await ui.window.agentUI.saveNow();
  assert.deepEqual(ui.calls.save[0].messages, [
    { role: 'user', content: '解释函数' },
    { role: 'assistant', content: '好的' },
  ]);
  assert.equal(Object.hasOwn(ui.calls.save[0].messages[1], 'proposal'), false);
  assert.equal(ui.window.document.querySelector('#aiUseMemories').checked, true, 'local defaults to using voluntarily saved memories');
  assert.match(ui.window.document.querySelector('#agentMemories').textContent, /先举例/);
  ui.click('[data-agent-memory-edit="m1"]');
  assert.equal(ui.window.document.querySelector('#agentMemoryText').value, '先举例');
  ui.window.document.querySelector('#agentMemoryText').value = '回答前给出简短框架';
  await ui.window.agentUI.saveMemory();
  assert.deepEqual(ui.calls.saveMemory[0], { id: 'm1', text: '回答前给出简短框架' });
  ui.click('[data-agent-memory-delete="m1"]');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ui.calls.removeMemory, ['m1']);
});

test('API memory use defaults off and unavailable history remains an explicitly temporary session', async () => {
  const ui = harness({ provider: 'api', snapshot: { available: false, error: '加密存储不可用', connectionKey: '', sessions: [], memories: [] } });
  ui.window.agentUI.mount();
  await ui.window.agentUI.loadHistory();
  assert.equal(ui.window.document.querySelector('#aiUseMemories').checked, false);
  assert.equal(ui.window.document.querySelector('#aiUseMemories').disabled, true);
  assert.match(ui.window.document.querySelector('#agentHistoryStatus').textContent, /加密存储不可用/);
});

test('a delayed save snapshot cannot replace a streaming assistant message, and the completed text survives reload', async () => {
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions: [], memories: [] } });
  ui.window.agentUI.mount(); await ui.window.agentUI.loadHistory();
  ui.state.aiMessages.push({ role: 'user', content: 'Explain this.' }, { role: 'assistant', content: '', streaming: true });
  ui.window.agentUI.render();
  let release;
  const originalSave = ui.history.saveSession;
  ui.history.saveSession = (input) => new Promise((resolve) => { ui.calls.save.push(structuredClone(input)); release = () => resolve({ available: true, connectionKey: 'local-key', memories: [], sessions: [{ ...input, updatedAt: 1 }] }); });
  const pending = ui.window.agentUI.saveNow();
  assert.deepEqual(ui.calls.save[0].messages, [{ role: 'user', content: 'Explain this.' }]);
  const liveMessages = ui.state.aiMessages;
  liveMessages[1].content = 'A complete streamed answer.';
  delete liveMessages[1].streaming;
  release(); await pending;
  assert.equal(ui.state.aiMessages, liveMessages);
  assert.equal(ui.state.aiMessages[1].content, 'A complete streamed answer.');
  ui.history.saveSession = originalSave;
  await ui.window.agentUI.saveNow();
  const restarted = harness({ snapshot: ui.stored });
  restarted.window.agentUI.mount(); await restarted.window.agentUI.loadHistory();
  assert.equal(restarted.state.aiMessages[1].content, 'A complete streamed answer.');
});

test('memory snapshots update memories without rolling back an unsaved conversation', async () => {
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions: [{ id: 'chat', title: 'Chat', connectionKey: 'local-key', messages: [{ role: 'user', content: 'saved' }], updatedAt: 1 }], memories: [{ id: 'm1', text: 'old', updatedAt: 1 }] } });
  ui.window.agentUI.mount(); await ui.window.agentUI.loadHistory();
  const messages = ui.state.aiMessages;
  messages.push({ role: 'assistant', content: 'unsaved live answer', streaming: true });
  ui.window.document.querySelector('#agentMemoryId').value = 'm1';
  ui.window.document.querySelector('#agentMemoryText').value = 'updated memory';
  await ui.window.agentUI.saveMemory();
  assert.equal(ui.state.aiMessages, messages);
  assert.equal(ui.state.aiMessages.at(-1).content, 'unsaved live answer');
  assert.match(ui.window.document.querySelector('#agentMemories').textContent, /updated memory/);
  ui.click('[data-agent-memory-delete="m1"]'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.state.aiMessages, messages);
  assert.equal(ui.state.aiMessages.at(-1).content, 'unsaved live answer');
});

test('new chat flushes the prior session immediately instead of cancelling its debounce', async () => {
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions: [{ id: 'old', title: 'Old', connectionKey: 'local-key', messages: [{ role: 'user', content: 'saved start' }], updatedAt: 1 }], memories: [] } });
  ui.window.agentUI.mount(); await ui.window.agentUI.loadHistory();
  ui.state.aiMessages.push({ role: 'assistant', content: 'unsaved ending' });
  ui.window.agentUI.scheduleSave();
  ui.click('#agentNewChat'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.calls.save[0].id, 'old');
  assert.equal(ui.calls.save[0].messages.at(-1).content, 'unsaved ending');
  assert.equal(ui.window.agentUI.currentSession().id, 'new-session');
  assert.equal(ui.state.aiMessages.length, 0);
});

test('deleting the current session cannot be undone by an older save response', async () => {
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions: [{ id: 'delete-me', title: 'Delete', connectionKey: 'local-key', messages: [{ role: 'user', content: 'remove this' }], updatedAt: 1 }], memories: [] } });
  ui.window.agentUI.mount(); await ui.window.agentUI.loadHistory();
  let release;
  ui.history.saveSession = (input) => new Promise((resolve) => { release = () => resolve({ available: true, connectionKey: 'local-key', memories: [], sessions: [{ ...input, updatedAt: 2 }] }); });
  const pending = ui.window.agentUI.saveNow();
  ui.click('[data-agent-delete="delete-me"]'); await new Promise((resolve) => setImmediate(resolve));
  release(); await pending;
  assert.deepEqual(ui.calls.removeSession, ['delete-me']);
  assert.equal(ui.window.document.querySelector('[data-agent-session="delete-me"]'), null);
  assert.notEqual(ui.window.agentUI.currentSession().id, 'delete-me');
});

test('renderer keeps over-limit drafts intact and reports the failed save without truncating them', async () => {
  const sessions = Array.from({ length: 30 }, (_, index) => ({ id: `s-${index}`, title: `S${index}`, connectionKey: 'local-key', messages: [{ role: 'user', content: `message ${index}` }], updatedAt: index }));
  const ui = harness({ snapshot: { available: true, connectionKey: 'local-key', sessions, memories: [] } });
  ui.window.agentUI.mount(); await ui.window.agentUI.loadHistory();
  ui.click('#agentNewChat');
  assert.equal(ui.window.document.querySelectorAll('[data-agent-session]').length, 31, 'the oldest local session must not be silently discarded');
  ui.state.aiMessages.push(...Array.from({ length: 121 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `draft ${index}` })));
  assert.equal(await ui.window.agentUI.saveNow(), false);
  assert.equal(ui.state.aiMessages.length, 121);
  assert.equal(ui.calls.save.length, 1, 'only the old session flush may reach the backend');
  assert.match(ui.window.document.querySelector('#agentHistoryStatus').textContent, /最多保存 120 条/);
  ui.state.aiMessages.splice(0, ui.state.aiMessages.length, { role: 'user', content: 'x'.repeat(16_001) });
  assert.equal(await ui.window.agentUI.saveNow(), false);
  assert.equal(ui.state.aiMessages[0].content.length, 16_001);
  assert.match(ui.window.document.querySelector('#agentHistoryStatus').textContent, /单条消息超过/);
});
