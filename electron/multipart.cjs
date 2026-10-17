'use strict';
// Minimal multipart/form-data writer. Rails dropbox uploads must be posted as a
// real multipart body with the hidden fields copied from the page verbatim, so
// this module only builds the envelope; callers own every field and file byte.

const { randomBytes } = require('node:crypto');

const CRLF = '\r\n';
const MAX_PARTS = 40;
const MAX_BODY_BYTES = 24 * 1024 * 1024;

function assertFieldName(name) {
  const value = String(name ?? '');
  if (!value || value.length > 200 || /[\r\n"]/.test(value)) throw new Error('表单字段名不合法');
  return value;
}

function assertFilename(name) {
  const value = String(name ?? '').replace(/[\r\n"]/g, '_').slice(0, 180);
  return value || 'file';
}

/**
 * Builds a multipart/form-data body.
 * @param {{ fields?: Record<string, unknown>, file?: { field: string, filename: string, contentType?: string, bytes: Buffer|Uint8Array } }} input
 * @returns {{ body: Buffer, contentType: string }}
 */
function buildMultipart({ fields = {}, file = null } = {}) {
  const boundary = `----PHLauncherFormBoundary${randomBytes(12).toString('hex')}`;
  const entries = Object.entries(fields || {});
  if (entries.length + (file ? 1 : 0) > MAX_PARTS) throw new Error('表单字段过多，已停止提交');
  const chunks = [];
  for (const [key, value] of entries) {
    const name = assertFieldName(key);
    // Repeated fields (Rails hidden inputs) are passed as arrays.
    for (const item of Array.isArray(value) ? value : [value]) {
      chunks.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`, 'utf8'));
      chunks.push(Buffer.from(String(item ?? ''), 'utf8'));
      chunks.push(Buffer.from(CRLF, 'utf8'));
    }
  }
  if (file) {
    const name = assertFieldName(file.field);
    const bytes = Buffer.from(file.bytes || []);
    if (!bytes.length) throw new Error('提交的文件是空的');
    const type = String(file.contentType || 'application/octet-stream').replace(/[\r\n]/g, '');
    chunks.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${assertFilename(file.filename)}"${CRLF}Content-Type: ${type}${CRLF}${CRLF}`, 'utf8'));
    chunks.push(bytes);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(chunks);
  if (body.length > MAX_BODY_BYTES) throw new Error('提交内容超过 24 MB 限制');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Rails-style urlencoded body; repeated keys become repeated entries. */
function formEncode(fields) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item ?? ''));
  }
  return form.toString();
}

module.exports = { MAX_BODY_BYTES, buildMultipart, formEncode };
