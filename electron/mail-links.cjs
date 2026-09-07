'use strict';
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const { parseHTML } = require('linkedom');

const MAX_MAIL_LINKS = 40;
const MAX_LINK_LENGTH = 8192;
const MAX_HTML_BYTES = 10 * 1024 * 1024;

function safeMailUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/.test(raw)) return null;
  if (!/^https:\/\//i.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname;
  if (!host.includes('.') || host.endsWith('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return null;
  return url.href.length <= MAX_LINK_LENGTH ? url.href : null;
}

function cleanLinkLabel(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function extractMailLinks(uid, parsed = {}) {
  const links = []; const seen = new Set();
  function add(raw, label) {
    if (links.length >= MAX_MAIL_LINKS) return;
    const url = safeMailUrl(String(raw || '').trim());
    if (!url || seen.has(url)) return;
    seen.add(url);
    const host = new URL(url).host;
    let title = cleanLinkLabel(label);
    // URLs may carry password-reset tokens. Only the actual host is presented.
    if (!title || /https?:\/\/|[?&](?:token|key|code|password)=/i.test(title)) title = host;
    links.push({ id: `link-${createHash('sha256').update(String(uid)).update('\0').update(url).digest('hex').slice(0, 24)}`, label: title, host, url });
  }
  const html = Buffer.isBuffer(parsed.html) ? parsed.html.toString('utf8') : typeof parsed.html === 'string' ? parsed.html : '';
  if (html && Buffer.byteLength(html, 'utf8') <= MAX_HTML_BYTES) {
    try {
      const { document } = parseHTML(html);
      for (const node of document.querySelectorAll('script,style,template,noscript,iframe,object,svg')) node.remove();
      let examined = 0;
      for (const anchor of document.querySelectorAll('a[href]')) {
        if (++examined > 400 || links.length >= MAX_MAIL_LINKS) break;
        const alt = anchor.querySelector('img[alt]')?.getAttribute('alt');
        add(anchor.getAttribute('href'), anchor.textContent.trim() || alt || anchor.getAttribute('aria-label') || anchor.getAttribute('title'));
      }
    } catch { /* Keep reading plain text even when an HTML part cannot be parsed. */ }
  }
  if (links.length < MAX_MAIL_LINKS && typeof parsed.text === 'string' && Buffer.byteLength(parsed.text) <= MAX_HTML_BYTES) {
    const candidates = parsed.text.matchAll(/https:\/\/[^\s<>"'\u3000-\u303f]+/gi);
    let examined = 0;
    for (const match of candidates) {
      if (++examined > 400 || links.length >= MAX_MAIL_LINKS) break;
      let raw = match[0].replace(/[.,;!]+$/, '');
      // Drop prose closing punctuation, but retain balanced URL parentheses.
      if (raw.endsWith(')') && (raw.match(/\)/g)?.length || 0) > (raw.match(/\(/g)?.length || 0)) raw = raw.slice(0, -1);
      add(raw, '');
    }
  }
  return links;
}

module.exports = { safeMailUrl, extractMailLinks, MAX_MAIL_LINKS, MAX_LINK_LENGTH };
