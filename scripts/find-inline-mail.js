'use strict';
// 只读：扫最近邮件，找出「有 HTML 正文 + 有内嵌图片（cid）」的那封，给真机验证用。
// 用法： node find-inline-mail.js <dataDir>
const fs = require('node:fs');
const path = require('node:path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const dataDir = process.argv[2];
const yaml = fs.readFileSync(path.join(dataDir, 'settings.yaml'), 'utf8');
const lines = yaml.split(/\r?\n/);
const out = []; let inside = false;
for (const line of lines) {
  if (!inside) { if (line.startsWith('accounts:')) inside = true; continue; }
  if (line.trim() && !/^\s/.test(line)) break;
  out.push(line);
}
const fields = out.reduce((acc, line) => {
  const m = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
  if (m) acc[m[1]] = m[2].replace(/^'|'$/g, '');
  return acc;
}, {});
const user = fields.email;
const pass = fields.authcode || fields.password;

(async () => {
  const client = new ImapFlow({ host: 'imap.qiye.163.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = (await client.search({ all: true }, { uid: true })).slice(-60);
    const results = [];
    for (const uid of uids.reverse()) {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const parsed = await simpleParser(Buffer.concat(chunks), { keepCidLinks: true, skipHtmlToText: true });
      const attachments = parsed.attachments || [];
      const cids = attachments.map((a) => String(a.cid || '').replace(/^<|>$/g, '')).filter(Boolean);
      const hasHtml = Boolean(parsed.html && String(parsed.html).length);
      if (hasHtml && cids.length) {
        results.push({
          uid: String(uid),
          subject: String(parsed.subject || '').slice(0, 60),
          htmlLength: String(parsed.html).length,
          inline: cids.length,
          attachments: attachments.length,
          cidNames: attachments.filter((a) => a.cid).map((a) => String(a.filename || '').slice(0, 30)).slice(0, 4),
        });
        if (results.length >= 5) break;
      }
    }
    console.log('INLINE_MAILS', JSON.stringify(results));
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  process.exit(0);
})().catch((error) => {
  console.error('FAILED', JSON.stringify({
    message: String(error && error.message || error).slice(0, 200),
    code: error && error.code,
    response: String(error && error.responseText || '').slice(0, 120),
    authenticationFailed: error && error.authenticationFailed,
  }));
  process.exit(1);
});
