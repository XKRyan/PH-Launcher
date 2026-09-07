'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTEXTS, findContext } = require('../electron/vocabulary-contexts.cjs');

const LEVEL_COUNTS = { foundation: 10, intermediate: 20, advanced: 30 };

function words(sentence) {
  return sentence.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*/g) || [];
}

test('context catalog has sixty unique words in the requested level distribution', () => {
  assert.equal(CONTEXTS.length, 60);
  assert.equal(new Set(CONTEXTS.map((entry) => entry.word)).size, CONTEXTS.length);
  assert.deepEqual(
    Object.fromEntries(Object.keys(LEVEL_COUNTS).map((level) => [level, CONTEXTS.filter((entry) => entry.level === level).length])),
    LEVEL_COUNTS,
  );
});

test('each sentence is natural-sized and contains its base-form target exactly once as a whole word', () => {
  for (const entry of CONTEXTS) {
    assert.match(entry.word, /^[a-z]+$/, entry.word);
    assert.ok(Object.hasOwn(LEVEL_COUNTS, entry.level), `${entry.word}: invalid level`);
    const sentenceWords = words(entry.sentence);
    assert.ok(sentenceWords.length >= 12 && sentenceWords.length <= 26, `${entry.word}: ${sentenceWords.length} words`);
    const occurrences = sentenceWords.filter((word) => word.toLowerCase() === entry.word).length;
    assert.equal(occurrences, 1, `${entry.word}: target occurrence count`);
    assert.doesNotMatch(entry.sentence, new RegExp(`\\b${entry.word}\\s+means\\b`, 'i'), `${entry.word}: definition-style sentence`);
  }
});

test('contexts are offline plain text without markup or URLs', () => {
  for (const entry of CONTEXTS) {
    assert.doesNotMatch(entry.sentence, /<[^>]*>|https?:\/\/|www\./i, entry.word);
    assert.doesNotMatch(entry.sentence, /[\r\n\0]/, entry.word);
  }
});

test('catalog covers the original starter words and requested difficult additions', () => {
  const expected = [
    'evidence', 'assumption', 'infer', 'justify', 'evaluate', 'perspective', 'implication', 'contrast', 'ambiguous', 'coherent', 'relevant', 'nevertheless',
    'hypothesis', 'variable', 'uncertainty', 'equilibrium', 'concentration', 'catalyst', 'diffusion', 'adaptation', 'momentum', 'proportional', 'replicate', 'anomaly',
    'scarcity', 'incentive', 'elasticity', 'externality', 'inequality', 'intervention', 'bias', 'sovereignty', 'causation', 'sustainable', 'migration', 'disparity',
    'corroborate', 'equivocal', 'inadvertent', 'tenuous', 'ostensible',
  ];
  for (const word of expected) assert.ok(findContext(word), word);
});

test('findContext is case-insensitive, trims input, and returns null for unknown values', () => {
  const context = findContext('  Corroborate ');
  assert.equal(context.word, 'corroborate');
  assert.equal(context.level, 'advanced');
  assert.equal(findContext('not-in-catalog'), null);
  assert.equal(findContext(null), null);
});
