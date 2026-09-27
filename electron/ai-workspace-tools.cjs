'use strict';
// Workspace-scoped AI file tools. The workspace is the only folder the assistant
// may read or write: every path goes through resolveInside, which refuses
// absolute input, traversal, and symlinks that leave the chosen root.
//
// Path resolution is synchronous so a proposal can be built (and rejected) before
// the user ever sees a confirmation card; the file contents are read and written
// asynchronously.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_ENTRIES = 200;
const MAX_DEPTH = 6;
const MAX_TEXT_BYTES = 12_000;
const MAX_DOCX_BYTES = 24 * 1024 * 1024;
const MAX_PARAGRAPHS = 500;

class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = 'WORKSPACE_ERROR';
  }
}
function fail(message) { throw new WorkspaceError(message); }

function cleanRelative(value, limit = 300) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) return '';
  if (text.length > limit) fail('文件名过长');
  if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.startsWith('\\') || text.startsWith('~')) fail('只能使用工作区内的相对路径');
  const parts = text.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) fail('路径不能离开工作区');
  if (parts.some((part) => /[<>:"|?*\u0000-\u001f]/.test(part))) fail('文件名包含不允许的字符');
  if (parts.some((part) => part.length > 120)) fail('文件名过长');
  if (parts.includes('.git')) fail('工作区内的 .git 目录不可访问');
  return parts.join(path.sep);
}

function insideRoot(rootReal, target) {
  const relative = path.relative(rootReal, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolves a workspace-relative path and proves it stays inside the root. */
function resolveInside(root, relative) {
  if (!root) fail('尚未设置工作区，请先在 AI 助手页选择文件夹');
  const rootReal = fs.realpathSync(root);
  const clean = cleanRelative(relative);
  const target = clean ? path.join(rootReal, clean) : rootReal;
  if (!insideRoot(rootReal, target)) fail('路径不能离开工作区');
  // A symlinked parent (or the file itself) may still point outside the root.
  let existing = target;
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      if (!insideRoot(rootReal, real)) fail('路径不能离开工作区');
      break;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (existing === rootReal || path.dirname(existing) === existing) break;
      existing = path.dirname(existing);
    }
  }
  return target;
}

function relativeTo(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function trimUtf8(value, limit) {
  const raw = Buffer.from(String(value ?? ''), 'utf8');
  let end = Math.min(raw.length, Math.max(0, limit));
  while (end > 0 && end < raw.length && (raw[end] & 0xc0) === 0x80) end -= 1;
  return { text: raw.subarray(0, end).toString('utf8'), truncated: end < raw.length, totalBytes: raw.length };
}

async function listWorkspace(root, { subdir = '' } = {}) {
  const rootReal = fs.realpathSync(root);
  const base = resolveInside(root, subdir);
  const stat = await fsp.stat(base).catch(() => null);
  if (!stat) fail('这个子目录不存在');
  if (!stat.isDirectory()) fail('请选择一个文件夹');
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_ENTRIES) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const info = await fsp.stat(full).catch(() => null);
      files.push({ path: relativeTo(rootReal, full), bytes: Number(info?.size || 0) });
    }
  };
  await walk(base, 0);
  return { workspace: rootReal, subdir: relativeTo(rootReal, base), files, truncated: files.length >= MAX_ENTRIES };
}

async function readTextFile(root, { path: relative } = {}) {
  const rootReal = fs.realpathSync(root);
  const target = resolveInside(root, relative);
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) fail('找不到这个文件');
  if (stat.size > 2 * 1024 * 1024) fail('文件超过 2 MB，无法读取');
  const raw = await fsp.readFile(target);
  if (raw.includes(0)) fail('这不是文本文件');
  const chunk = trimUtf8(raw, MAX_TEXT_BYTES);
  return { path: relativeTo(rootReal, target), size: stat.size, text: chunk.text, truncated: chunk.truncated, totalBytes: chunk.totalBytes };
}

async function readDocxFile(root, { path: relative } = {}) {
  const rootReal = fs.realpathSync(root);
  const target = resolveInside(root, relative);
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) fail('找不到这个文档');
  if (stat.size > MAX_DOCX_BYTES) fail('文档超过 24 MB，无法读取');
  const { readDocxParagraphs } = require('./docx.cjs');
  const paragraphs = await readDocxParagraphs(await fsp.readFile(target));
  const chunks = paragraphs.slice(0, MAX_PARAGRAPHS).map((item) => trimUtf8(item, 4_000).text);
  return { path: relativeTo(rootReal, target), paragraphs: chunks, count: paragraphs.length, truncated: paragraphs.length > chunks.length };
}

function cleanParagraphs(value) {
  if (!Array.isArray(value) || value.length === 0) fail('至少需要一个段落');
  if (value.length > MAX_PARAGRAPHS) fail('段落数量过多，请分批处理');
  return value.map((item) => String(item ?? '').replace(/\r\n?/g, '\n').slice(0, 20_000));
}

function docxTarget(clean) {
  const target = clean.toLowerCase().endsWith('.docx') ? clean : `${clean}.docx`;
  if (!path.basename(target).replace(/\.docx$/i, '').trim()) fail('请提供文档名称');
  return target;
}

/** Validates a create/append request and returns exactly what would be written. */
function planDocxWrite(root, name, args = {}) {
  if (!root) fail('尚未设置工作区，请先在 AI 助手页选择文件夹');
  const rootReal = fs.realpathSync(root);
  const target = resolveInside(root, docxTarget(cleanRelative(args.path)));
  const relative = relativeTo(rootReal, target);
  const exists = Boolean(fs.statSync(target, { throwIfNoEntry: false })?.isFile());
  if (name === 'create_docx') {
    const title = String(args.title ?? '').replace(/\u0000/g, '').trim().slice(0, 200);
    if (!title) fail('文档标题不能为空');
    return { kind: 'docx-create', path: target, relative, title, paragraphs: cleanParagraphs(args.paragraphs), overwrites: exists, root: rootReal };
  }
  if (name === 'append_to_docx') {
    if (!exists) fail('这个文档还不存在，请先用 create_docx 新建');
    return { kind: 'docx-append', path: target, relative, paragraphs: cleanParagraphs(args.paragraphs), root: rootReal };
  }
  fail('未知的文件写入请求');
}

async function applyDocxWrite(plan) {
  if (!plan || typeof plan !== 'object' || !plan.root) fail('文件写入计划无效');
  // Re-resolve at execution time: the folder could have been replaced between
  // the confirmation card and the click.
  const target = resolveInside(plan.root, path.relative(plan.root, plan.path));
  if (plan.kind === 'docx-create') {
    const { buildDocx } = require('./docx.cjs');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buildDocx({ title: plan.title, paragraphs: plan.paragraphs }));
    return { path: plan.relative, paragraphs: plan.paragraphs.length, created: true };
  }
  if (plan.kind === 'docx-append') {
    const { appendDocxParagraphs } = require('./docx.cjs');
    const current = await fsp.readFile(target);
    await fsp.writeFile(target, appendDocxParagraphs(current, plan.paragraphs));
    return { path: plan.relative, paragraphs: plan.paragraphs.length, appended: true };
  }
  fail('未知的文件写入计划');
}

function filePreview(plan) {
  if (plan.kind === 'docx-create') {
    return {
      type: 'workspace-file',
      title: `新建 Word 文档：${plan.relative}`,
      items: [{ primary: plan.title, secondary: `${plan.paragraphs.length} 段${plan.overwrites ? ' · 将覆盖同名文件' : ''}` }],
    };
  }
  return {
    type: 'workspace-file',
    title: `追加段落：${plan.relative}`,
    items: plan.paragraphs.slice(0, 5).map((text) => ({ primary: trimUtf8(text, 120).text, secondary: '' })),
  };
}

module.exports = {
  MAX_ENTRIES, MAX_TEXT_BYTES, WorkspaceError,
  applyDocxWrite, cleanRelative, filePreview, listWorkspace, planDocxWrite,
  readDocxFile, readTextFile, resolveInside,
};
