'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { importReadingDocument } = require('./reading-document.cjs');

const MAX_EACH = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_PER_KIND = 3;
const DOCS = new Map([['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['.pdf', 'application/pdf']]);
const IMAGES = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);

function cleanName(filePath) { return path.basename(String(filePath || '')).replace(/[\0\r\n]/g, '').slice(0, 180); }
function kindFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (DOCS.has(ext)) return { kind: 'document', mime: DOCS.get(ext), ext };
  if (IMAGES.has(ext)) return { kind: 'image', mime: IMAGES.get(ext), ext };
  return { kind: 'document', mime: 'application/octet-stream', ext, generic: true };
}
function imageValid(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (ext === '.jpg' || ext === '.jpeg') return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (ext === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}
function documentValid(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (ext === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (ext === '.docx') return buffer.subarray(0, 2).equals(Buffer.from('PK'));
  return !buffer.includes(0);
}
function metadata(entry) { return { id: entry.id, type: entry.type, name: entry.name, mime: entry.mime, size: entry.size, preview: entry.preview, ...(entry.contentAvailable === false ? { contentAvailable: false } : {}) }; }

function createAiAttachments({ readFile = fs.readFile, stat = fs.stat, importDocument = importReadingDocument } = {}) {
  if (typeof readFile !== 'function' || typeof stat !== 'function' || typeof importDocument !== 'function') throw new TypeError('attachment readers are required');
  const entries = new Map();
  const limits = () => ({ total: [...entries.values()].reduce((sum, item) => sum + item.size, 0), images: [...entries.values()].filter((item) => item.type === 'image').length, documents: [...entries.values()].filter((item) => item.type === 'document').length });
  async function add(filePaths) {
    if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 6) throw new Error('请选择不超过 6 个文件');
    const accepted = [];
    const staged = [];
    // Validate every requested path before retaining any content, so a failed
    // selection cannot leave a partial attachment set behind.
    const pending = [];
    for (const filePath of filePaths) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('请选择本机文件');
      const descriptor = kindFor(filePath); const info = await stat(filePath);
      if (!info?.isFile?.() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_EACH) throw new Error('单个附件必须小于 10 MB');
      pending.push({ filePath, ...descriptor, size: info.size, name: cleanName(filePath) });
    }
    const current = limits();
    const pendingImages = pending.filter((item) => item.kind === 'image').length;
    const pendingDocs = pending.length - pendingImages;
    if (current.images + pendingImages > MAX_PER_KIND || current.documents + pendingDocs > MAX_PER_KIND) throw new Error('每次最多保留 3 张照片或 3 份文档');
    if (current.total + pending.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL) throw new Error('本次附件总大小不能超过 20 MB');
    for (const item of pending) {
      const bytes = await readFile(item.filePath);
      if (!Buffer.isBuffer(bytes) || bytes.length !== item.size) throw new Error('附件读取失败或文件已变化');
      if (item.kind === 'image') {
        if (!imageValid(bytes, item.ext)) throw new Error('图片格式与文件扩展名不匹配');
        const entry = { id: randomUUID(), type: 'image', name: item.name, mime: item.mime, size: item.size, preview: '图片将在发送时提供给所选 AI', image: Buffer.from(bytes) };
        staged.push(entry);
      } else if (item.generic) {
        let text = '';
        // Unknown extensions may still contain useful UTF-8 text (CSV, JSON,
        // source code, etc.). Never execute, render or unpack unknown content.
        try { if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
        const contentAvailable = Boolean(text.trim()) && !/[\u0000-\u0008\u000e-\u001f]/.test(text);
        staged.push({ id: randomUUID(), type:'document', name:item.name, mime:item.mime, size:item.size,
          contentAvailable, preview:contentAvailable ? text.replace(/\s+/g,' ').slice(0,240) : '',
          text:contentAvailable ? text.slice(0,200000) : `Attachment metadata only: ${item.name} (${item.size} bytes). The launcher cannot parse this format. File contents were NOT provided. Explain this limitation and request a supported export; do not claim to have read this file.` });
      } else {
        if (!documentValid(bytes, item.ext)) throw new Error('文档格式与文件扩展名不匹配');
        let extracted;
        if (item.ext === '.txt' || item.ext === '.md') extracted = { text: bytes.toString('utf8') };
        else extracted = await importDocument(item.filePath, { timeoutMs: 30_000 });
        const text = String(extracted?.text || '').trim();
        if (!text || text.length > 200_000) throw new Error('文档没有可用文本或内容过长');
        const entry = { id: randomUUID(), type: 'document', name: item.name, mime: item.mime, size: item.size, preview: text.replace(/\s+/g, ' ').slice(0, 240), text };
        staged.push(entry);
      }
    }
    for (const entry of staged) { entries.set(entry.id, entry); accepted.push(metadata(entry)); }
    return accepted;
  }
  function remove(id) { return entries.delete(String(id || '')); }
  function clear() { entries.clear(); }
  function list() { return [...entries.values()].map(metadata); }
  function payload(ids) {
    if (!Array.isArray(ids) || ids.length > 6 || new Set(ids).size !== ids.length) throw new Error('附件引用无效');
    return ids.map((id) => {
      const entry = entries.get(id); if (!entry) throw new Error('附件已移除，请重新选择');
      return entry.type === 'image' ? { id: entry.id, type: entry.type, name: entry.name, mime: entry.mime, image: Buffer.from(entry.image) } : { id: entry.id, type: entry.type, name: entry.name, mime: entry.mime, text: entry.text };
    });
  }
  function history(ids) { return payload(ids).map(({ id, type, name, mime }) => ({ id, type, name, mime })); }
  return { add, remove, clear, list, payload, history };
}

module.exports = { createAiAttachments, kindFor, imageValid, documentValid, MAX_EACH, MAX_TOTAL };
