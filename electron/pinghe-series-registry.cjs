'use strict';
/**
 * Pinghe 系列安装登记（PHL / PHL Lite 共用 installations.ini）。
 *
 * 登记只用来让安装器/应用互相发现实际安装目录与数据根；它不是 PHL 的数据根配置源。
 * PHL 自己仍只按 PHL_DATA_DIR → data-root.txt → exe 同级 data 解析数据根，启动后把
 * 解析出的事实写回这里，避免登记反过来偷偷改向用户数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_NAMES = new Set(['phl', 'phl-lite']);
const REGISTRY_ENV = 'PHL_INSTALL_REGISTRY';

function registryPath({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const override = String(env[REGISTRY_ENV] || '').trim();
  if (override) return path.resolve(override);
  if (platform === 'darwin') {
    return path.posix.join(String(homeDir).replace(/\\/g, '/'), 'Library', 'Application Support', 'PingheSeries', 'installations.ini');
  }
  if (platform === 'win32') {
    const base = String(env.LOCALAPPDATA || '').trim() || path.win32.join(homeDir, 'AppData', 'Local');
    return path.win32.join(base, 'PingheSeries', 'installations.ini');
  }
  const base = String(env.XDG_CONFIG_HOME || '').trim() || path.join(homeDir, '.config');
  return path.join(base, 'PingheSeries', 'installations.ini');
}

function normalizeName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!APP_NAMES.has(normalized)) throw new Error(`未知的程序名：${name}`);
  return normalized;
}

function absolutePath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) return '';
  try { return path.normalize(text); } catch { return ''; }
}

function parseIni(text) {
  const sections = Object.create(null);
  const order = [];
  let current = '';
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const section = line.match(/^\[([^\]\r\n]+)\]$/);
    if (section) {
      current = section[1].trim().toLowerCase();
      if (!current) continue;
      if (!sections[current]) {
        sections[current] = Object.create(null);
        order.push(current);
      }
      continue;
    }
    const equal = line.indexOf('=');
    if (!current || equal <= 0) continue;
    const key = line.slice(0, equal).trim().toLowerCase();
    if (!key) continue;
    sections[current][key] = line.slice(equal + 1).trim();
  }
  return { sections, order };
}

function emptyDocument() {
  return { sections: Object.create(null), order: [] };
}

function readSource(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
}

function readDocument(filePath) {
  try { return parseIni(readSource(filePath)); } catch { return emptyDocument(); }
}

/** 整份登记；缺失/局部损坏按可识别内容返回，不把辅助登记故障带进启动链。 */
function read(options = {}) {
  const filePath = options.filePath || registryPath(options);
  const document = readDocument(filePath);
  const output = {};
  for (const section of document.order) output[section] = { ...document.sections[section] };
  return output;
}

function sectionHeader(line) {
  const match = String(line || '').trim().match(/^\[([^\]\r\n]+)\]$/);
  return match ? match[1].trim().toLowerCase() : '';
}

/** 文本级更新一个节，避免把另一程序的注释、未知字段或排版序列化掉。 */
function updateSection(source, sectionName, ownedValues) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source ? source.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const header = sectionHeader(lines[index]);
    if (header === sectionName && start < 0) start = index;
    else if (header && start >= 0) { end = index; break; }
  }
  const entries = Object.entries(ownedValues).map(([key, value]) => [key.toLowerCase(), String(value ?? '')]);
  if (start < 0) {
    if (lines.length && lines.at(-1).trim()) lines.push('');
    lines.push(`[${sectionName}]`, ...entries.map(([key, value]) => `${key}=${value}`));
    return `${lines.join(newline)}${newline}`;
  }
  const replacement = [lines[start]];
  const pending = new Map(entries);
  const ownedKeys = new Set(pending.keys());
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*([^;#=][^=]*?)\s*=/);
    const key = match ? match[1].trim().toLowerCase() : '';
    if (!ownedKeys.has(key)) {
      replacement.push(line);
      continue;
    }
    if (!pending.has(key)) continue; // 同一已知键重复出现时只保留更新后的第一项。
    replacement.push(`${key}=${pending.get(key)}`);
    pending.delete(key);
  }
  for (const [key, value] of pending) replacement.push(`${key}=${value}`);
  lines.splice(start, end - start, ...replacement);
  return `${lines.join(newline)}${newline}`;
}

function removeSection(source, sectionName) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source ? source.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (sectionHeader(lines[index]) !== sectionName) continue;
    let end = index + 1;
    while (end < lines.length && !sectionHeader(lines[end])) end += 1;
    lines.splice(index, end - index);
  }
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines.length ? `${lines.join(newline)}${newline}` : '';
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const token = crypto.randomBytes(6).toString('hex');
  const temporary = path.join(path.dirname(filePath), `.installations-${process.pid}-${token}.tmp`);
  try {
    // Node 的 utf8 编码不写 BOM；NSIS 会先无损转成临时 UTF-16LE 再用 Read/WriteINIStr。
    fs.writeFileSync(temporary, String(text || ''), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      const handle = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    } catch { /* fsync 不支持时仍保留原子 rename */ }
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* no-op */ }
  }
  return filePath;
}

function installedFlag(section) {
  const flag = String(section?.installed || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(flag);
}

/** 某个程序的有效登记；未安装/路径为空或相对时返回 null。 */
function installation(name, options = {}) {
  const sectionName = normalizeName(name);
  const section = read(options)[sectionName];
  if (!section || !installedFlag(section)) return null;
  const installPath = absolutePath(section.path);
  if (!installPath) return null;
  return {
    name: sectionName,
    path: installPath,
    dataRoot: absolutePath(section.data_root) || path.join(installPath, 'data'),
    version: String(section.version || ''),
    updatedAt: String(section.updated_at || ''),
  };
}

function installPathFromExecutable(executable, { platform = process.platform } = {}) {
  const api = platform === 'win32' ? path.win32 : platform === 'darwin' ? path.posix : path;
  const text = String(executable || '').trim();
  if (!text || !api.isAbsolute(text)) return '';
  const absolute = api.normalize(text);
  if (platform === 'darwin') {
    let current = api.dirname(absolute);
    while (current && current !== api.dirname(current)) {
      if (current.toLowerCase().endsWith('.app')) return current;
      current = api.dirname(current);
    }
    return '';
  }
  return api.dirname(absolute);
}

function localIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  const pad = (value) => String(Math.abs(value)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** 写入/更新一个节，读-改-写并完整保留另一个程序及未知字段。 */
function record(name, input = {}, options = {}) {
  const sectionName = normalizeName(name);
  const installPath = absolutePath(input.path);
  if (!installPath) throw new Error('安装目录必须是绝对路径');
  const dataRoot = absolutePath(input.dataRoot) || path.join(installPath, 'data');
  const filePath = options.filePath || registryPath(options);
  const source = readSource(filePath);
  const updated = updateSection(source, sectionName, {
    installed: '1',
    path: installPath,
    data_root: dataRoot,
    version: String(input.version || ''),
    updated_at: localIso(options.now || new Date()),
  });
  return atomicWrite(filePath, updated);
}

/**
 * 删除自己的节。调用方传 expectedPath 时必须与登记 path 匹配；不匹配绝不删，
 * 防止旧卸载器误删用户后来移动/重装后的新登记。
 */
function remove(name, { expectedPath = '' } = {}, options = {}) {
  const sectionName = normalizeName(name);
  const filePath = options.filePath || registryPath(options);
  const document = readDocument(filePath);
  const section = document.sections[sectionName];
  if (!section) return false;
  if (expectedPath) {
    const expected = absolutePath(expectedPath);
    const recorded = absolutePath(section.path);
    if (!expected || !recorded) return false;
    const normalizeForCompare = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalizeForCompare(expected) !== normalizeForCompare(recorded)) return false;
  }
  atomicWrite(filePath, removeSection(readSource(filePath), sectionName));
  return true;
}

module.exports = {
  APP_NAMES,
  REGISTRY_ENV,
  installation,
  installPathFromExecutable,
  localIso,
  read,
  record,
  registryPath,
  remove,
};
