const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../electron/vocabulary.cjs');
const { SchoolCache } = require('../electron/school-cache.cjs');
const { createVocabularyStudy } = require('../electron/vocabulary-study.cjs');

test('unfinished previews and recall survive a restart and a new day without fake review logs', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const data = v.emptyVocabulary();
  v.addCards(data, ['apple', 'bread', 'book', 'window', 'school'].map(word => ({ word, meaning: 'meaning' })), now);
  const ids = data.cards.map(card => card.id);
  v.updateBatchProgress(data, { ids, index: 2, phase: 'preview' }, now);
  const restored = v.normalizeVocabulary(JSON.parse(JSON.stringify(data)), new Date('2026-09-09T12:00:00Z'));
  assert.equal(restored.batch.index, 2);
  assert.equal(restored.batch.phase, 'preview');
  assert.equal(restored.logs.length, 0);
  v.updateBatchProgress(restored, { ids, phase: 'recall' }, now);
  v.reviewCard(restored, { id: ids[0], rating: 3, expectedReps: 0, mode: 'meaning' }, now);
  const again = v.normalizeVocabulary(JSON.parse(JSON.stringify(restored)), now);
  assert.deepEqual(again.batch.ids, ids.slice(1));
  assert.equal(again.batch.phase, 'recall');
  assert.equal(again.cards[0].schedule.reps, 1);
  assert.ok(Date.parse(again.cards[0].schedule.due) > now.getTime());
  v.updateCard(again, { id: ids[1], suspended: true, known: true });
  assert.ok(again.cards[1].knownAt);
  assert.equal(again.cards[1].schedule.reps, 0);
});

test('offline cache survives restart and switching to an uncached week; account removal persists', async () => {
  const data = weekStart => ({ source: 'edupage', weekStart, accountKey: 'fixture', lessons: [], fetchedAt: '2026-09-08T12:00:00Z' });
  const a = new SchoolCache();
  await a.sync('edupage', { weekStart: '2026-09-07' }, async () => data('2026-09-07'));
  await a.sync('edupage', { weekStart: '2026-09-14' }, async () => data('2026-09-14'));
  a.selectWeek('2026-09-21');
  const b = new SchoolCache(); const shared = b.current;
  b.restore(JSON.parse(JSON.stringify(a.serialize())));
  assert.equal(shared, b.current);
  assert.equal(b.snapshot({ weekStart: '2026-09-07' }).edupage.accountKey, 'fixture');
  assert.equal(b.snapshot().status.edupage.state, 'stale');
  assert.equal(b.snapshot().cachedWeeks.length, 2);
  b.invalidate('edupage');
  a.restore(b.serialize());
  assert.equal(a.snapshot().edupage, null);
  assert.equal(a.snapshot().cachedWeeks.length, 0);
});

test('API permission can survive restart, follows the API connection and can be revoked', () => {
  const data = v.emptyVocabulary();
  const ai = { enabled: true, provider: 'api', apiEndpoint: 'https://example.com/v1', apiModel: 'fixture', apiKey: 'synthetic' };
  let stored = '';
  const make = () => createVocabularyStudy({ getData: () => data, getConfig: () => ai, getRevision: () => 0,
    change: work => ({ result: work(data) }), snapshot: () => ({}), advise: async () => { throw Error('unexpected network'); },
    getConsent: () => stored, saveConsent: key => { stored = key; } });
  const a = make();
  a.configure({ provider: 'api', apiConsent: true, rememberApiConsent: true });
  assert.ok(stored); assert.ok(!stored.includes('synthetic'));
  const b = make(); assert.equal(b.status().apiConsented, true);
  ai.apiEndpoint = 'https://another.example/v1';
  assert.equal(b.status().apiConsented, false);
  ai.apiEndpoint = 'https://example.com/v1';
  b.configure({ provider: 'off', revokeApiConsent: true });
  assert.equal(make().status().apiConsented, false);
  a.configure({ provider: 'api', apiConsent: true });
  assert.equal(make().status().apiConsented, false, 'temporary consent is not remembered');
});
