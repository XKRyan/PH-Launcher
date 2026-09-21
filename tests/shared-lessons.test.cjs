'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mandatoryKeys, parseEntries, resolveGroupKeys } = require('../electron/shared-lessons.cjs');

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

// 2026-09-18 实测：phix 云同步落盘时 lessons 段是按**字母序**写的
// （group → subject → teacher），而 PLL 自己写的时候 subject 在最前面。
// 旧实现只在遇到 `- subject:` 时才新建记录，于是同步下来的那份一条都读不出来 ——
// 个人课表显示"先选择你的教学组"，哪怕用户明明选过。另外真机上的文件是 **CRLF**，
// 旧实现 `split('\n')` 把行尾的 \r 留在字符串里，同样读不出来。
test('lessons 段的键顺序无关（phix 同步写的是字母序：group 在前）', () => {
  const entries = parseEntries([
    'lessons:',
    "- group: 'P'",
    "  subject: 'Computer Science HL'",
    "  teacher: 'Anqi Wang'",
    "- group: 'L'",
    "  subject: 'English B SL'",
    "  teacher: 'Xiaotian Xu'",
    '',
  ].join('\n'));
  assert.equal(entries.length, 2, '字母序那份也要能读出来');
  assert.deepEqual(entries[0], { group: 'P', subject: 'Computer Science HL', teacher: 'Anqi Wang' });
  assert.deepEqual(entries[1], { group: 'L', subject: 'English B SL', teacher: 'Xiaotian Xu' });
});

test('CRLF 行尾（Windows 上真机就是这种）照样能读', () => {
  const crlf = [
    'lessons:',
    "- group: 'P'",
    "  subject: 'Computer Science HL'",
    "  teacher: 'Anqi Wang'",
    'accounts:',
    '  edupage:',
    '    username: someone@example.com',
    '',
  ].join('\r\n');
  const entries = parseEntries(crlf);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { group: 'P', subject: 'Computer Science HL', teacher: 'Anqi Wang' });
});

test('列表项自带键（- group: P + 下一行 subject）也能合并成一条', () => {
  const entries = parseEntries('lessons:\n- group: P\n  subject: A\n- subject: B\n  group: L\n');
  assert.deepEqual(entries, [{ group: 'P', subject: 'A' }, { subject: 'B', group: 'L' }]);
});

test('没有 subject 的残留记录不算一条', () => {
  assert.deepEqual(parseEntries('lessons:\n- group: P\n- subject: OK\n'), [{ subject: 'OK' }]);
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

test('没有教学组的课（班会/国家课程）两边都按全班必修处理', () => {
  const options = [
    { key: 'g1', course: 'TOK', teacher: 'Jiabin Xu', groups: ['F'] },
    { key: 'n1', course: 'Native History 历史', teacher: '', groups: [] },
    { key: 'n2', course: 'Physical Education 体育与健康', teacher: 'Someone', groups: ['', '  '] },
  ];
  assert.deepEqual(mandatoryKeys(options), ['n1', 'n2'], '空组与只有空白的组都算"没有教学组"');
  assert.deepEqual(mandatoryKeys([]), []);
  assert.deepEqual(mandatoryKeys(null), []);
  assert.deepEqual(mandatoryKeys([{ course: '没有 key 的坏数据', groups: [] }]), [], '缺 key 的坏条目直接跳过');
});

test('打了教学组但属于"默认必选"的课（国家理科/班会）也算必修', () => {
  const options = [
    { key: 's1', course: 'Native Biology 国家生物', teacher: 'Sci', groups: ['G3'] },
    { key: 's2', course: '班会 Class meeting', teacher: 'Tutor', groups: ['A'] },
    { key: 's3', course: 'Physics HL1', teacher: 'Jing Jiang', groups: ['A'] },
  ];
  assert.deepEqual(mandatoryKeys(options), ['s1', 's2'], '默认必选课不受组号影响');
  assert.equal(mandatoryKeys(options).includes('s3'), false, '普通选课不受影响');
});
