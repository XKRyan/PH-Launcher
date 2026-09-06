const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { CredentialVault, CREDENTIAL_FILE_PREFIX, normalizeUsername, normalizePassword } = require('../electron/credential-vault.cjs');

function secureStorageFixture() {
  const key = crypto.randomBytes(32);
  return {
    available: true,
    encryptFailure: false,
    decryptFailure: false,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) {
      if (this.encryptFailure) throw new Error(`provider accidentally exposes ${value}`);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      if (this.decryptFailure) throw new Error('provider failed');
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-credential-test-'));
  const filePath = path.join(directory, 'credentials');
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ph-credential-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const safeStorage = secureStorageFixture();
  const config = { filePath, safeStorage, platform: 'win32', now: () => new Date('2026-09-06T08:00:00Z'), ...options };
  const vault = new CredentialVault(config);
  return { vault, config, safeStorage, filePath, directory };
}

const first = { siteId: 'mail', username: 'student@example.test', password: 'fixture-secret-123', autoFill: true };

test('credentials are encrypted at rest, reload correctly, and never appear in renderer status', (t) => {
  const { vault, config, filePath, directory } = fixture(t);
  const result = vault.saveCredential(first);
  const disk = fs.readFileSync(filePath, 'utf8');
  assert.ok(disk.startsWith(CREDENTIAL_FILE_PREFIX));
  assert.ok(!disk.includes(first.password));
  assert.ok(!disk.includes(first.username));
  assert.ok(!JSON.stringify(result).includes(first.password));
  assert.equal(result.sites.mail.saved, true);
  assert.equal(result.sites.mail.displayUsername, 's•••@example.test');
  assert.equal(result.sites.mail.updatedAt, '2026-09-06T08:00:00.000Z');
  assert.equal(Object.hasOwn(result.sites.mail, 'password'), false);
  const reopened = new CredentialVault(config);
  assert.deepEqual(reopened.getForFill('mail'), { username: first.username, password: first.password });
  assert.deepEqual(fs.readdirSync(directory), ['credentials']);
});

test('macOS is supported while Linux basic_text and missing OS storage fail closed', (t) => {
  const { config } = fixture(t);
  assert.equal(new CredentialVault({ ...config, platform: 'darwin' }).status().supported, true);
  for (const overrides of [{ platform: 'linux' }, { safeStorage: null }, { safeStorage: { isEncryptionAvailable: () => true } }]) {
    const vault = new CredentialVault({ ...config, ...overrides });
    assert.equal(vault.status().supported, false);
    assert.throws(() => vault.saveCredential(first));
    assert.equal(vault.getForFill('mail', { allowDisabled: true }), null);
    assert.equal(fs.existsSync(config.filePath), false);
  }
});

test('unavailable OS key never persists or fills credentials', (t) => {
  const { vault, safeStorage, filePath } = fixture(t);
  safeStorage.available = false;
  assert.equal(vault.status().supported, false);
  assert.throws(() => vault.saveCredential(first));
  assert.equal(fs.existsSync(filePath), false);
  safeStorage.available = true;
  vault.saveCredential(first);
  safeStorage.available = false;
  assert.equal(vault.getForFill('mail', { allowDisabled: true }), null);
});

test('explicitly disabled autofill still allows manual fill and password-preserving edits', (t) => {
  const { vault, config } = fixture(t);
  vault.saveCredential({ ...first, autoFill: false });
  assert.equal(vault.getForFill('mail'), null);
  assert.deepEqual(vault.getForFill('mail', { allowDisabled: true }), { username: first.username, password: first.password });
  vault.saveCredential({ siteId: 'mail', username: 'new-account', password: '', autoFill: false });
  assert.deepEqual(new CredentialVault(config).getForFill('mail', { allowDisabled: true }), { username: 'new-account', password: first.password });
});

test('deleting one credential leaves other sites intact and survives reopening', (t) => {
  const { vault, config } = fixture(t);
  vault.saveCredential(first);
  vault.saveCredential({ ...first, siteId: 'edupage', username: 'school-account' });
  assert.equal(vault.removeCredential('mail').existed, true);
  assert.equal(vault.getForFill('mail'), null);
  const reopened = new CredentialVault(config);
  assert.equal(reopened.getForFill('mail'), null);
  assert.equal(reopened.getForFill('edupage').username, 'school-account');
  assert.equal(reopened.removeCredential('mail').existed, false);
});

test('encryption failure does not mutate memory or disk or leak provider input', (t) => {
  const { vault, safeStorage, filePath } = fixture(t);
  vault.saveCredential(first);
  const before = fs.readFileSync(filePath);
  safeStorage.encryptFailure = true;
  assert.throws(() => vault.saveCredential({ ...first, password: 'replacement-fixture-secret' }), (error) => {
    assert.ok(!error.message.includes('replacement-fixture-secret'));
    assert.ok(!error.message.includes(first.username));
    return true;
  });
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(vault.getForFill('mail').password, first.password);
});

for (const operation of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`${operation} failure preserves previous file and in-memory password without temp debris`, (t) => {
    let shouldFail = false;
    const fileSystem = new Proxy(fs, { get(target, property) {
      if (property === operation) return (...args) => {
        if (shouldFail) throw new Error('injected disk failure');
        return target[property](...args);
      };
      return target[property];
    } });
    const { vault, config, filePath, directory } = fixture(t, { fileSystem });
    vault.saveCredential(first);
    const before = fs.readFileSync(filePath);
    shouldFail = true;
    assert.throws(() => vault.saveCredential({ ...first, password: 'not-persisted' }));
    assert.equal(vault.getForFill('mail').password, first.password);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.deepEqual(fs.readdirSync(directory), ['credentials']);
    assert.equal(new CredentialVault(config).getForFill('mail').password, first.password);
    assert.throws(() => vault.removeCredential('mail'));
    assert.equal(vault.getForFill('mail').password, first.password);
  });
}

test('corruption and changed OS keys preserve the original ciphertext and prohibit writes', (t) => {
  const { vault, config, filePath } = fixture(t);
  vault.saveCredential(first);
  const before = fs.readFileSync(filePath);
  const differentAccount = new CredentialVault({ ...config, safeStorage: secureStorageFixture() });
  assert.equal(differentAccount.getForFill('mail'), null);
  assert.ok(differentAccount.status().issue);
  assert.throws(() => differentAccount.saveCredential(first));
  assert.throws(() => differentAccount.removeCredential('mail'));
  assert.deepEqual(fs.readFileSync(filePath), before);
  fs.writeFileSync(filePath, `${CREDENTIAL_FILE_PREFIX}malformed!`, 'utf8');
  const corrupted = new CredentialVault(config);
  assert.ok(corrupted.status().issue);
  assert.throws(() => corrupted.saveCredential(first));
  assert.equal(fs.readFileSync(filePath, 'utf8'), `${CREDENTIAL_FILE_PREFIX}malformed!`);
});

test('plaintext legacy files are not imported or overwritten as passwords', (t) => {
  const { config, filePath } = fixture(t);
  const plaintext = JSON.stringify({ version: 1, records: { mail: first } });
  fs.writeFileSync(filePath, plaintext, 'utf8');
  const vault = new CredentialVault(config);
  assert.equal(vault.getForFill('mail'), null);
  assert.throws(() => vault.saveCredential(first));
  assert.equal(fs.readFileSync(filePath, 'utf8'), plaintext);
});

test('unsupported or partially invalid encrypted vaults fail closed, never silently discard credentials', (t) => {
  const { config, safeStorage, filePath } = fixture(t);
  for (const payload of [
    { version: 2, records: {} },
    { version: 1, records: [] },
    { version: 1, records: { mail: { username: 'valid', password: '' } } },
  ]) {
    const content = `${CREDENTIAL_FILE_PREFIX}${safeStorage.encryptString(JSON.stringify(payload)).toString('base64')}`;
    fs.writeFileSync(filePath, content, 'utf8');
    const vault = new CredentialVault(config);
    assert.ok(vault.status().issue);
    assert.throws(() => vault.saveCredential(first));
    assert.equal(fs.readFileSync(filePath, 'utf8'), content);
  }
});

test('credential validation rejects invalid sites and preserves significant password spaces', (t) => {
  const { vault } = fixture(t);
  assert.equal(normalizeUsername('  school-user  '), 'school-user');
  assert.equal(normalizePassword(' pass word ', { required: true }), ' pass word ');
  for (const username of ['', '\n', 'a\nb', 'a'.repeat(201)]) assert.throws(() => normalizeUsername(username));
  for (const password of ['', null, 'a\u0000b', 'a'.repeat(513)]) assert.throws(() => normalizePassword(password, { required: true }));
  for (const siteId of ['custom', '__proto__', 'constructor', 'https://evil.test']) {
    assert.throws(() => vault.saveCredential({ ...first, siteId }));
    assert.equal(vault.getForFill(siteId), null);
  }
});
