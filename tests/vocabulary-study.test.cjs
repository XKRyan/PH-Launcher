'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vocabulary = require('../electron/vocabulary.cjs');
const { createVocabularyStudy } = require('../electron/vocabulary-study.cjs');
const now = new Date('2026-09-06T12:00:00Z');

test('recall shuffles the whole accepted group and does not mutate FSRS or other cards', () => {
  const app = setup();
  const ids = vocabulary.queue(app.data, now).slice(0, 5).map(card => card.id);
  const original = structuredClone(app.data.cards);
  const response = app.study.startRecall({ ids });
  assert.equal(response.result.ids.length, 5);
  assert.deepEqual([...response.result.ids].sort(), [...ids].sort());
  assert.notDeepEqual(response.result.ids, ids);
  assert.deepEqual(response.snapshot.queueIds.slice(0, 5), response.result.ids);
  assert.deepEqual(app.data.cards, original);
  assert.equal(app.data.logs.length, 0);
  assert.throws(() => app.study.startRecall({ ids: ['nonexistent'] }), /变化/);
  assert.throws(() => app.study.startRecall({ ids: [ids[0], ids[0]] }), /无效/);
});

test('one-word final group is valid and an expired or suspended word cannot enter recall', () => {
  const app = setup(); const id = app.data.cards.at(-1).id;
  assert.deepEqual(app.study.startRecall({ ids: [id] }).result.ids, [id]);
  vocabulary.updateCard(app.data, { id, suspended: true });
  assert.throws(() => app.study.startRecall({ ids: [id] }), /变化/);
});

test('connection check uses a fixture only, respects API consent and keeps learning unchanged', async () => {
  const inputs = [];
  const app = setup(async input => { inputs.push(input); return { ids: ['connection-test'], contexts: [], source: input.provider }; });
  const before = JSON.stringify(app.data);
  const result = await app.study.check({ requestId: 'check-local' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(app.data), before);
  assert.equal(inputs[0].candidates[0].word, 'evidence');
  assert.deepEqual(inputs[0].recent, []);
  app.study.configure({ provider: 'api' });
  assert.equal((await app.study.check({ requestId: 'check-api' })).ok, false);
  assert.equal(inputs.length, 1);
  app.study.configure({ provider: 'api', apiConsent: true });
  assert.equal((await app.study.check({ requestId: 'check-api-consented' })).ok, true);
  assert.equal(inputs[1].provider, 'api');
});

test('failed AI retains safe actionable diagnostics without leaking server text', async () => {
  const app = setup(async () => { throw new Error('API返回 401'); });
  const result = await app.study.prepare({ requestId: 'failed' });
  assert.match(result.notice, /身份验证失败/);
  assert.equal(app.study.status().lastAttempt.ok, false);
  assert.equal(result.source, 'offline');
});

test('short AI selection is filled to five without discarding its priority or due reviews', async () => {
  const app = setup(async ({ candidates }) => ({ ids: [candidates[2].id], contexts: [], source: 'local' }));
  const result = await app.study.prepare({ requestId: 'short-result' });
  assert.equal(result.batchIds.length, 5);
  assert.equal(new Set(result.batchIds).size, 5);
});

function setup(advise = async ({ candidates }) => ({ ids: candidates.slice(0, 5).map(c => c.id), contexts: [], source: 'local' })) {
  let data = vocabulary.normalizeVocabulary({ settings: { dailyNewLimit: 10, level: 'advanced' } }, now);
  vocabulary.addCards(data, [
    ...['apple', 'book', 'window', 'bread', 'school'].map(word => ({ word, meaning: 'test', frequency: 500 })),
    ...['corroborate', 'equivocal', 'inadvertent', 'tenuous', 'disparity'].map(word => ({ word, meaning: 'test', frequency: 9000, level: 'advanced' })),
  ], now);
  let revision = 0;
  const ai = { enabled: true, provider: 'local', localEndpoint: 'http://127.0.0.1:11434', localModel: 'test', apiEndpoint: 'https://example.com/v1', apiModel: 'test', apiKey: 'fixture-key' };
  let calls = 0, study;
  const snapshot = (subject) => ({ ...vocabulary.snapshot(data, now, subject), advisor: study?.status() });
  const change = (work) => { const next = structuredClone(data); const result = work(next); data = next; revision++; return { result, snapshot: snapshot() }; };
  study = createVocabularyStudy({ getData: () => data, getConfig: () => ai, getRevision: () => revision, now: () => now, snapshot, change,
    advise: async (...args) => { calls++; return advise(...args); } });
  return { study, ai, get data() { return data; }, get calls() { return calls; }, change };
}

test('advanced preference affects actual new words while due reviews and FSRS stay untouched', async () => {
  const app = setup();
  const plain = app.data.cards.find(c => c.word === 'apple');
  app.data.settings.level = 'foundation';
  vocabulary.reviewCard(app.data, { id: plain.id, rating: 1, expectedReps: 0, mode: 'meaning' }, new Date(now.getTime() - 120000));
  app.data.settings.level = 'advanced';
  const logs = structuredClone(app.data.logs), schedule = structuredClone(plain.schedule);
  const result = await app.study.prepare({ requestId: 'first', offline: true });
  assert.equal(result.batchIds.length, 5);
  assert.equal(result.snapshot.queueIds[0], plain.id);
  assert.ok(result.batchIds.every(id => vocabulary.cardLevel(result.snapshot.cards.find(c => c.id === id)) === 'advanced'));
  assert.deepEqual(app.data.logs, logs); assert.deepEqual(app.data.cards.find(c => c.id === plain.id).schedule, schedule);
  assert.equal(app.calls, 0);
});

test('API is a separate consent, bound to connection and never used as automatic local fallback', async () => {
  const app = setup(async () => { throw Error('offline'); });
  await app.study.prepare({ requestId: 'local' });
  assert.equal(app.calls, 1);
  app.study.configure({ provider: 'api' });
  const noConsent = await app.study.prepare({ requestId: 'api-blocked' });
  assert.equal(noConsent.source, 'offline'); assert.equal(app.calls, 1);
  app.study.configure({ provider: 'api', apiConsent: true });
  assert.equal(app.study.status().apiConsented, true);
  app.ai.apiModel = 'other';
  assert.equal(app.study.status().apiConsented, false);
  await app.study.prepare({ requestId: 'api-changed' });
  assert.equal(app.calls, 1);
  assert.equal(Object.hasOwn(app.data.settings, 'apiConsent'), false);
});

test('late or canceled AI suggestions never replace the active offline batch', async () => {
  let finish;
  const app = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.study.prepare({ requestId: 'slow' });
  app.study.cancel({ requestId: 'slow' });
  const offline = await app.study.prepare({ requestId: 'offline', offline: true });
  finish({ ids: [app.data.cards[0].id], contexts: [], source: 'local' });
  assert.equal((await pending).canceled, true);
  assert.deepEqual(app.data.batch.ids, offline.batchIds);
});

test('duplicate reading selections add a context without replacing meanings or learning progress', () => {
  const app = setup();
  const word = app.data.cards.find(c => c.word === 'tenuous');
  const original = structuredClone(word);
  const sentence = 'The connection between the two results remained tenuous until more evidence became available.';
  const result = vocabulary.addCards(app.data, [{ word: 'tenuous', meaning: 'replacement', context: sentence, subject: '阅读生词' }], now);
  assert.equal(result.added, 0); assert.equal(result.contextsAdded, 1);
  assert.equal(word.meaning, original.meaning); assert.equal(word.subject, original.subject); assert.deepEqual(word.schedule, original.schedule);
  assert.ok(word.contexts.includes(sentence));
  assert.equal(vocabulary.addCards(app.data, [{ word: 'tenuous', meaning: 'replacement', context: sentence }], now).contextsAdded, 0);
});

test('new-word known feedback is not a fabricated successful FSRS review', () => {
  const app = setup(); const id = app.data.cards[0].id;
  vocabulary.updateCard(app.data, { id, suspended: true, known: true });
  assert.ok(app.data.cards[0].knownAt); assert.equal(app.data.logs.length, 0);
  assert.equal(app.data.cards[0].schedule.reps, 0);
  vocabulary.updateCard(app.data, { id, suspended: false }); assert.equal(app.data.cards[0].knownAt, '');
});

test('prefetch is one read-only group and prepare consumes it without a second AI request', async () => {
  const inputs = [];
  const app = setup(async (input) => { inputs.push(input); return { ids: input.candidates.slice(2, 5).map(card => card.id), contexts: [], source: input.provider }; });
  const before = JSON.stringify(app.data);
  const prefetched = await app.study.prefetch({ subject: '', excludeIds: [], requestId: 'preload-one' });
  assert.deepEqual(prefetched, { ok: true, source: 'local' });
  assert.equal(JSON.stringify(app.data), before, 'prefetch must not write batch, context, logs, or schedules');
  const prepared = await app.study.prepare({ requestId: 'consume-one' });
  assert.equal(app.calls, 1);
  assert.equal(prepared.source, 'local');
  assert.equal(prepared.batchIds.length, 5);
  assert.deepEqual(prepared.batchIds.slice(0, 3), inputs[0].candidates.slice(2, 5).map(card => card.id));
});

test('prefetch honors API consent, cancellation, provider changes, and candidate revalidation', async () => {
  let resolve;
  const app = setup(() => new Promise((done) => { resolve = done; }));
  app.study.configure({ provider: 'api' });
  assert.deepEqual(await app.study.prefetch({ requestId: 'api-no-consent' }), { skipped: true, reason: 'unavailable' });
  app.study.configure({ provider: 'api', apiConsent: true });
  const pending = app.study.prefetch({ requestId: 'cancel-cache' });
  app.study.cancel({ requestId: 'cancel-cache' });
  resolve({ ids: [], contexts: [], source: 'api' });
  assert.equal((await pending).canceled, true);
  assert.equal(app.calls, 1);

  const refreshed = setup(async ({ candidates, provider }) => ({ ids: candidates.slice(0, 2).map(card => card.id), contexts: [], source: provider }));
  await refreshed.study.prefetch({ requestId: 'cache-local' });
  refreshed.study.configure({ provider: 'api', apiConsent: true });
  const prepared = await refreshed.study.prepare({ requestId: 'provider-changed' });
  assert.equal(prepared.source, 'api');
  assert.equal(refreshed.calls, 2, 'a provider switch must discard the local cache and issue at most one selected-provider request');
});

test('authorize matches the selected advisor provider and API consent binding', () => {
  const app = setup();
  assert.equal(app.study.authorize('local'), true);
  assert.throws(() => app.study.authorize('api'), /当前词汇推荐方式/);
  app.study.configure({ provider: 'api' });
  assert.throws(() => app.study.authorize('api'), /确认/);
  app.study.configure({ provider: 'api', apiConsent: true });
  assert.equal(app.study.authorize('api'), true);
  app.ai.apiKey = 'changed';
  assert.throws(() => app.study.authorize('api'), /确认/);
});
