'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMailUrl, extractMailLinks, MAX_MAIL_LINKS } = require('../electron/mail-links.cjs');

test('mail link destinations accept HTTPS domains but not executable, local or credential-bearing URLs', () => {
  assert.equal(safeMailUrl('https://shph.managebac.cn/reset?token=dummy&x=1'), 'https://shph.managebac.cn/reset?token=dummy&x=1');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/test', 'http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://user:pass@example.com', 'https://example.com:9443', 'https://example.com\\@evil.com', 'https://example.com/\nreset', 'https://example.com/\u202ereset', '/reset?token=dummy', '//example.com/reset', 'https://example.com/' + 'x'.repeat(8192)]) assert.equal(safeMailUrl(url), null, url.slice(0, 60));
});

test('HTML email buttons survive alongside a shorter plain-text alternative without loading HTML', () => {
  const links = extractMailLinks('12', {
    text: 'Click the button below.',
    html: '<html><body><a href="https://shph.managebac.cn/reset?token=dummy&amp;x=1"><span>Reset password</span></a><img src="https://tracker.example.com/pixel"><script>fetch("https://example.com")</script></body></html>',
  });
  assert.equal(links.length, 1); assert.equal(links[0].label, 'Reset password');
  assert.equal(links[0].host, 'shph.managebac.cn');
  assert.equal(links[0].url, 'https://shph.managebac.cn/reset?token=dummy&x=1');
  assert.match(links[0].id, /^link-[a-f0-9]{24}$/);
});

test('image-only button labels, entity-encoded links, deduplication and bounded extraction work', () => {
  const links = extractMailLinks('1', { html: '<a href="https://example.com/reset"><img src="cid:button" alt="Reset password"></a><a href="https://example.com/reset">Again</a><a href="javascript:alert(1)">Bad</a><form action="https://example.com/send"><button>Send</button></form>' });
  assert.equal(links.length, 1); assert.equal(links[0].label, 'Reset password');
  const many = extractMailLinks('1', { html: Array.from({ length: 80 }, (_, i) => `<a href="https://example.com/${i}">Button ${i}</a>`).join('') });
  assert.equal(many.length, MAX_MAIL_LINKS);
  assert.notEqual(extractMailLinks('2', { text: 'https://example.com/reset' })[0].id, links[0].id);
});

test('plain text links are retained and token URLs are never used as button labels', () => {
  const links = extractMailLinks('1', { text: 'Open (https://example.com/reset?token=dummy).\nThen https://example.com/lesson.', html: '<a href="https://example.com/reset?token=dummy">https://example.com/reset?token=dummy</a>' });
  assert.equal(links.length, 2); assert.equal(links[0].label, 'example.com');
  assert.equal(links[1].url, 'https://example.com/lesson');
  assert.equal(extractMailLinks('1', { html: '<template><a href="https://example.com/hidden">Hidden</a></template>' }).length, 0);
});
