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

test('portable layout follows portable.flag next to the executable', () => {
  const dir = freshProfile('portable-profile');
  assert.equal(resolveDataRoot({ userDataDir: dir, execDir: exec, homeDir: home, env: {} }).source, 'profile');
  fs.writeFileSync(path.join(exec, 'portable.flag'), '');
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: exec, homeDir: home, env: {} }),
    { root: path.join(exec, 'data'), source: 'portable' });
  fs.rmSync(path.join(exec, 'portable.flag'));
});

test('a Pinghe Launcher Lite folder is detected but never adopted on its own', () => {
  const dir = freshProfile('lite-profile');
  const lite = path.join(temp, 'lite-home');
  fs.mkdirSync(lite, { recursive: true });
  assert.deepEqual(detectLiteRoot({ homeDir: lite }), { root: path.join(lite, '.hellopinghe'), available: false });
  // Even with a real Lite folder present, this app keeps its own data until the
  // user explicitly shares the folder.
  fs.mkdirSync(path.join(lite, '.hellopinghe'), { recursive: true });
  fs.writeFileSync(path.join(lite, '.hellopinghe', 'settings.yaml'), 'version: 1\n');
  assert.deepEqual(detectLiteRoot({ homeDir: lite }), { root: path.join(lite, '.hellopinghe'), available: true });
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: '', homeDir: lite, env: {} }),
    { root: path.join(dir, 'data'), source: 'profile' });
  // Recording the choice is what switches the two applications onto one folder.
  writeRootPointer(dir, path.join(lite, '.hellopinghe'));
  assert.deepEqual(resolveDataRoot({ userDataDir: dir, execDir: '', homeDir: lite, env: {} }),
    { root: path.join(lite, '.hellopinghe'), source: 'pointer' });
});

test('the fallback root lives in the app profile and every path is derived from it', () => {
  const dir = freshProfile('plain-profile');
  const resolved = resolveDataRoot({ userDataDir: dir, execDir: '', homeDir: path.join(temp, 'empty-home'), env: {} });
  assert.deepEqual(resolved, { root: path.join(dir, 'data'), source: 'profile' });
  const layout = layoutPaths(resolved.root);
  assert.equal(layout.settings, path.join(dir, 'data', 'settings.yaml'));
  assert.equal(layout.schedule, path.join(dir, 'data', 'Schedule'));
  assert.equal(layout.agent, path.join(dir, 'data', 'agent'));
  assert.equal(layout.own, path.join(dir, 'data', 'phl'));
  assert.equal(ownFile(layout, 'launcher'), path.join(dir, 'data', 'phl', 'launcher.json'));
  assert.throws(() => ownFile(layout, 'unknown'), /未知的私有数据文件/);
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
