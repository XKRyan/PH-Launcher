'use strict';
// Accounts shared through settings.yaml: the field mapping between the two
// launchers, what an import may take, and what an export may write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAccountsBlock, describeSharedAccounts, ownedPlatforms, planImport } = require('../electron/shared-accounts.cjs');
const { atomicWriteFileSync, readNestedMap, readTextFile, replaceBlock, serializeNestedMap } = require('../electron/settings-yaml.cjs');

const liteAccounts = {
  edupage: { username: 'student@example.com', subdomain: 'pingheschool', password: 'edupage-pass' },
  managebac: { base_url: 'https://shph.managebac.cn', email: 'student@example.com', password: 'mb-pass' },
  mail: { email: 'student@example.com', imap_host: 'imap.qiye.163.com', smtp_host: 'smtp.qiye.163.com', password: 'web-pass', authcode: 'client-code' },
  xinlv: { username: 'student', token: 'token-value' },
};

test('the shared block is described without leaking where each value came from', () => {
  const described = describeSharedAccounts(liteAccounts);
  assert.deepEqual(described.map((entry) => entry.platform), ['edupage', 'managebac', 'mail', 'xinlv']);
  assert.deepEqual(described[0], { platform: 'edupage', supported: true, username: 'student@example.com', hasPassword: true, hasAuthcode: false });
  assert.deepEqual(described[2], { platform: 'mail', supported: true, username: 'student@example.com', hasPassword: true, hasAuthcode: true });
  assert.equal(described[3].supported, true, 'xinlv is reported, even though this app signs in separately');
  assert.deepEqual(describeSharedAccounts({ unknown_platform: { username: 'x', password: 'y' } }).map((entry) => entry.supported), [false]);
  assert.deepEqual(describeSharedAccounts({ empty: {}, blank: { username: '', password: '' } }), []);
  assert.deepEqual(describeSharedAccounts(null), []);
});

test('an import takes complete entries only and never replaces a saved account', () => {
  const plan = planImport(liteAccounts, {});
  assert.deepEqual(plan.imported.map((entry) => entry.siteId), ['edupage', 'managebac', 'mail']);
  assert.deepEqual(plan.imported[0], { platform: 'edupage', siteId: 'edupage', username: 'student@example.com', password: 'edupage-pass', authcode: '' });
  assert.deepEqual(plan.imported[2], { platform: 'mail', siteId: 'mail', username: 'student@example.com', password: 'web-pass', authcode: 'client-code' });
  assert.deepEqual(plan.skipped, []);
  // A platform this app already saved is left alone.
  const partial = planImport(liteAccounts, { managebac: { saved: true }, mail: { saved: true } });
  assert.deepEqual(partial.imported.map((entry) => entry.siteId), ['edupage']);
  assert.deepEqual(partial.skipped, [{ platform: 'managebac', reason: 'already-saved' }, { platform: 'mail', reason: 'already-saved' }]);
  // Missing username or any usable secret is skipped, not half-imported.
  const broken = planImport({ edupage: { username: 'a' }, managebac: { email: 'a@b.com', password: '' }, mail: { email: 'a@b.com', authcode: 'code' } });
  assert.deepEqual(broken.imported.map((entry) => entry.siteId), ['mail']);
  assert.deepEqual(broken.skipped.map((entry) => entry.reason), ['incomplete', 'incomplete']);
  // An authcode alone is enough for mail; fields are flattened and cleaned.
  assert.equal(planImport({ mail: { username: 'x\n', authcode: ' c ' } }).imported[0].authcode, 'c');
});

test('an export refreshes only this app\'s platforms and keeps unknown ones', () => {
  const records = {
    mail: { username: 'student@example.com', password: 'web-pass', authcode: 'client-code' },
    managebac: { username: 'student@example.com', password: 'mb-pass' },
    edupage: null,
  };
  const existing = { xinlv: { username: 'student', token: 'token-value' }, edupage: { username: 'old@example.com', subdomain: 'pingheschool', password: 'old' } };
  const block = buildAccountsBlock(existing, records, {});
  assert.deepEqual(Object.keys(block).sort(), ['edupage', 'mail', 'managebac', 'xinlv']);
  assert.equal(block.managebac.base_url, 'https://shph.managebac.cn');
  assert.equal(block.mail.imap_host, 'imap.qiye.163.com');
  assert.equal(block.mail.smtp_host, 'smtp.qiye.163.com');
  assert.equal(block.mail.authcode, 'client-code');
  assert.equal(block.edupage.password, 'old', 'a platform this app cannot write stays as the other app left it');
  assert.equal(block.xinlv.token, 'token-value');
  // Xinlv is only written when this app actually has a session.
  assert.equal(buildAccountsBlock({}, records, { username: 'student', token: 't' }).xinlv.token, 't');
  assert.equal(buildAccountsBlock({}, records, { username: 'student' }).xinlv, undefined);
  assert.deepEqual(ownedPlatforms(records, {}), ['managebac', 'mail']);
  assert.deepEqual(ownedPlatforms({}, {}), []);
});

test('a full round trip rewrites only the accounts block of a real file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-accounts-'));
  const file = path.join(directory, 'settings.yaml');
  const original = ['version: 1', 'wizard_done: true', '', 'accounts:', '  xinlv:', '    username: student', '    token: token-value', '', 'agent:', '  mode: confirm', '', 'future_section:', '  keep: me', ''].join('\n');
  try {
    atomicWriteFileSync(file, original);
    const records = { managebac: { username: 'student@example.com', password: 'mb-pass' }, mail: { username: 'student@example.com', password: 'web-pass', authcode: 'client-code' } };
    const text = readTextFile(file);
    const merged = buildAccountsBlock(readNestedMap(text, 'accounts'), records, {});
    atomicWriteFileSync(file, replaceBlock(text, 'accounts', serializeNestedMap('accounts', merged)));
    const updated = readTextFile(file);
    assert.deepEqual(readNestedMap(updated, 'accounts').mail, { imap_host: 'imap.qiye.163.com', smtp_host: 'smtp.qiye.163.com', username: 'student@example.com', password: 'web-pass', authcode: 'client-code' });
    assert.equal(readNestedMap(updated, 'accounts').xinlv.token, 'token-value');
    assert.match(updated, /agent:\n {2}mode: confirm/);
    assert.match(updated, /future_section:\n {2}keep: me/);
    assert.match(updated, /^version: 1$/m);
    // And the other application can read back what was written.
    assert.deepEqual(planImport(readNestedMap(updated, 'accounts'), {}).imported.map((entry) => entry.platform), ['managebac', 'mail']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
