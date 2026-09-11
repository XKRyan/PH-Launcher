'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntries, resolveGroupKeys } = require('../electron/shared-lessons.cjs');

const SETTINGS = [
  'version: 1',
  'lessons:',
  '- subject: Physics HL1',
  '  teacher: Jing Jiang',
  "  group: 'A'",
  '- subject: TOK',
  '  teacher: Jiabin Xu',
  '  group: F',
  'accounts:',
  '  edupage:',
  '    username: someone@example.com',
  '',
].join('\n');

test('shared lessons parse into subject/teacher/group entries', () => {
  const entries = parseEntries(SETTINGS);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { subject: 'Physics HL1', teacher: 'Jing Jiang', group: 'A' });
  assert.deepEqual(entries[1], { subject: 'TOK', teacher: 'Jiabin Xu', group: 'F' });
});

test('parsing stops at the next top-level section', () => {
  // accounts: 段里的 username 不能被当成选课字段读进来。
  const entries = parseEntries(SETTINGS);
  assert.equal(entries.some((entry) => String(entry.subject).includes('@')), false);
  assert.equal(entries[0].username, undefined);
});

test('missing or broken settings text never throws', () => {
  assert.deepEqual(parseEntries(''), []);
  assert.deepEqual(parseEntries(null), []);
  assert.deepEqual(parseEntries('lessons:\n- teacher: nobody\n'), []);
});

test('teacher disambiguates the same subject taught in several groups', () => {
  const options = [
    { key: 'k1', course: 'English B SL', teacher: 'Xiaotian Xu', groups: ['L'] },
    { key: 'k2', course: 'English B SL', teacher: 'Someone Else', groups: ['L'] },
    { key: 'k3', course: 'English B SL', teacher: 'Third Person', groups: ['M'] },
  ];
  assert.deepEqual(resolveGroupKeys([{ subject: 'English B SL', teacher: 'Xiaotian Xu', group: 'L' }], options), ['k1']);
});

test('a group written as A/B matches either group', () => {
  const options = [
    { key: 'k1', course: 'TOK', teacher: 'Jiabin Xu', groups: ['A'] },
    { key: 'k2', course: 'TOK', teacher: 'Jiabin Xu', groups: ['B'] },
    { key: 'k3', course: 'TOK', teacher: 'Jiabin Xu', groups: ['C'] },
  ];
  assert.deepEqual(resolveGroupKeys([{ subject: 'TOK', teacher: 'Jiabin Xu', group: 'A/B' }], options), ['k1', 'k2']);
});

test('an unknown teacher falls back to subject plus group', () => {
  const options = [{ key: 'k1', course: 'TOK', teacher: 'New Teacher', groups: ['F'] }];
  assert.deepEqual(resolveGroupKeys([{ subject: 'TOK', teacher: 'Old Teacher', group: 'F' }], options), ['k1']);
});

test('a lesson that is not in the timetable matches nothing', () => {
  const options = [{ key: 'k1', course: 'Physics HL1', teacher: 'Jing Jiang', groups: ['A'] }];
  assert.deepEqual(resolveGroupKeys([{ subject: 'Chemistry HL1', teacher: 'Nobody', group: 'A' }], options), []);
  assert.deepEqual(resolveGroupKeys([{ subject: 'Physics HL1', teacher: 'Jing Jiang', group: 'Z' }], options), []);
});

test('the same option is only reported once', () => {
  const options = [{ key: 'k1', course: 'TOK', teacher: 'Jiabin Xu', groups: ['F'] }];
  const entries = [
    { subject: 'TOK', teacher: 'Jiabin Xu', group: 'F' },
    { subject: 'tok', teacher: 'Jiabin Xu', group: 'F' },
  ];
  assert.deepEqual(resolveGroupKeys(entries, options), ['k1']);
});

test('resolving against an empty timetable returns nothing instead of throwing', () => {
  assert.deepEqual(resolveGroupKeys([{ subject: 'TOK', group: 'F' }], []), []);
  assert.deepEqual(resolveGroupKeys([{ subject: 'TOK', group: 'F' }], null), []);
});
