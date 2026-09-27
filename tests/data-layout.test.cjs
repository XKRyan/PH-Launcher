'use strict';
// The shared data root: where PH Launcher and Pinghe Launcher Lite keep their
// files. The rules mirror Lite's portable/profile behaviour so two installs can
// share `settings.yaml`, `Schedule` and `agent/`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  detectLiteRoot, layoutPaths, ensureLayout, migrateLegacyFile, migrateProfile, ownFile,
  readMigrations, resolveDataRoot, writeRootPointer,
} = require('../electron/data-layout.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-layout-'));
const profile = path.join(temp, 'profile');
const exec = path.join(temp, 'portable');
const home = path.join(temp, 'home');
for (const dir of [profile, exec, home]) fs.mkdirSync(dir, { recursive: true });
const exists = fs.existsSync;

function freshProfile(name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('an explicit folder always wins and is used as the data root', () => {
  const chosen = path.join(temp, 'chosen');
  fs.mkdirSync(chosen, { recursive: true });
  assert.deepEqual(resolveDataRoot({ userDataDir: profile, execDir: exec, homeDir: home, env: { PHL_DATA_DIR: chosen } }),
    { root: path.resolve(chosen), source: 'env' });
});

test('a recorded folder beats the portable and Lite defaults', () => {
  const dir = freshProfile('pointer-profile');
  const recorded = path.join(temp, 'recorded');
  fs.mkdirSync(recorded, { recursive: true });
  writeRootPointer(dir, recorded);
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: exec, homeDir: home, env: {} }),
    { root: path.resolve(recorded), source: 'pointer' });
});

test('单一架构：数据永远在 exe 同级的 data/，没有就自动创建', () => {
  const dir = freshProfile('app-root-profile');
  const exeDir = path.join(temp, 'app-folder');
  fs.mkdirSync(exeDir, { recursive: true });
  // 不看 portable.flag、不看 profile：exe 在哪，data 就在哪
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: exeDir, env: {} }),
    { root: path.join(exeDir, 'data'), source: 'app' });
  fs.writeFileSync(path.join(exeDir, 'portable.flag'), '');
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: exeDir, env: {} }),
    { root: path.join(exeDir, 'data'), source: 'app' }, '便携标记不再影响结果');
  // 目录不存在时，ensureLayout 负责建出来
  const layout = ensureLayout(layoutPaths(path.join(exeDir, 'data')));
  assert.equal(fs.statSync(layout.root).isDirectory(), true);
  assert.equal(fs.statSync(layout.own).isDirectory(), true);
});

test('测试与预览仍可用 PHL_DATA_DIR 或记录的目录改向', () => {
  const dir = freshProfile('override-profile');
  const chosen = path.join(temp, 'chosen-again');
  fs.mkdirSync(chosen, { recursive: true });
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: path.join(temp, 'x'), env: { PHL_DATA_DIR: chosen } }),
    { root: path.resolve(chosen), source: 'env' });
  writeRootPointer(dir, chosen);
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: path.join(temp, 'x'), env: {} }),
    { root: path.resolve(chosen), source: 'pointer' });
});

test('Lite 目录只用于提示，不参与数据根解析', () => {
  const lite = path.join(temp, 'lite-again');
  assert.deepEqual(detectLiteRoot({ homeDir: lite }), { root: path.join(lite, '.hellopinghe'), available: false });
  fs.mkdirSync(path.join(lite, '.hellopinghe'), { recursive: true });
  fs.writeFileSync(path.join(lite, '.hellopinghe', 'settings.yaml'), 'version: 1\n');
  assert.deepEqual(detectLiteRoot({ homeDir: lite }), { root: path.join(lite, '.hellopinghe'), available: true });
});
test('creating the layout makes exactly the folders both apps expect', () => {
  const root = path.join(temp, 'ensured');
  const layout = ensureLayout(layoutPaths(root));
  for (const dir of [root, path.join(root, 'phl'), path.join(root, 'agent'), path.join(root, 'logs'), path.join(root, '_backups')]) {
    assert.equal(fs.statSync(dir).isDirectory(), true, dir);
  }
  assert.equal(layout.root, root);
  // Idempotent: running twice must not fail.
  ensureLayout(layout);
});

test('migration copies the old profile file without ever touching the source', () => {
  const dir = freshProfile('migrate-profile');
  const root = path.join(temp, 'migrate-root');
  const layout = ensureLayout(layoutPaths(root));
  const legacy = path.join(dir, 'ph-launcher.secure');
  fs.writeFileSync(legacy, 'ENC1:old-content');

  const first = migrateLegacyFile({ layout, legacyPath: legacy, targetName: 'launcher' });
  assert.equal(first.migrated, true);
  assert.equal(fs.readFileSync(ownFile(layout, 'launcher'), 'utf8'), 'ENC1:old-content');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'ENC1:old-content', 'the old file is left in place');
  assert.equal(fs.readdirSync(layout.own).some((name) => name.endsWith('.tmp')), false, 'no temp file is left behind');

  const second = migrateLegacyFile({ layout, legacyPath: legacy, targetName: 'launcher' });
  assert.deepEqual({ migrated: second.migrated, reason: second.reason }, { migrated: false, reason: 'target-exists' });
  assert.equal(fs.readFileSync(ownFile(layout, 'launcher'), 'utf8'), 'ENC1:old-content');

  const missing = migrateLegacyFile({ layout, legacyPath: path.join(dir, 'nope'), targetName: 'school' });
  assert.deepEqual({ migrated: missing.migrated, reason: missing.reason }, { migrated: false, reason: 'no-legacy' });
});

test('a profile migration records what it copied and skips what is already there', () => {
  const dir = freshProfile('full-migrate-profile');
  const root = path.join(temp, 'full-migrate-root');
  const layout = ensureLayout(layoutPaths(root));
  fs.writeFileSync(path.join(dir, 'ph-launcher.secure'), 'ENC1:launcher');
  fs.writeFileSync(path.join(dir, 'ph-launcher.credentials'), 'ENC1:credentials');
  const copied = migrateProfile({ layout, userDataDir: dir });
  assert.deepEqual(copied.map((item) => item.legacy).sort(), ['ph-launcher.credentials', 'ph-launcher.secure']);
  assert.equal(fs.readFileSync(ownFile(layout, 'credentials'), 'utf8'), 'ENC1:credentials');
  const log = readMigrations(layout);
  assert.equal(log.length, 2);
  assert.equal(log.every((entry) => entry.to.startsWith(root) && entry.at), true);
  assert.deepEqual(migrateProfile({ layout, userDataDir: dir }), [], 'a second run copies nothing');
  assert.equal(readMigrations(layout).length, 2);
});

test('a corrupt migration log never blocks a new migration', () => {
  const root = path.join(temp, 'corrupt-log-root');
  const layout = ensureLayout(layoutPaths(root));
  fs.writeFileSync(path.join(layout.own, 'migrated.json'), '{not json');
  assert.deepEqual(readMigrations(layout), []);
  const source = path.join(root, 'legacy-state');
  fs.writeFileSync(source, 'state');
  const result = migrateLegacyFile({ layout, legacyPath: source, targetName: 'state' });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(ownFile(layout, 'state'), 'utf8'), 'state');
  assert.deepEqual(readMigrations(layout).map((entry) => entry.to), [ownFile(layout, 'state')]);
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });
