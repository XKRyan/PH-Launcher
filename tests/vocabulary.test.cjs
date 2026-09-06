const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../electron/vocabulary.cjs');
const { starterCards, starterPacks } = require('../electron/vocabulary-starters.cjs');
const now = new Date('2026-09-06T08:00:00.000Z');
const minute = (n) => new Date(now.getTime() + n * 60000);
function populated() {
  const data = v.emptyVocabulary();
  v.addCards(data, starterCards('学术表达'), now);
  return data;
}

test('original starter packs have real cloze targets and valid cards', () => {
  for (const pack of starterPacks()) {
    const cards = starterCards(pack.subject);
    assert.equal(cards.length, pack.count);
    for (const card of cards) assert.notEqual(v.cloze(card.context, card.word), card.context);
  }
});

test('new quota, due-first order, pause-new and day rollover', () => {
  const data = populated();
  data.settings.dailyNewLimit = 2;
  assert.equal(v.queue(data, now).length, 2);
  const card = data.cards[0];
  v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 1 }, now);
  assert.equal(v.queue(data, now).length, 1);
  assert.equal(v.queue(data, minute(2))[0].id, card.id);
  data.settings.dailyNewLimit = 0;
  assert.deepEqual(v.queue(data, minute(2)).map((c) => c.id), [card.id]);
  data.settings.dailyNewLimit = 2;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(v.queue(data, tomorrow).filter((c) => c.schedule.state === 0).length, 2);
});

test('FSRS persists dates and review counts over a serialization round trip', () => {
  let data = populated();
  const card = data.cards[0];
  const result = v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 3 }, now);
  assert.equal(result.nextDue, minute(10).toISOString());
  data = v.normalizeVocabulary(JSON.parse(JSON.stringify(data)), now);
  assert.equal(data.cards[0].schedule.reps, 1);
  assert.equal(data.cards[0].schedule.due, result.nextDue);
  v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 3 }, minute(11));
  assert.ok(Date.parse(data.cards[0].schedule.due) > minute(11));
  assert.equal(data.logs.length, 2);
});

test('repeated clicks, early reviews and unknown ratings cannot change progress', () => {
  const data = populated();
  const card = data.cards[0];
  v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 4 }, now);
  const saved = JSON.stringify(data);
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 4 }, now));
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 4 }, now));
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 5 }, now));
  assert.equal(JSON.stringify(data), saved);
});

test('undo restores complete scheduling state and daily new allowance', () => {
  const data = populated();
  data.settings.dailyNewLimit = 1;
  const previous = JSON.stringify(data.cards[0].schedule);
  v.reviewCard(data, { id: data.cards[0].id, expectedReps: 0, rating: 2 }, now);
  assert.equal(v.queue(data, now).length, 0);
  v.undoReview(data);
  assert.equal(data.logs.length, 0);
  assert.equal(JSON.stringify(data.cards[0].schedule), previous);
  assert.equal(v.queue(data, now).length, 1);
});

test('imports merge without resetting existing progress or duplicating IDs', () => {
  const data = populated();
  v.reviewCard(data, { id: data.cards[0].id, expectedReps: 0, rating: 3 }, now);
  const source = populated();
  source.cards.push({ ...source.cards[0], word: 'theory', id: data.cards[0].id });
  const result = v.importVocabulary(data, { format: 'ph-vocabulary', version: 1, data: source }, now);
  assert.equal(result.added, 1);
  assert.equal(data.cards[0].schedule.reps, 1);
  assert.equal(new Set(data.cards.map((c) => c.id)).size, data.cards.length);
  assert.equal(v.addCards(data, [{ word: 'Evidence', meaning: 'duplicate' }], now).duplicates, 1);
});

test('schema rejects malicious word markup, nonfinite schedules and oversized imports', () => {
  const data = v.normalizeVocabulary({ cards: [{ word: '<img src=x>', meaning: 'x' },
    { word: 'test', meaning: '<script>never executable</script>', schedule: { due: now.toISOString(), stability: Infinity } }],
    settings: { dailyNewLimit: -100, retention: 1, mode: 'bad' } }, now);
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0].schedule.reps, 0);
  assert.equal(data.settings.dailyNewLimit, 10);
  assert.throws(() => v.addCards(data, Array(1001).fill({}), now));
  assert.throws(() => v.parseWordList('a'.repeat(500001)));
  assert.throws(() => v.importVocabulary(data, { cards: [] }, now));
});

test('suspension, deletion and edits never silently reset memory state', () => {
  const data = populated();
  const id = data.cards[0].id;
  v.reviewCard(data, { id, expectedReps: 0, rating: 1 }, now);
  v.updateCard(data, { id, suspended: true, ownExample: 'My evidence is reliable.' });
  assert.ok(!v.queue(data, minute(2)).some((c) => c.id === id));
  assert.equal(data.cards[0].schedule.reps, 1);
  v.updateCard(data, { id, suspended: false });
  assert.equal(v.queue(data, minute(2))[0].id, id);
  v.removeCard(data, id);
  assert.ok(!data.logs.some((l) => l.cardId === id));
});

test('paragraph extraction is bounded and retains original context and saved status', () => {
  const dictionary = { lookup: (word) => ({ exact: ['evidence', 'reliable'].includes(word) ? { word, translation: 'meaning' } : null }) };
  const result = v.paragraphCandidates('The evidence is reliable. No evidence is perfect.', dictionary, [{ word: 'evidence' }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].context, 'The evidence is reliable.');
  assert.equal(result[0].saved, true);
  assert.equal(v.cloze('Inference is not infer.', 'infer'), 'Inference is not _____.');
});

test('stats reflect actual distinct words and self-reported recall, not collection size', () => {
  const data = populated();
  assert.equal(v.snapshot(data, now).stats.recallRate, null);
  v.reviewCard(data, { id: data.cards[0].id, expectedReps: 0, rating: 1 }, now);
  v.reviewCard(data, { id: data.cards[1].id, expectedReps: 0, rating: 3 }, now);
  const stats = v.snapshot(data, now).stats;
  assert.equal(stats.todayWords, 2);
  assert.equal(stats.recallRate, 50);
  assert.equal(stats.days.at(-1).count, 2);
});
