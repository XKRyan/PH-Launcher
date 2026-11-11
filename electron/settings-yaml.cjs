'use strict';
// `settings.yaml` is the one configuration file PH Launcher shares with Pinghe
// Launcher Lite, so this module edits it like a text file with named sections
// instead of re-serializing it:
//
//   * only the requested top-level block is parsed,
//   * only that block is replaced, byte for byte outside it,
//   * everything this app does not own (comments, unknown sections, the other
//     application's fields) survives untouched.
//
// That keeps a file written by the other application readable and editable even
// when it contains fields this version has never heard of.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BOM = '\ufeff';
const MAX_FILE_BYTES = 512 * 1024;

function stripBom(text) { return text.startsWith(BOM) ? text.slice(BOM.length) : text; }

function blockRange(text, blockName) {
  const name = String(blockName || '');
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error('配置段名称无效');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\s*:([ \\t\\r]|$)`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // YAML permits a block sequence at column 0 (lessons:\n- subject: ...).
    // Those items still belong to this block; leaving them behind resurrects
    // deselected courses the next time the shared configuration is read.
    if (!/^\s/.test(line) && !/^-(?:\s|$)/.test(line)) {
      // 紧挨下一个顶层键之前的空行/注释通常是在说明下一个段，不能算进待替换段里。
      end = index;
      while (end > start + 1 && (lines[end - 1].trim() === '' || /^\s*#/.test(lines[end - 1]))) end -= 1;
      break;
    }
  }
  return { start, end, lines };
}

function indentOf(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/** `key: value` pairs directly under `blockName:`. Values stay as raw text. */
function readScalarMap(text, blockName) {
  const range = blockRange(stripBom(String(text ?? '')), blockName);
  const result = {};
  if (!range) return result;
  const header = indentOf(range.lines[range.start]);
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = range.lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent <= header) break;
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/);
    if (!match) continue;
    if (indent !== header + 2) continue; // nested values belong to readNestedMap
    const raw = match[2] === undefined ? '' : match[2];
    // An inline list is read with readStringList, not as a scalar.
    if (raw.trimStart().startsWith('[')) continue;
    result[match[1]] = parseYamlScalar(raw);
  }
  return result;
}

/** Two levels: `blockName: { child: { key: value } }` (used for `accounts`). */
function readNestedMap(text, blockName) {
  const range = blockRange(stripBom(String(text ?? '')), blockName);
  const result = {};
  if (!range) return result;
  const header = indentOf(range.lines[range.start]);
  let child = '';
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = range.lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent <= header) break;
    const trimmed = line.trim();
    const childMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*$/);
    if (indent === header + 2) {
      if (childMatch) { child = childMatch[1]; if (!result[child]) result[child] = {}; continue; }
      // A scalar child keeps its raw value; deeper maps are not modelled here.
      const inline = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s+(.+)$/);
      child = '';
      if (inline) result[inline[1]] = parseYamlScalar(inline[2]);
      continue;
    }
    if (!child || indent !== header + 4) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/);
    if (match) result[child][match[1]] = parseYamlScalar(match[2] === undefined ? '' : match[2]);
  }
  return result;
}

/** A string list written inline (`[a, b]`) or as `- item` lines. */
function readStringList(text, blockName, key) {
  const range = blockRange(stripBom(String(text ?? '')), blockName);
  if (!range) return [];
  const header = indentOf(range.lines[range.start]);
  const result = [];
  let collecting = false;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = range.lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent <= header) break;
    const trimmed = line.trim();
    if (indent === header + 2 && new RegExp(`^${key}\\s*:`).test(trimmed)) {
      const inline = trimmed.replace(new RegExp(`^${key}\\s*:\\s*`), '');
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',')) {
          const value = parseYamlScalar(item);
          if (typeof value === 'string' && value) result.push(value);
        }
        collecting = false;
      } else {
        const single = parseYamlScalar(inline);
        if (typeof single === 'string' && single) result.push(single);
        collecting = inline === '';
      }
      continue;
    }
    if (collecting) {
      const item = trimmed.match(/^-\s+(.*)$/);
      if (item) {
        const value = parseYamlScalar(item[1]);
        if (typeof value === 'string' && value) result.push(value);
        continue;
      }
      collecting = false;
    }
  }
  return result;
}

/** One raw scalar token: quoted string, boolean, number, null or plain text. */
function parseYamlScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

const NEEDS_QUOTES = /[:#[\]{},&*?|<>!=%@`]|^\s|\s$|^['"]/;
function quoteScalar(value) {
  // Booleans and numbers are written bare; a *string* that looks like one must be
  // quoted so it does not come back as a different type.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return "''";
  if (/^[\s]|[\s]$/.test(text) || NEEDS_QUOTES.test(text) || /^(?:true|false|null|~)$/.test(text) || /^-?\d+(?:\.\d+)?$/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return text;
}

function serializeNestedMap(blockName, nested) {
  const children = Object.entries(nested || {}).filter(([, value]) => value && typeof value === 'object' && Object.keys(value).length);
  if (!children.length) throw new Error('没有可写入的配置内容');
  const lines = [`${blockName}:`];
  for (const [child, values] of children) {
    lines.push(`  ${child}:`);
    for (const [key, value] of Object.entries(values)) lines.push(`    ${key}: ${quoteScalar(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function serializeScalarMap(blockName, map) {
  const entries = Object.entries(map || {});
  if (!entries.length) throw new Error('没有可写入的配置内容');
  const lines = [`${blockName}:`];
  for (const [key, value] of entries) lines.push(`  ${key}: ${quoteScalar(value)}`);
  return `${lines.join('\n')}\n`;
}

function commentLines(lines) {
  return lines.filter((line) => /^\s*#/.test(line));
}

function appendMissingComments(lines, oldLines) {
  const next = [...lines];
  const seen = new Set(next.filter((line) => /^\s*#/.test(line)));
  for (const line of commentLines(oldLines)) {
    if (!seen.has(line)) { next.push(line); seen.add(line); }
  }
  return next;
}

function directMapChunks(lines, parentIndent) {
  const starts = [];
  const pattern = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (indentOf(line) !== parentIndent + 2) continue;
    const match = line.trim().match(pattern);
    if (match) starts.push({ index, key: match[1] });
  }
  return starts.map((entry, position) => ({
    key: entry.key,
    lines: lines.slice(entry.index, position + 1 < starts.length ? starts[position + 1].index : lines.length),
  }));
}

function containerHeader(line) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*(?:#.*)?$/.test(String(line || '').trim());
}

function ownedKeyMayDisappear(blockName, pathParts, key) {
  // PHL 明确拥有这三个账号，用户删除账号时必须真的删除；Lite 的 xinlv/未来平台则保留。
  return blockName === 'accounts' && pathParts.length === 0 && ['edupage', 'managebac', 'mail'].includes(key);
}

function mergeMapLines(oldLines, newLines, parentIndent, blockName, pathParts = []) {
  const oldChunks = directMapChunks(oldLines, parentIndent);
  const newChunks = directMapChunks(newLines, parentIndent);
  if (!newChunks.length) return appendMissingComments(newLines, oldLines);
  const oldByKey = new Map(oldChunks.map((chunk) => [chunk.key, chunk]));
  const newKeys = new Set(newChunks.map((chunk) => chunk.key));
  const merged = [];
  for (const chunk of newChunks) {
    const previous = oldByKey.get(chunk.key);
    if (previous && containerHeader(previous.lines[0]) && containerHeader(chunk.lines[0])) {
      merged.push(chunk.lines[0], ...mergeMapLines(previous.lines.slice(1), chunk.lines.slice(1), parentIndent + 2, blockName, [...pathParts, chunk.key]));
    } else {
      merged.push(...appendMissingComments(chunk.lines, previous?.lines || []));
    }
  }
  for (const chunk of oldChunks) {
    if (!newKeys.has(chunk.key) && !ownedKeyMayDisappear(blockName, pathParts, chunk.key)) merged.push(...chunk.lines);
  }
  return appendMissingComments(merged, oldLines);
}

function listChunks(lines, itemIndent) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (indentOf(lines[index]) === itemIndent && /^-\s+/.test(lines[index].trim())) starts.push(index);
  }
  return starts.map((start, position) => lines.slice(start, position + 1 < starts.length ? starts[position + 1] : lines.length));
}

function listIdentity(lines, fallback) {
  const fields = {};
  for (const line of lines) {
    const match = line.trim().replace(/^-\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (match) fields[match[1]] = parseYamlScalar(match[2]);
  }
  if (fields.id !== undefined && fields.id !== '') return `id:${String(fields.id)}`;
  if (fields.subject !== undefined) return `lesson:${String(fields.subject)}|${String(fields.start || '')}|${String(fields.group || '')}`;
  if (fields.name !== undefined) return `name:${String(fields.name)}`;
  return `index:${fallback}`;
}

function mergeListItem(oldLines, newLines, itemIndent, blockName) {
  const virtual = (lines) => lines.map((line, index) => index === 0
    ? `${' '.repeat(itemIndent + 2)}${line.trim().replace(/^-\s+/, '')}` : line);
  const merged = mergeMapLines(virtual(oldLines), virtual(newLines), itemIndent, blockName);
  const first = merged.findIndex((line) => line.trim() && !/^\s*#/.test(line));
  if (first >= 0) merged[first] = `${' '.repeat(itemIndent)}- ${merged[first].trim()}`;
  return merged;
}

function mergeListLines(oldLines, newLines, itemIndent, blockName) {
  const oldItems = listChunks(oldLines, itemIndent);
  const oldById = new Map(oldItems.map((item, index) => [listIdentity(item, index), item]));
  const newItems = listChunks(newLines, itemIndent);
  const merged = newItems.flatMap((item, index) => {
    const previous = oldById.get(listIdentity(item, index));
    return previous ? mergeListItem(previous, item, itemIndent, blockName) : item;
  });
  return appendMissingComments(merged, oldLines);
}

function mergeBlockText(oldLines, replacement, blockName) {
  const fresh = replacement.replace(/\n$/, '').split('\n');
  if (oldLines.length < 1 || fresh.length < 1) return replacement;
  const oldContent = oldLines.slice(1);
  const newContent = fresh.slice(1);
  const newFirst = newContent.find((line) => line.trim() && !/^\s*#/.test(line));
  let mergedContent;
  if (newFirst && /^-\s+/.test(newFirst.trim())) {
    const itemIndent = indentOf(newFirst);
    mergedContent = mergeListLines(oldContent, newContent, itemIndent, blockName);
  } else if (newContent.length) {
    mergedContent = mergeMapLines(oldContent, newContent, 0, blockName);
  } else {
    mergedContent = appendMissingComments([], oldContent);
  }
  return `${[fresh[0], ...mergedContent].join('\n')}\n`;
}

/**
 * 替换一个顶层块，但先把旧块中本版本不认识的键、条目字段和注释合并进新块。
 * 这是共享 settings.yaml 的读-改-写边界：只序列化 PHL 已知模型会抹掉 Lite 字段。
 */
function replaceBlock(text, blockName, body) {
  const source = stripBom(String(text ?? ''));
  if (typeof body !== 'string' || !body.endsWith('\n')) throw new Error('配置段内容必须以换行结束');
  const range = blockRange(source, blockName);
  if (!range) {
    const base = source.endsWith('\n') || source === '' ? source : `${source}\n`;
    return `${base}${base === '' || base.endsWith('\n\n') ? '' : '\n'}${body}`;
  }
  const before = range.lines.slice(0, range.start).join('\n');
  const after = range.lines.slice(range.end).join('\n');
  const head = range.start === 0 ? '' : `${before}\n`;
  const mergedBody = mergeBlockText(range.lines.slice(range.start, range.end), body, blockName);
  return `${head}${mergedBody}${after}`;
}

/** UTF-8, no BOM, LF only, atomic replace in the same directory. */
function atomicWriteFileSync(filePath, contents) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let mode;
  try { mode = fs.statSync(filePath).mode; } catch { mode = 0o600; }
  try {
    fs.writeFileSync(temporaryPath, stripBom(String(contents)).replace(/\r\n?/g, '\n'), { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* temporary file only */ }
    throw error;
  }
}

/** Reads the whole file, or '' when it is missing, unreadable or too large. */
function readTextFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
    return stripBom(fs.readFileSync(filePath, 'utf8'));
  } catch { return ''; }
}

module.exports = {
  MAX_FILE_BYTES,
  atomicWriteFileSync,
  parseYamlScalar,
  quoteScalar,
  readNestedMap,
  readScalarMap,
  readStringList,
  readTextFile,
  replaceBlock,
  serializeNestedMap,
  serializeScalarMap,
};
