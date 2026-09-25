'use strict';
// 发一封带**内嵌图片 + 普通附件**的 HTML 测试邮件到自己邮箱，给真机验证用。
// 用法： node send-inline-test-mail.js <dataDir>
// 凭据从共用 settings.yaml 的 accounts 里读（只在本进程内用，不打印）。
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const dataDir = process.argv[2];
if (!dataDir) { console.error('用法: node send-inline-test-mail.js <dataDir>'); process.exit(2); }
const yaml = fs.readFileSync(path.join(dataDir, 'settings.yaml'), 'utf8');

function block(name) {
  const lines = yaml.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) { if (line.startsWith(`${name}:`)) inside = true; continue; }
    if (line.trim() && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}
const mailBlock = block('accounts').split(/\r?\n/)
  .reduce((acc, line) => {
    const match = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
    if (match) acc[match[1]] = match[2].replace(/^'|'$/g, '');
    return acc;
  }, {});
const email = mailBlock.email;
// 与 mail-client.cjs 一致：优先客户端授权码，没有才用网页密码。
const secret = mailBlock.authcode || mailBlock.password;
const smtpHost = mailBlock.smtp_host || 'smtp.qiye.163.com';
if (!email || !secret) { console.error('读不到邮箱凭据'); process.exit(1); }

// 一张 8x8 的红色 PNG（够看清"图片到底显示了没有"）
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR42mP8z8Dwn4GKgIlhFIxs'
  + 'AArAAhiGGiMAHGAUjAIYBaMAhooBRgGMAhgFowCGigFGAQwVAwAAp3wH/8k1mS0AAAAASUVORK5CYII=',
  'base64');

(async () => {
  const transporter = nodemailer.createTransport({
    host: smtpHost, port: 465, secure: true, auth: { user: email, pass: secret },
  });
  const subject = `[PHIX 自动测试] 内嵌图片与附件 ${Date.now().toString(36)}`;
  const info = await transporter.sendMail({
    from: email,
    to: email,
    subject,
    text: '这是一封自动测试邮件（纯文本版）。\n第二行。',
    html: '<div style="font-family:sans-serif"><p>这是一封自动测试邮件。</p>'
      + '<p>下面是一张内嵌图片（cid）：</p>'
      + '<p><img src="cid:phl-test-image" width="32" height="32" alt="内嵌图"/></p>'
      + '<p>以及一个外部图片（不应自动加载）：<img src="https://phix.ing/static/logo.png" width="24"/></p>'
      + '<p>结束。</p></div>',
    attachments: [
      { filename: '内嵌图.png', content: png, cid: 'phl-test-image', contentType: 'image/png' },
      { filename: '测试附件.txt', content: Buffer.from('附件内容：供转发验证用。', 'utf8'), contentType: 'text/plain' },
    ],
  });
  console.log('SENT', JSON.stringify({ subject, messageId: info.messageId }));
  process.exit(0);
})().catch((error) => {
  console.error('SEND_FAILED', String(error && error.message || error).slice(0, 200));
  process.exit(1);
});
