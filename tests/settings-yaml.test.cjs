'use strict';
// `settings.yaml` is shared with Pinghe Launcher Lite, so the editor must leave
// every byte it does not own alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  atomicWriteFileSync, parseYamlScalar, quoteScalar, readNestedMap, readScalarMap,
  readStringList, replaceBlock, serializeNestedMap, serializeScalarMap,
} = require('../electron/settings-yaml.cjs');

const FIXTURE = [
  '# Pinghe Launcher Lite 配置',
  'version: 1',
  'wizard_done: true',
  '',
  'accounts:',
  "  edupage:",
  "    username: someone@example.com",
  "    subdomain: pingheschool",
  "    password: 'pa:ss#word'",
  '  managebac:',
  '    base_url: https://shph.managebac.cn',
  '    email: someone@example.com',
  "    password: \"quo\\\"ted\"",
  '  mail:',
  '    email: someone@example.com',
  '    authcode: abcd1234',
  '  xinlv:',
  '    username: someone',
  '    token: token-value',
  '',
  'lessons:',
  '- subject: TOK',
  '  teacher: Jiabin Xu',
  "  group: ''",
  '',
  'agent:',
  '  workspace: D:\\work\\essay',
  "  workspaces: [D:\\work\\essay, 'D:\\a b']",
  '  mode: confirm',
  '  send_grades_to_llm: false',
  '',
  '# 未来的段落',
  'future_section:',
  '  nested:',
  '    key: keep-me',
  '',
].join('\n');

test('the accounts block is read as nested maps and the agent block as scalars', () => {
  const accounts = readNestedMap(FIXTURE, 'accounts');
  assert.equal(accounts.edupage.username, 'someone@example.com');
  assert.equal(accounts.edupage.password, 'pa:ss#word');
  assert.equal(accounts.managebac.password, 'quo"ted');
  assert.equal(accounts.mail.authcode, 'abcd1234');
  assert.equal(accounts.xinlv.token, 'token-value');
  const agent = readScalarMap(FIXTURE, 'agent');
  assert.equal(agent.workspace, 'D:\\work\\essay');
  assert.equal(agent.mode, 'confirm');
  assert.equal(agent.send_grades_to_llm, false);
  // The inline list is not part of the scalar map.
  assert.equal(Object.hasOwn(agent, 'workspaces'), false);
});

test('a workspace list is read from both inline and block style', () => {
  assert.deepEqual(readStringList(FIXTURE, 'agent', 'workspaces'), ['D:\\work\\essay', 'D:\\a b']);
  const block = ['agent:', '  workspace: D:\\one', '  workspaces:', '  - D:\\one', '  - D:\\two', 'ui:', '  course_order: []'].join('\n');
  assert.deepEqual(readStringList(block, 'agent', 'workspaces'), ['D:\\one', 'D:\\two']);
  assert.deepEqual(readStringList(block, 'ui', 'course_order'), []);
  assert.deepEqual(readStringList(FIXTURE, 'missing', 'x'), []);
});

test('replacing the accounts block changes nothing outside it', () => {
  const next = { edupage: { username: 'other@example.com', subdomain: 'pingheschool', password: 'new:pass' }, mail: { email: 'other@example.com', authcode: 'zzz' } };
  const updated = replaceBlock(FIXTURE, 'accounts', serializeNestedMap('accounts', next));
  const before = FIXTURE.split('\n').slice(0, FIXTURE.split('\n').indexOf('accounts:'));
  const after = updated.split('\n').slice(updated.split('\n').indexOf('lessons:'));
  assert.deepEqual(before, updated.split('\n').slice(0, updated.split('\n').indexOf('accounts:')));
  assert.deepEqual(after, FIXTURE.split('\n').slice(FIXTURE.split('\n').indexOf('lessons:')));
  assert.match(updated, /future_section:\n {2}nested:\n {4}key: keep-me/);
  assert.match(updated, /^# Pinghe Launcher Lite 配置$/m);
  assert.deepEqual(readNestedMap(updated, 'accounts').edupage, { username: 'other@example.com', subdomain: 'pingheschool', password: 'new:pass' });
  assert.deepEqual(readNestedMap(updated, 'accounts').xinlv, undefined, 'a platform we no longer list is dropped from the block we own');
  assert.equal(readScalarMap(updated, 'agent').mode, 'confirm', 'other blocks keep working');
});

test('a missing block is appended once and stays idempotent', () => {
  const body = serializeScalarMap('phl', { shared: true });
  const once = replaceBlock('version: 1\n', 'phl', body);
  assert.match(once, /^version: 1\n\nphl:\n {2}shared: true\n$/);
  const twice = replaceBlock(once, 'phl', body);
  assert.deepEqual(readScalarMap(twice, 'phl'), { shared: true });
  assert.equal(twice.match(/^phl:$/gm).length, 1);
  const empty = replaceBlock('', 'accounts', body);
  assert.match(empty, /^phl:\n {2}shared: true\n$/);
  assert.throws(() => replaceBlock(FIXTURE, 'accounts', 'accounts:'), /必须以换行结束/);
  assert.throws(() => serializeNestedMap('accounts', {}), /没有可写入/);
  assert.throws(() => serializeNestedMap('accounts', { edupage: {} }), /没有可写入/);
});

test('quoting round-trips values that YAML would otherwise reinterpret', () => {
  for (const value of ['abc: def', '#tag', '2026-09-10', 'D:\\a b', "it's", 'true', '123', ' padded ', '', '中文备注']) {
    const text = replaceBlock('', 'agent', serializeScalarMap('agent', { workspace: value }));
    assert.equal(readScalarMap(text, 'agent').workspace, value, value);
  }
  assert.equal(quoteScalar("it's"), "it's", 'a quote inside a plain scalar is fine');
  assert.equal(quoteScalar(true), 'true');
  assert.equal(quoteScalar(12), '12');
  assert.equal(quoteScalar('true'), "'true'", 'a string that looks like a boolean must be quoted');
  assert.equal(quoteScalar("'lead"), "'''lead'", 'a leading quote starts a quoted scalar, so it is escaped');
  assert.equal(parseYamlScalar(quoteScalar("'lead")), "'lead", 'escaping round-trips');
  assert.equal(parseYamlScalar(quoteScalar('true')), 'true');
  assert.equal(parseYamlScalar(quoteScalar(true)), true);
  assert.equal(quoteScalar('plain'), 'plain');
  assert.equal(parseYamlScalar("'a''b'"), "a'b");
  assert.equal(parseYamlScalar('true'), true);
  assert.equal(parseYamlScalar('12'), 12);
  assert.equal(parseYamlScalar(''), '');
  assert.equal(parseYamlScalar('~'), null);
  assert.equal(parseYamlScalar('plain text'), 'plain text');
});

test('malformed files never throw and never lose what is readable', () => {
  assert.deepEqual(readNestedMap('accounts:', 'accounts'), {});
  assert.deepEqual(readScalarMap('agent:\n\tworkspace: x', 'agent'), {});
  assert.deepEqual(readScalarMap('truncated: [1,', 'truncated'), {});
  assert.deepEqual(readNestedMap('', 'accounts'), {});
  assert.deepEqual(readStringList('agent:\n  workspaces:\n  - ', 'agent', 'workspaces'), []);
  assert.throws(() => readScalarMap('x', 'bad name'), /配置段名称无效/);
});

test('atomic writes are LF-only UTF-8 without BOM and leave no temp file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-settings-'));
  const file = path.join(directory, 'settings.yaml');
  try {
    atomicWriteFileSync(file, '\ufeffversion: 1\r\naccounts:\r\n  mail: {}\r\n');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.startsWith('\ufeff'), false);
    assert.equal(raw.includes('\r'), false);
    assert.match(raw, /^version: 1\n/);
    atomicWriteFileSync(file, 'version: 2\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'version: 2\n');
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')), []);
    // Nested directories are created when needed.
    const nested = path.join(directory, 'deep', 'settings.yaml');
    atomicWriteFileSync(nested, 'version: 1\n');
    assert.equal(fs.readFileSync(nested, 'utf8'), 'version: 1\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the whole file survives a read-modify-write cycle unchanged elsewhere', () => {
  const accounts = readNestedMap(FIXTURE, 'accounts');
  accounts.mail.authcode = 'rotated-code';
  const updated = replaceBlock(FIXTURE, 'accounts', serializeNestedMap('accounts', accounts));
  const removedBlock = (text) => {
    const lines = text.split('\n');
    const start = lines.indexOf('accounts:');
    const end = lines.findIndex((line, index) => index > start && line && !/^\s/.test(line));
    return [...lines.slice(0, start), ...lines.slice(end === -1 ? lines.length : end)].join('\n');
  };
  assert.equal(removedBlock(updated), removedBlock(FIXTURE));
  assert.equal(readNestedMap(updated, 'accounts').mail.authcode, 'rotated-code');
  assert.equal(readNestedMap(updated, 'accounts').edupage.password, 'pa:ss#word');
});
