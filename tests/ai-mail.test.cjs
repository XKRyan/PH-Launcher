'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiMailReader, safeBody } = require('../electron/ai-mail.cjs');
const { AI_MAIL_TOOLS, toolKind } = require('../electron/ai-tools.cjs');

function readerHarness({ allowed = true, revision = 'mail-a', client } = {}) {
  let currentRevision = revision;
  let permitted = allowed;
  const fake = client || {
    async list() { return { unreadOnly: false, items: [] }; },
    async read() { return {}; },
    async contacts() { return []; },
  };
  return {
    reader: createAiMailReader({
      getClient: () => fake,
      getRevision: () => currentRevision,
      assertAllowed: () => { if (!permitted) throw new Error('邮件读取权限已撤销或尚未单独确认'); },
    }),
    revoke: () => { permitted = false; },
    changeAccount: () => { currentRevision = 'mail-b'; },
  };
}

test('AI mail keywords and cursors reach the guarded client and preserve pagination', async () => {
  let request;
  const { reader } = readerHarness({ client: { list: async args => { request = args; return { items: [], total: 30, nextCursor: 20 }; } } });
  const result = await reader.execute('list_mail', { query: 'University talks', cursor: 10, limit: 10 });
  assert.deepEqual(request, { query: 'University talks', cursor: 10, limit: 10, unread: false });
  assert.equal(result.nextCursor, 20);
  assert.equal(result.total, 30);
});

test('AI mail list is capped and hides sensitive account-notification subjects', async () => {
  const { reader } = readerHarness({ client: {
    async list() {
      return { unreadOnly: true, items: Array.from({ length: 22 }, (_, index) => ({
        uid: String(index + 1), from: [{ name: '学校', address: 'notice@school.test' }], date: '2026-09-06T00:00:00Z',
        subject: index === 0 ? 'New Sign-In from https://bad.test/?token=secret' : `普通通知 ${index}`, unread: true, links: ['https://bad.test'], attachments: [{ name: 'x' }],
      })) };
    },
    async read() { throw new Error('not used'); }, async contacts() { return []; },
  } });
  const result = await reader.execute('list_mail', { unread: true, limit: 99 });
  assert.equal(result.items.length, 20);
  assert.match(result.items[0].subject, /自行查看/);
  assert.equal(Object.hasOwn(result.items[0], 'links'), false);
});

test('AI mail body hides URLs and credential-like lines, and blocks sensitive mail bodies', async () => {
  const { reader } = readerHarness({ client: {
    async list() { return { items: [] }; }, async contacts() { return []; },
    async read(uid) {
      if (uid === '1') return { uid, subject: '学习资料 https://example.test/?token=secret', from: [{ name: '老师 https://bad.test/?token=x', address: 'teacher@school.test' }], to: [], date: '2026-09-06', text: '请看 https://example.test/a?token=secret\n验证码：123456\n普通说明' };
      return { uid, subject: '密码重置', text: 'secret', from: [], to: [] };
    },
  } });
  const normal = await reader.execute('read_mail', { uid: '1' });
  assert.doesNotMatch(normal.text, /example\.test|123456/);
  assert.doesNotMatch(normal.subject, /example\.test|secret/);
  assert.doesNotMatch(normal.from[0].name, /bad\.test|token/);
  assert.match(normal.text, /已隐藏/);
  assert.equal(Object.hasOwn(normal, 'links'), false);
  const restricted = await reader.execute('read_mail', { uid: '2' });
  assert.equal(restricted.restricted, true);
  assert.equal(Object.hasOwn(restricted, 'text'), false);
});

test('permission revocation or account change prevents a mail result from crossing to AI', async () => {
  let harness;
  harness = readerHarness({ client: {
    async list() { harness.revoke(); return { items: [] }; }, async read() { return {}; }, async contacts() { return []; },
  } });
  await assert.rejects(harness.reader.execute('list_mail', {}), /权限已撤销/);
  harness = readerHarness({ client: {
    async list() { harness.changeAccount(); return { items: [] }; }, async read() { return {}; }, async contacts() { return []; },
  } });
  await assert.rejects(harness.reader.execute('list_mail', {}), /账号已变更/);
});

test('mail tool schemas are read-only and do not become command or write tools', () => {
  assert.deepEqual(AI_MAIL_TOOLS.map((tool) => tool.function.name), ['list_mail', 'read_mail', 'search_mail_contacts']);
  for (const tool of AI_MAIL_TOOLS) assert.equal(toolKind(tool.function.name), 'read');
});

test('URL punctuation does not expose a trailing secret path to the model', () => {
  const text = safeBody('请看 https://example.com/a(b)/secret-path?q=hidden\n后面是课程说明');
  assert.doesNotMatch(text, /example|secret-path|hidden/);
  assert.match(text, /后面是课程说明/);
});
