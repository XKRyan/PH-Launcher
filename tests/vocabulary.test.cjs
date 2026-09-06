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
  const card = v.queue(data, now)[0];
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
  const card = v.queue(data, now)[0];
  const result = v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 3 }, now);
  assert.equal(result.nextDue, minute(10).toISOString());
  data = v.normalizeVocabulary(JSON.parse(JSON.stringify(data)), now);
  assert.equal(data.cards.find((item) => item.id === card.id).schedule.reps, 1);
  assert.equal(data.cards.find((item) => item.id === card.id).schedule.due, result.nextDue);
  v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 3 }, minute(11));
  assert.ok(Date.parse(data.cards.find((item) => item.id === card.id).schedule.due) > minute(11));
  assert.equal(data.logs.length, 2);
});

test('repeated clicks, early reviews and unknown ratings cannot change progress', () => {
  const data = populated();
  const card = v.queue(data, now)[0];
  v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 4 }, now);
  const saved = JSON.stringify(data);
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 4 }, now));
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 4 }, now));
  assert.throws(() => v.reviewCard(data, { id: card.id, expectedReps: 1, rating: 5 }, now));
  assert.equal(JSON.stringify(data), saved);
});

test('review validation uses the same selected word-book scope as the displayed queue', () => {
  const data = v.emptyVocabulary();
  data.settings.dailyNewLimit = 1;
  v.addCards(data, [
    { word: 'apple', meaning: 'a fruit', subject: 'A' },
    { word: 'zebra', meaning: 'an animal', subject: 'B' },
  ], now);
  const globallyChosen = v.queue(data, now)[0];
  const subject = globallyChosen.subject === 'A' ? 'B' : 'A';
  const scoped = v.queue(data, now, subject)[0];
  assert.notEqual(globallyChosen.id, scoped.id);
  assert.doesNotThrow(() => v.reviewCard(data, { id: scoped.id, expectedReps: 0, rating: 3, mode: 'meaning', subject }, now));
});

test('undo restores complete scheduling state and daily new allowance', () => {
  const data = populated();
  data.settings.dailyNewLimit = 1;
  const card = v.queue(data, now)[0];
  const previous = JSON.stringify(card.schedule);
  v.reviewCard(data, { id: card.id, expectedReps: 0, rating: 2 }, now);
  assert.equal(v.queue(data, now).length, 0);
  v.undoReview(data);
  assert.equal(data.logs.length, 0);
  assert.equal(JSON.stringify(data.cards.find((item) => item.id === card.id).schedule), previous);
  assert.equal(v.queue(data, now).length, 1);
});

test('imports merge without resetting existing progress or duplicating IDs', () => {
  const data = populated();
  const existing = v.queue(data, now)[0];
  v.reviewCard(data, { id: existing.id, expectedReps: 0, rating: 3 }, now);
  const source = populated();
  source.cards.push({ ...source.cards[0], word: 'theory', id: existing.id });
  const result = v.importVocabulary(data, { format: 'ph-vocabulary', version: 1, data: source }, now);
  assert.equal(result.added, 1);
  assert.equal(data.cards.find((item) => item.id === existing.id).schedule.reps, 1);
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

test('fractional FSRS counters and impossible learning steps reset the complete schedule', () => {
  const base = { due: minute(-1).toISOString(), last_review: minute(-10).toISOString(), state: 2,
    stability: 1, difficulty: 5, elapsed_days: 1, scheduled_days: 1, reps: 1, lapses: 0, learning_steps: 0 };
  for (const schedule of [{ ...base, reps: 0.5 }, { ...base, learning_steps: 1 }, { ...base, state: 1, learning_steps: 2 },
    { ...base, state: 9 }, { ...base, state: 0, reps: 1 }, { ...base, lapses: 2 }]) {
    const data = v.normalizeVocabulary({ cards: [{ word: 'test', meaning: '测试', schedule }] }, now);
    assert.equal(data.cards[0].schedule.state, 0);
    assert.equal(data.cards[0].schedule.reps, 0);
    assert.doesNotThrow(() => v.snapshot(data, now));
  }
});

test('suspension, deletion and edits never silently reset memory state', () => {
  const data = populated();
  const id = v.queue(data, now)[0].id;
  v.reviewCard(data, { id, expectedReps: 0, rating: 1 }, now);
  v.updateCard(data, { id, suspended: true, ownExample: 'My evidence is reliable.' });
  assert.ok(!v.queue(data, minute(2)).some((c) => c.id === id));
  assert.equal(data.cards.find((item) => item.id === id).schedule.reps, 1);
  assert.equal(data.cards.find((item) => item.id === id).ownExample, 'My evidence is reliable.');
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

test('a usable cloze sentence contains the whole target exactly once', () => {
  assert.equal(v.usableCloze('Reliable evidence supports the conclusion.', 'evidence'), true);
  assert.equal(v.usableCloze('Evidence supports evidence.', 'evidence'), false);
  assert.equal(v.usableCloze('There is no target here.', 'evidence'), false);
  const data = v.normalizeVocabulary({ cards: [
    { word: 'evidence', meaning: '证据', context: 'Evidence supports evidence.' },
    { word: 'reliable', meaning: '可靠的', context: 'The reliable witness described the event clearly.' },
  ] }, now);
  assert.equal(v.snapshot(data, now).study.hasContext, 1);
});

test('stats reflect actual distinct words and self-reported recall, not collection size', () => {
  const data = populated();
  assert.equal(v.snapshot(data, now).stats.recallRate, null);
  const [first, second] = v.queue(data, now);
  v.reviewCard(data, { id: first.id, expectedReps: 0, rating: 1 }, now);
  v.reviewCard(data, { id: second.id, expectedReps: 0, rating: 3 }, now);
  const stats = v.snapshot(data, now).stats;
  assert.equal(stats.todayWords, 2);
  assert.equal(stats.recallRate, 50);
  assert.equal(stats.days.at(-1).count, 2);
});
