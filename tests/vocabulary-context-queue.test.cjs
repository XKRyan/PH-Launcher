'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextQueue } = require('../electron/vocabulary-context-queue.cjs');

function cards(count = 6) { return Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, word: `word${String.fromCharCode(97 + i)}`, meaning: `meaning ${i}`, context: '', contexts: [], suspended: false })); }
function setup({ provider = 'local', advise, authorize = async () => true, count } = {}) {
  let list = cards(count); const calls = []; const saved = [];
  const queue = createContextQueue({ getCards: () => list, getProvider: () => provider, authorize, advise: async (...args) => { calls.push(args[0]); return advise(...args); }, saveContexts: async (items) => { saved.push(...items); for (const item of items) { const card = list.find((entry) => entry.id === item.id); if (card && card.word === item.word && card.meaning === item.meaning && !card.context) card.context = item.context; } } });
  return { queue, calls, saved, get list() { return list; }, set provider(value) { provider = value; } };
}

test('queues at most forty, sends one provider in groups of five, and saves only contexts', async () => {
  const app = setup({ count: 45, advise: async (input) => ({ source: input.provider, contexts: input.candidates.map((item) => ({ id: item.id, sentence: `The ${item.word} appears once in this complete example sentence for careful study today.` })) }) });
  const state = app.queue.enqueue(app.list.map((card) => card.id)); await app.queue.idle();
  assert.deepEqual(state, { queued: 40, skipped: 5, total: 40 }); assert.equal(app.calls.length, 8); assert.ok(app.calls.every((call) => call.provider === 'local' && call.candidates.length <= 5));
  assert.equal(app.saved.length, 40); assert.ok(app.list.slice(0, 40).every((card) => card.context)); assert.ok(app.list.slice(40).every((card) => !card.context));
});

test('off or unconsented API makes zero model requests and never falls back', async () => {
  const off = setup({ provider: 'off', advise: async () => { throw new Error('must not call'); } }); off.queue.enqueue(['id-0']); await off.queue.idle(); assert.equal(off.calls.length, 0);
  const api = setup({ provider: 'api', authorize: async () => { throw new Error('consent'); }, advise: async () => { throw new Error('must not call'); } }); api.queue.enqueue(['id-0']); await api.queue.idle(); assert.equal(api.calls.length, 0);
});

test('cancellation and provider changes discard late results', async () => {
  let finish; const app = setup({ advise: () => new Promise((resolve) => { finish = resolve; }) });
  app.queue.enqueue(['id-0']); await Promise.resolve(); app.queue.cancel(); finish({ source: 'local', contexts: [{ id: 'id-0', sentence: 'The worda appears once in this complete example sentence for careful study today.' }] }); await app.queue.idle(); assert.equal(app.saved.length, 0);
  let resolve; const changed = setup({ advise: () => new Promise((done) => { resolve = done; }) }); changed.queue.enqueue(['id-0']); await Promise.resolve(); changed.provider = 'api'; resolve({ source: 'local', contexts: [{ id: 'id-0', sentence: 'The worda appears once in this complete example sentence for careful study today.' }] }); await changed.queue.idle(); assert.equal(changed.saved.length, 0);
});

test('does not overwrite an edited context and does not retry failed background work', async () => {
  const app = setup({ advise: async () => { throw new Error('offline'); } }); app.queue.enqueue(['id-0']); await app.queue.idle(); assert.equal(app.calls.length, 1);
  const edited = setup({ advise: async (input) => { edited.list[0].context = 'My edited context.'; return { contexts: [{ id: input.candidates[0].id, sentence: 'The worda appears once in this complete example sentence for careful study today.' }] }; } });
  edited.queue.enqueue(['id-0']); await edited.queue.idle(); assert.equal(edited.saved.length, 0); assert.equal(edited.list[0].context, 'My edited context.');
});
