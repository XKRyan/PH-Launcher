const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('../electron/vocabulary-catalog.cjs');
const placement = require('../electron/vocabulary-placement.cjs');

const databasePath = path.join(__dirname, '..', 'assets', 'dictionary', 'ecdict.db');

test('ECDICT catalog exposes a licensed, non-official bounded directory', () => {
  const entries = catalog.catalog(databasePath);
  assert.ok(entries.some((entry) => entry.id === 'ecdict-gk'));
  for (const entry of entries) {
    assert.equal(entry.license, 'MIT License');
    assert.match(entry.sourceUrl, /^https:\/\//);
    assert.ok(entry.count > 0);
  }
  const words = catalog.words('ecdict-oxford-core', 7, databasePath);
  assert.equal(words.length, 7);
  assert.ok(words.every((word) => /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/.test(word)));
  assert.throws(() => catalog.words('not-a-list', 5, databasePath));
  assert.equal(catalog.words('ecdict-gk', 5000, databasePath).length <= 1000, true);
  const withoutFirst = catalog.words('ecdict-oxford-core', 7, databasePath, { excludeWords: [words[0]] });
  assert.equal(withoutFirst.includes(words[0]), false);
  assert.equal(catalog.catalog().every((entry) => entry.count === null), true);
  entries[0].count = -1;
  entries[0].levels.push('invalid');
  assert.ok(catalog.catalog(databasePath)[0].count > 0);
  assert.equal(catalog.catalog(databasePath)[0].levels.includes('invalid'), false);
});

test('exam-reference and deep-reading filters use exact ECDICT tags and preserve learned-word exclusions', () => {
  const lists = [
    ['ecdict-toefl-core', 'toefl', (entry) => entry.frq >= 1 && entry.frq <= 6000],
    ['ecdict-toefl-extended', 'toefl', (entry) => entry.frq === 0 || entry.frq > 6000 || entry.frq === null],
    ['ecdict-ielts-reference', 'ielts', () => true],
    ['ecdict-cet4-reference', 'cet4', () => true],
    ['ecdict-cet6-reference', 'cet6', () => true],
    ['ecdict-gre-extended', 'gre', () => true],
    ['ecdict-deep-reading', null, (entry) => entry.frq >= 10001 && entry.frq <= 30000],
  ];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const [id, tag, matchesFrequency] of lists) {
      const selected = catalog.words(id, 8, databasePath);
      assert.ok(selected.length > 0, `${id} should have bundled entries`);
      for (const word of selected) {
        const entry = database.prepare('SELECT tags, frq FROM entries WHERE word = ? COLLATE NOCASE').get(word);
        assert.ok(entry, `${word} must be an ECDICT entry`);
        if (tag) assert.ok(String(entry.tags || '').split(/\s+/).includes(tag), `${word} must have the exact ${tag} tag`);
        assert.equal(matchesFrequency(entry), true, `${word} must satisfy ${id}'s frequency filter`);
      }
      const excludingFirst = catalog.words(id, 8, databasePath, { excludeWords: [selected[0]] });
      assert.equal(excludingFirst.some((word) => word.toLowerCase() === selected[0].toLowerCase()), false);
    }
  } finally {
    database.close();
  }
});

test('placement is an optional transparent orientation, not a score claim', () => {
  assert.equal(placement.questions().length, 8);
  assert.equal(placement.grade({}).recommendedLevel, 'intermediate');
  assert.equal(placement.grade({ exam: 'toefl-legacy', score: 55 }).recommendedLevel, 'foundation');
  assert.equal(placement.grade({ exam: 'toefl-current', score: 5 }).recommendedLevel, 'advanced');
  assert.equal(placement.grade({ exam: 'ielts', score: 7.5 }).recommendedLevel, 'advanced');
  assert.equal(placement.levelFromExam('ielts', ''), null);
  assert.equal(placement.levelFromExam('toefl-legacy', null), null);
  assert.equal(placement.levelFromExam('toefl-current', 5.2), null);
  assert.throws(() => placement.grade({ answers: { 'basic-1': null } }), /完成全部/);
  const result = placement.grade({ answers: { 'basic-1': 3, 'basic-2': 0, 'basic-3': 1, 'basic-4': 2, 'academic-1': 1, 'academic-2': 3, 'academic-3': 0, 'academic-4': 2 } });
  assert.deepEqual({ score: result.score, level: result.recommendedLevel, source: result.source }, { score: 8, level: 'advanced', source: 'quiz' });
  assert.match(result.note, /不是标准化/);
});
