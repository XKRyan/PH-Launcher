'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAiMailReader } = require('../electron/ai-mail.cjs');
const { AI_MAIL_TOOLS, AI_TOOLS, PendingActionStore, createAction, toolKind } = require('../electron/ai-tools.cjs');

const mainSource = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const gateCode = mainSource.slice(mainSource.indexOf('function shouldOfferLauncherTools('), mainSource.indexOf('\nasync function aiChat('));
const chatCode = mainSource.slice(mainSource.indexOf('async function aiChat('), mainSource.indexOf('\nfunction combinedAiSignal('));

function workflowHarness() {
  const data = { settings: { ai: { enabled: true, provider: 'api', apiModel: 'fixture-model', launcherControlEnabled: true, permissionMode: 'full', mailReadEnabled: true, mailConsentVersion: 2 } }, notes: [], tasks: [], schedule: [], calendarEvents: [] };
  const pending = new PendingActionStore();
  const mailCalls = [];
  const client = {
    async list(args) {
      mailCalls.push({ name: 'list', args: structuredClone(args) });
      return { total: 2, nextCursor: null, items: [
        { uid: '41', from: [{ name: 'University Office', address: 'university@school.test' }], date: '2026-09-20', subject: '大学宣讲会安排', unread: false },
        { uid: '42', from: [{ name: 'Counselling', address: 'counselling@school.test' }], date: '2026-09-21', subject: '两场大学说明会', unread: true },
      ] };
    },
    async read(uid) {
      mailCalls.push({ name: 'read', uid });
      return { uid, from: [], to: [], date: '2026-09-21', subject: '两场大学说明会', text: [
        'University information session: 2026-10-12, 18:30–19:30.',
        'Campus admissions talk: 2026-10-18, 14:00–15:00.',
      ].join('\n') };
    },
    async contacts() { return []; },
  };
  let revision = 'mail-fixture-a';
  let permitted = true;
  const reader = createAiMailReader({
    getClient: () => client,
    getRevision: () => revision,
    assertAllowed: () => { if (!permitted) throw new Error('邮件读取权限已撤销'); },
  });
  const rounds = [];
  const offered = [];
  const replies = [
    { role: 'assistant', content: '', calls: [{ name: 'list_mail', arguments: JSON.stringify({ query: '大学宣讲会', cursor: 0, limit: 20 }) }] },
    { role: 'assistant', content: '', calls: [{ name: 'read_mail', arguments: JSON.stringify({ uid: '42' }) }] },
    { role: 'assistant', content: '', calls: [{ name: 'create_calendar_events', arguments: JSON.stringify({ events: [
      { title: 'University information session', date: '2026-10-12', start: '18:30', end: '19:30', notes: 'From the selected school email.', reminderMinutes: 15 },
      { title: 'Campus admissions talk', date: '2026-10-18', start: '14:00', end: '15:00', notes: 'From the selected school email.', reminderMinutes: null },
    ] }) }] },
    { role: 'assistant', content: '我已整理两条待确认日程，尚未写入。', calls: [] },
  ];
  const box = {
    assertHistoryConnection() {}, aiHistoryStore: null,
    secureStore: { data },
    validateMessages: (messages) => structuredClone(messages),
    requestConfigFingerprint: (config) => JSON.stringify(config),
    isAiControlEnabled: () => true,
    isAiMailReadEnabled: () => permitted,
    AI_TOOLS, AI_MAIL_TOOLS, AI_LAUNCHER_READ_TOOLS: [], LAUNCHER_READ_NAMES: new Set(),
    AI_WORKSPACE_TOOLS: [], AI_EXTERNAL_WRITE_TOOLS: [],
    SCHOOL_WRITE_NAMES: new Set(['send_email', 'submit_managebac_task', 'reply_discussion']),
    launcherAccountRevision: () => 'launcher-a', mailAccountRevision: () => revision,
    requestAiTurn: async (_config, messages, tools) => { rounds.push(structuredClone(messages)); offered.push(tools.map((tool) => tool.function.name)); return replies.shift(); },
    normalizedToolCalls: (reply) => reply.calls || [], parseToolArguments: JSON.parse,
    toolKind, createAction,
    executeAiTool: async (name, args, hooks) => {
      const result = await reader.execute(name, args);
      hooks.onMailRevision(revision);
      return result;
    },
    toolResultMessage: (_provider, call, result) => ({ role: 'tool', name: call.name, content: JSON.stringify(result) }),
    pendingAiActions: pending,
  };
  vm.runInNewContext(`${gateCode}\n${chatCode}\nthis.runAiChat = aiChat;`, box);
  return {
    data, pending, mailCalls, rounds, offered,
    run: (content = '查看我邮箱中关于大学宣讲会的内容并写入日程') => {
      if (content === '你好') replies.splice(0, replies.length, {role:'assistant',content:'你好',calls:[]});
      return box.runAiChat([{ role: 'user', content }]);
    },
    revoke: () => { permitted = false; },
    changeMailbox: () => { revision = 'mail-fixture-b'; },
  };
}

test('real aiChat loop searches mail, reads one result, and creates only a pending calendar proposal', async () => {
  const app = workflowHarness();
  const result = await app.run();
  assert.deepEqual(app.mailCalls, [
    { name: 'list', args: { query: '大学宣讲会', cursor: 0, limit: 20, unread: false } },
    { name: 'read', uid: '42' },
  ]);
  assert.equal(app.rounds.length, 4);
  assert.ok(app.offered[0].includes('list_mail'), 'the real mail gate must offer mail tools for the original wording');
  assert.ok(app.offered[0].includes('create_calendar_events'), 'the real launcher gate must offer the pending calendar write tool');
  assert.match(JSON.stringify(app.rounds[1]), /大学宣讲会安排/);
  assert.match(JSON.stringify(app.rounds[2]), /2026-10-12/);
  assert.equal(app.data.calendarEvents.length, 0, 'tool execution must not write before confirmation');
  assert.equal(result.proposal.requiresConfirmation, true);
  assert.equal(result.proposal.groups[0].type, 'calendar-events');
  assert.equal(result.proposal.groups[0].items.length, 2);
  assert.match(result.content, /尚未写入/);

  const committed = app.pending.commit(result.proposal.id, app.data);
  assert.equal(committed.counts.calendarEvents, 2);
  assert.equal(committed.data.calendarEvents.length, 2);
  assert.equal(app.data.calendarEvents.length, 0, 'commit remains immutable until main persists returned data');
  assert.throws(() => app.pending.commit(result.proposal.id, app.data), /过期|已经处理/);
});

test('full-access ordinary conversation exposes capabilities without automatic data reads', async () => {
  const app = workflowHarness();
  const result = await app.run('你好');
  assert.ok(app.offered[0].includes('create_calendar_events'));
  assert.deepEqual(app.mailCalls, []);
  assert.equal(result.proposal, null);
  assert.equal(app.data.calendarEvents.length, 0);
});

test('confirmed workflow deduplicates repeats and rejects concurrent calendar changes', async () => {
  const first = workflowHarness();
  const firstResult = await first.run();
  const committed = first.pending.commit(firstResult.proposal.id, first.data);

  const duplicate = workflowHarness();
  duplicate.data.calendarEvents = structuredClone(committed.data.calendarEvents);
  const duplicateResult = await duplicate.run();
  const unchanged = duplicate.pending.commit(duplicateResult.proposal.id, duplicate.data);
  assert.equal(unchanged.counts.calendarEvents, 0);
  assert.equal(unchanged.counts.unchanged, 2);
  assert.equal(unchanged.data.calendarEvents.length, 2);

  const concurrent = workflowHarness();
  const proposal = await concurrent.run();
  concurrent.data.calendarEvents.push({ id: 'manual-event', title: 'Student-created event', date: '2026-10-10', start: '09:00', end: '10:00', notes: '', color: 'green', reminderMinutes: null });
  assert.throws(() => concurrent.pending.commit(proposal.proposal.id, concurrent.data), /数据已发生变化/);
  assert.deepEqual(concurrent.data.calendarEvents.map((item) => item.id), ['manual-event']);
});
