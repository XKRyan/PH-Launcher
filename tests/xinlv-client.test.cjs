const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { XinlvTokenStore, XinlvClient, TOKEN_FILE_PREFIX } = require('../electron/xinlv-client.cjs');

function safeStorageFixture() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

test('Xinlv token store encrypts credentials and reloads without exposing token', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-xinlv-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'xinlv');
  const tokenStore = new XinlvTokenStore({ filePath, safeStorage: safeStorageFixture() });
  tokenStore.set('student@example.test', 'abc123-token');
  assert.ok(fs.readFileSync(filePath, 'utf8').startsWith(TOKEN_FILE_PREFIX));
  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('abc123-token'));
  const reopened = new XinlvTokenStore({ filePath, safeStorage: tokenStore.safeStorage });
  assert.deepEqual(reopened.load(), { username: 'student@example.test', token: 'abc123-token' });
  assert.equal(reopened.status().loggedIn, true);
});

test('Xinlv client logs in, sends bearer auth, and supports sync/chat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-xinlv-client-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenStore = new XinlvTokenStore({ filePath: path.join(dir, 'token'), safeStorage: safeStorageFixture() });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/login/')) return new Response(JSON.stringify({ token: 'server-token', username: body.username }), { status: 200 });
    if (url.endsWith('/launcher/sync/')) return new Response(JSON.stringify({ snapshot: null, revision: 0 }), { status: 200 });
    if (url.endsWith('/chat/')) return new Response(JSON.stringify({ reply: '收到' }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = new XinlvClient({ baseUrl: 'https://xin-lv.com', fetchImpl, tokenStore });
  await client.login('student@example.test', 'password');
  assert.equal(client.status().loggedIn, true);
  await client.pullSnapshot();
  await client.chat('你好', { tasks: [{ title: 'EE' }] });
  assert.equal(requests[1].options.headers.Authorization, 'Bearer server-token');
  assert.deepEqual(JSON.parse(requests[2].options.body).launcher_context.tasks[0], { title: 'EE' });
});
