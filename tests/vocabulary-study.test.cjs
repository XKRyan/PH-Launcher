'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vocabulary = require('../electron/vocabulary.cjs');
const { createVocabularyStudy } = require('../electron/vocabulary-study.cjs');
const now = new Date('2026-09-06T12:00:00Z');

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
