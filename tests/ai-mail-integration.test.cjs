'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const chatCode = source.slice(source.indexOf('async function aiChat('), source.indexOf('\nfunction combinedAiSignal('));

function harness(change = () => {}, scope = 'mail') {
  const state = { ai: { enabled: true, provider: 'api', apiEndpoint: 'https://example.com', apiModel: 'test', launcherControlEnabled: true, permissionMode: 'full', mailReadEnabled: true, mailConsentVersion: 1 }, revision: 'A', sent: [], reads: [] };
  const box = {
    assertHistoryConnection() {}, aiHistoryStore: null,
    secureStore: { data: { settings: { get ai() { return state.ai; } } } },
    validateMessages: messages => structuredClone(messages),
    isAiControlEnabled: () => true,
    isAiMailReadEnabled: () => state.ai.mailReadEnabled === true,
    shouldOfferLauncherTools: () => false, shouldOfferMailTools: () => false,
    AI_TOOLS: [{ function: { name: 'list_tasks' } }], AI_MAIL_TOOLS: [{ function: { name: 'read_mail' } }],
    AI_LAUNCHER_READ_TOOLS: [{ function: { name: 'read_school_cache' } }],
    AI_WORKSPACE_TOOLS: [], AI_EXTERNAL_WRITE_TOOLS: [],
    SCHOOL_WRITE_NAMES: new Set(['send_email', 'submit_managebac_task', 'reply_discussion']),
    LAUNCHER_READ_NAMES: new Set(['read_school_cache']),
    launcherAccountRevision: () => state.revision,
    mailAccountRevision: () => state.revision,
    requestAiTurn: async (_config, messages, tools) => {
      state.offeredTools = tools.map(tool => tool.function.name);
      state.sent.push(structuredClone(messages));
      return state.sent.length === 1 ? { role: 'assistant', content: '', calls: [{ name: scope === 'mail' ? 'read_mail' : 'read_school_cache', arguments: '{}' }, { name: 'list_tasks', arguments: '{}' }] } : { role: 'assistant', content: 'Done' };
    },
    normalizedToolCalls: reply => reply.calls || [], parseToolArguments: JSON.parse,
    toolKind: () => 'read',
    executeAiTool: async (name, _args, hooks) => {
      state.reads.push(name);
      if (name === 'read_mail') { hooks.onMailRevision(state.revision); return { text: 'A harmless course notice' }; }
      if (name === 'read_school_cache') { hooks.onLauncherRevision(state.revision); return { course: 'A course fixture' }; }
      await Promise.resolve(); change(state); return [];
    },
    toolResultMessage: (_provider, _call, result) => ({ role: 'tool', content: JSON.stringify(result) }),
    pendingAiActions: { create() { throw Error('No writes in this test'); } },
  };
  vm.runInNewContext(`${chatCode}\nthis.chat = aiChat;`, box);
  return { state, run: () => box.chat([{ role: 'user', content: 'Continue.' }]) };
}

test('full permission exposes real tools even when follow-up text has no launcher keywords', async () => {
  const allowed=harness(); await allowed.run();
  assert.deepEqual(Array.from(allowed.state.offeredTools), ['list_tasks','read_mail','read_school_cache']);
});

test('full-access school contents reach AI only for the still-authorized account', async () => {
  const allowed = harness(() => {}, 'school');
  assert.equal((await allowed.run()).content, 'Done');
  assert.match(JSON.stringify(allowed.state.sent[1]), /A course fixture/);
  for (const change of [s => { s.revision = 'B'; }, s => { s.ai.mailReadEnabled = false; }]) {
    const blocked = harness(change, 'school');
    await assert.rejects(blocked.run(), /变化|变更|撤销/);
    assert.equal(blocked.state.sent.length, 1);
  }
});

test('consented mail result enters the next model round only while account and permission remain unchanged', async () => {
  const app = harness();
  assert.equal((await app.run()).content, 'Done');
  assert.equal(app.state.sent.length, 2);
  assert.match(JSON.stringify(app.state.sent[1]), /harmless course notice/);
});

for (const [name, change] of [
  ['revoked mail permission', state => { state.ai = { ...state.ai, mailReadEnabled: false }; }],
  ['changed mailbox', state => { state.revision = 'B'; }],
  ['changed provider', state => { state.ai = { ...state.ai, provider: 'local' }; }],
  ['changed model', state => { state.ai = { ...state.ai, apiModel: 'other' }; }],
]) {
  test(`${name} during a later non-mail tool prevents sending the earlier mail result`, async () => {
    const app = harness(change);
    await assert.rejects(app.run(), /变化|变更|撤销/);
    assert.equal(app.state.sent.length, 1);
    assert.deepEqual(app.state.reads, ['read_mail', 'list_tasks']);
  });
}

test('canceling warmup forgets a previously ready model so a new local choice can prepare', () => {
  const warmCode = source.slice(source.indexOf('function cancelLocalAiWarmup()'), source.indexOf('\nfunction publishDataChange()'));
  let queued = 0;
  const box = { IS_HEADLESS: false, secureStore: { data: { settings: { ai: { enabled: true, provider: 'local', localModel: 'other' } } } },
    clearTimeout() {}, setTimeout() { queued++; return { unref() {} }; } };
  vm.runInNewContext(`let localAiWarmupTimer = null; let localAiWarmup={status:'ready',key:'old',task:Promise.resolve()}; ${warmCode}\ncancelLocalAiWarmup();scheduleLocalAiWarmup(250);`, box);
  assert.equal(queued, 1);
});
