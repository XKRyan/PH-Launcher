const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../electron/vocabulary.cjs');
const r = require('../electron/vocabulary-reading.cjs');
const now = new Date('2026-09-06T09:00:00Z');
test('reading is local, exact-text deduplicated and respects input caps', () => {
  const data = v.emptyVocabulary();
  const first = r.saveReading(data, { title: '我的半页', text: 'The evidence is clear.' }, now);
  assert.equal(r.saveReading(data, { text: 'The evidence is clear.' }, now).id, first.id);
  assert.equal(data.readings.length, 1);
  assert.throws(() => r.saveReading(data, { text: 'a'.repeat(20001) }));
  assert.throws(() => r.saveReading(data, { text: '没有英文' }));
});
test('finishing records self-marked unknown occurrences, never claims mastery', () => {
  const data = v.emptyVocabulary();
  v.addCards(data, [{ word: 'evidence', meaning: '证据' }], now);
  const saved = r.saveReading(data, { text: 'The evidence is clear. Evidence matters.' }, now);
  const result = r.finishReading(data, { id: saved.id, unknownWords: ['evidence', 'evidence', 'unrelated'], seconds: 90, expectedReadCount: 0 }, now);
  assert.equal(result.words, 6); assert.equal(result.unknownCount, 2);
  assert.equal(data.cards[0].encounters.length, 1);
  assert.equal(data.cards[0].schedule.reps, 0);
  assert.throws(() => r.finishReading(data, { id: saved.id, expectedReadCount: 0 }, now));
  r.finishReading(data, { id: saved.id, expectedReadCount: 1, seconds: 40 }, now);
  assert.equal(data.cards[0].encounters.length, 1);
  const stats = r.readingStats(data, now);
  assert.equal(stats.todayWords, 12); assert.equal(stats.todaySeconds, 130);
});
test('different reading passages accumulate contexts and survive backup normalization', () => {
  const data = v.emptyVocabulary();
  v.addCards(data, [{ word: 'evidence', meaning: '证据' }], now);
  for (const text of ['The evidence is clear.', 'Reliable evidence matters.']) {
    const saved = r.saveReading(data, { text }, now);
    r.finishReading(data, { id: saved.id, expectedReadCount: 0 }, now);
  }
  const restored = v.normalizeVocabulary(JSON.parse(JSON.stringify(data)), now);
  assert.equal(restored.cards[0].encounters.length, 2);
  assert.equal(restored.readings.length, 2);
  assert.equal(restored.readingLogs.length, 2);
  const target = v.emptyVocabulary();
  v.importVocabulary(target, { format: 'ph-vocabulary', version: 1, data: restored }, now);
  assert.equal(target.readings.length, 2);
  assert.equal(target.readingLogs.length, 2);
});
