'use strict';
// Shared on-disk layout with Pinghe Launcher Lite (see docs/data-format.md §1).
//
// The two applications live in one folder tree: the configuration file
// `settings.yaml`, the day-based `Schedule` and the per-session AI transcripts in
// `agent/` are shared, while each application keeps its private stores in its own
// subfolder (`phl/` here, `phll/` for Lite).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LAYOUT_VERSION = 1;
const POINTER_FILE = 'data-root.txt';

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}
function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

/**
 * Resolves the shared data root. Later candidates are only used when the earlier
 * ones are absent, so an explicit choice by the user always wins.
 *
 * 1. `PHL_DATA_DIR` (tests, portable launchers, power users)
 * 2. the folder recorded by `data-root.txt` in the app profile
 * 3. `<execDir>/data` — there is only one layout: two exes and one `data/` in
 *    whatever folder the program was installed to. Lite's `portable.flag` is
 *    deliberately not read here; the data folder always sits next to the exe.
 *
 * A Lite folder found at `~/.hellopinghe` is never adopted automatically: the
 * user shares it through the recorded choice (see `detectLiteRoot`), so this app
 * never writes into another application's data folder on its own.
 */
function resolveDataRoot({ userDataDir, execDir, env = process.env, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  // 只有一种架构：程序文件夹里两个 exe + 一个 data/。数据永远在 exe 同级目录，
  // 没有就自动创建（ensureLayout 负责）；不再区分 portable/安装版，也不写
  // %APPDATA%。测试与预览可以用 PHL_DATA_DIR 或记录的目录临时改向。
  const candidates = [];
  const fromEnv = String(env.PHL_DATA_DIR || '').trim();
  if (fromEnv) candidates.push({ root: path.resolve(fromEnv), source: 'env' });
  if (userDataDir) {
    const pointer = path.join(userDataDir, POINTER_FILE);
    try {
      const bytes = fs.readFileSync(pointer);
      // PHL 自己写 UTF-8；Unicode NSIS 安装器为保证中文路径无损写 UTF-16LE+BOM。
      // 两种编码都接受，下一次应用内改向会自然归一成 UTF-8。
      const text = bytes[0] === 0xFF && bytes[1] === 0xFE
        ? bytes.subarray(2).toString('utf16le')
        : bytes.subarray(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0).toString('utf8');
      const recorded = text.split(/\r?\n/)[0].trim();
      // 损坏/手工改成相对路径的指针不能把数据带到当前工作目录；只认绝对路径。
      if (recorded && path.isAbsolute(recorded)) candidates.push({ root: path.normalize(recorded), source: 'pointer' });
    } catch { /* 没有记录 */ }
  }
  if (execDir) candidates.push({ root: path.join(execDir, 'data'), source: 'app' });
  // 按顺序取第一个：环境变量 > 记录的目录 > 程序旁边的 data/
  if (candidates.length) return candidates[0];
  return { root: path.join(userDataDir || os.tmpdir(), 'data'), source: 'app' };
}
/** Where a Pinghe Launcher Lite installation keeps its data, if there is one. */
function detectLiteRoot({ homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  const candidate = path.join(homeDir, '.hellopinghe');
  if (!exists(path.join(candidate, 'settings.yaml'))) return { root: candidate, available: false };
  return { root: candidate, available: true };
}

function layoutPaths(root) {
  return {
    version: LAYOUT_VERSION,
    root,
    settings: path.join(root, 'settings.yaml'),
    schedule: path.join(root, 'Schedule'),
    timetable: path.join(root, 'Timetable'),
    school: path.join(root, 'School'),
    agent: path.join(root, 'agent'),
    own: path.join(root, 'phl'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, '_backups'),
    migrated: path.join(root, '_migrated_backup'),
  };
}

// Private files this app owns, and the legacy profile files they replace.
const OWN_FILES = Object.freeze({
  launcher: 'launcher.json',
  school: 'school.json',
  credentials: 'credentials.json',
  aiHistory: 'ai-history.json',
  state: 'state.json',
});

function ownFile(layout, name) {
  const file = OWN_FILES[name];
  if (!file) throw new Error('未知的私有数据文件');
  return path.join(layout.own, file);
}

function ensureLayout(layout) {
  for (const dir of [layout.root, layout.own, layout.agent, layout.logs, layout.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

function writeRootPointer(userDataDir, root) {
  if (!userDataDir) return false;
  const chosen = String(root || '').trim();
  if (!chosen || !path.isAbsolute(chosen)) throw new Error('数据根必须是绝对路径');
  fs.mkdirSync(userDataDir, { recursive: true });
  const target = path.join(userDataDir, POINTER_FILE);
  // 唯一临时名避免同系列进程/测试同时写时互相覆盖临时文件；rename 保证读者只看到完整值。
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${path.normalize(chosen)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* no-op */ }
  }
  return true;
}

/**
 * Copies an older profile file into the new private folder.
 *
 * Migration is copy-only: the source file is never moved or deleted, so a failed
 * or reverted upgrade can always still read the original. The result is recorded
 * in `phl/migrated.json` and re-running is a no-op.
 */
function migrateLegacyFile({ layout, legacyPath, targetName, now = new Date() }) {
  const target = ownFile(layout, targetName);
  if (!legacyPath || path.resolve(legacyPath) === path.resolve(target)) return { migrated: false, reason: 'same-path', target };
  if (fs.existsSync(target)) return { migrated: false, reason: 'target-exists', target };
  if (!fs.existsSync(legacyPath)) return { migrated: false, reason: 'no-legacy', target };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.copyFileSync(legacyPath, temp);
  fs.renameSync(temp, target);
  recordMigration(layout, { from: path.resolve(legacyPath), to: target, at: now.toISOString() });
  return { migrated: true, target, source: legacyPath };
}

function migrationsFile(layout) { return path.join(layout.own, 'migrated.json'); }

function readMigrations(layout) {
  try {
    const parsed = JSON.parse(fs.readFileSync(migrationsFile(layout), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch { return []; }
}

function recordMigration(layout, entry) {
  const entries = readMigrations(layout).filter((item) => item.to !== entry.to);
  entries.push(entry);
  const payload = JSON.stringify({ version: LAYOUT_VERSION, kind: 'phl-migration-log', entries }, null, 2);
  fs.mkdirSync(layout.own, { recursive: true });
  const target = migrationsFile(layout);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${payload}\n`, 'utf8');
  fs.renameSync(temp, target);
}

/** Runs every copy-only migration for one profile directory. */
function migrateProfile({ layout, userDataDir, now = new Date() }) {
  if (!userDataDir) return [];
  const pairs = [
    ['ph-launcher.secure', 'launcher'],
    ['ph-launcher.school', 'school'],
    ['ph-launcher.credentials', 'credentials'],
    ['ph-launcher.ai-history', 'aiHistory'],
  ];
  const results = [];
  for (const [legacy, target] of pairs) {
    const result = migrateLegacyFile({ layout, legacyPath: path.join(userDataDir, legacy), targetName: target, now });
    if (result.migrated) results.push({ legacy, target: result.target });
  }
  return results;
}

module.exports = {
  LAYOUT_VERSION,
  OWN_FILES,
  POINTER_FILE,
  detectLiteRoot,
  ensureLayout,
  isDirectory,
  isFile,
  layoutPaths,
  migrateLegacyFile,
  migrateProfile,
  ownFile,
  readMigrations,
  resolveDataRoot,
  writeRootPointer,
};
