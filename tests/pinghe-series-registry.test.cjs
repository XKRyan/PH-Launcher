'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../electron/pinghe-series-registry.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-install-registry-'));
  const filePath = path.join(root, 'PingheSeries', 'installations.ini');
  return { root, filePath, options: { filePath, now: new Date('2026-11-10T10:20:00Z') } };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* no-op */ }
}

test('安装登记路径固定且支持测试覆盖（不碰真实文件）', () => {
  const override = path.join(os.tmpdir(), 'custom-installations.ini');
  assert.equal(registry.registryPath({ env: { PHL_INSTALL_REGISTRY: override }, platform: 'win32', homeDir: 'C:\\Users\\x' }), path.resolve(override));
  assert.equal(registry.registryPath({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32', homeDir: 'C:\\Users\\me' }), path.win32.join('C:\\Users\\me\\AppData\\Local', 'PingheSeries', 'installations.ini'));
  assert.equal(registry.registryPath({ env: {}, platform: 'darwin', homeDir: '/Users/me' }), '/Users/me/Library/Application Support/PingheSeries/installations.ini');
});

test('record 读-改-写：更新 phl 时保留 phl-lite 节和双方未知字段', () => {
  const f = fixture();
  try {
    registry.record('phl-lite', { path: path.join(f.root, 'PH Launcher'), dataRoot: path.join(f.root, 'shared'), version: '1.2.9' }, f.options);
    fs.appendFileSync(f.filePath, '\n[future-app]\ncustom=keep\n', 'utf8');
    registry.record('phl', { path: path.join(f.root, 'PH Launcher'), dataRoot: path.join(f.root, 'shared'), version: '2.0.13' }, f.options);
    const before = registry.read({ filePath: f.filePath });
    before['phl-lite'].lite_extra = 'keep';
    fs.writeFileSync(f.filePath, `; 顶部注释必须保留\n[phl-lite]\ninstalled=1\npath=${before['phl-lite'].path}\ndata_root=${before['phl-lite'].data_root}\nversion=1.2.9\nlite_extra=keep\n# Lite 注释必须保留\n\n[future-app]\ncustom=keep\n\n[phl]\n; PHL 节内未知注释也保留\ninstalled=0\ninstalled=1\npath=${path.join(f.root, 'old')}\ndata_root=${path.join(f.root, 'old', 'data')}\nunknown=keep\n`, 'utf8');
    registry.record('phl', { path: path.join(f.root, 'new'), dataRoot: path.join(f.root, 'shared'), version: '2.0.13' }, f.options);
    const after = registry.read({ filePath: f.filePath });
    assert.equal(after['phl-lite'].lite_extra, 'keep');
    assert.equal(after['future-app'].custom, 'keep');
    assert.equal(after.phl.unknown, 'keep');
    assert.equal(after.phl.path, path.join(f.root, 'new'));
    assert.equal(after.phl.data_root, path.join(f.root, 'shared'));
    assert.equal(after.phl.version, '2.0.13');
    const text = fs.readFileSync(f.filePath, 'utf8');
    assert.match(text, /^; 顶部注释必须保留/m);
    assert.match(text, /^# Lite 注释必须保留/m);
    assert.match(text, /^; PHL 节内未知注释也保留/m);
    assert.equal((text.match(/^installed=/gm) || []).length, 2, 'phl-lite 与 phl 各保留一项，PHL 重复旧键被收敛');
  } finally { cleanup(f.root); }
});

test('installation 对 installed=0/false/no/off、空路径与相对路径都返回 null', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.filePath), { recursive: true });
    for (const flag of ['0', 'false', 'no', 'off']) {
      fs.writeFileSync(f.filePath, `[phl]\ninstalled=${flag}\npath=${path.join(f.root, 'app')}\n`, 'utf8');
      assert.equal(registry.installation('phl', { filePath: f.filePath }), null, flag);
    }
    fs.writeFileSync(f.filePath, '[phl]\ninstalled=1\npath=relative/app\n', 'utf8');
    assert.equal(registry.installation('phl', { filePath: f.filePath }), null);
    fs.writeFileSync(f.filePath, '[phl]\ninstalled=1\npath=\n', 'utf8');
    assert.equal(registry.installation('phl', { filePath: f.filePath }), null);
  } finally { cleanup(f.root); }
});

test('data_root 缺失/相对时按绝对安装目录下的 data 补默认', () => {
  const f = fixture();
  try {
    const installPath = path.join(f.root, 'PH Launcher');
    registry.record('phl', { path: installPath, dataRoot: 'relative-root', version: '2.0.13' }, f.options);
    const found = registry.installation('phl', { filePath: f.filePath });
    assert.equal(found.dataRoot, path.join(installPath, 'data'));
  } finally { cleanup(f.root); }
});

test('缺失/损坏文件读取为空且下一次 record 可自愈', () => {
  const f = fixture();
  try {
    assert.deepEqual(registry.read({ filePath: f.filePath }), {});
    fs.mkdirSync(path.dirname(f.filePath), { recursive: true });
    fs.writeFileSync(f.filePath, '这不是 INI\n[broken\n', 'utf8');
    assert.deepEqual(registry.read({ filePath: f.filePath }), {});
    registry.record('phl', { path: path.join(f.root, 'app'), version: '2.0.13' }, f.options);
    assert.equal(registry.installation('phl', { filePath: f.filePath }).version, '2.0.13');
  } finally { cleanup(f.root); }
});

test('原子写不留临时文件，输出 UTF-8 无 BOM', () => {
  const f = fixture();
  try {
    registry.record('phl', { path: path.join(f.root, 'app'), version: '2.0.13' }, f.options);
    const bytes = fs.readFileSync(f.filePath);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.equal(fs.readdirSync(path.dirname(f.filePath)).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally { cleanup(f.root); }
});

test('remove 路径不匹配绝不删；匹配时只删自己的节并保留 phl-lite', () => {
  const f = fixture();
  try {
    const shared = path.join(f.root, 'PH Launcher');
    registry.record('phl', { path: shared, version: '2.0.13' }, f.options);
    registry.record('phl-lite', { path: shared, version: '1.2.9' }, f.options);
    assert.equal(registry.remove('phl', { expectedPath: path.join(f.root, 'other') }, { filePath: f.filePath }), false);
    assert.ok(registry.installation('phl', { filePath: f.filePath }));
    assert.equal(registry.remove('phl', { expectedPath: shared }, { filePath: f.filePath }), true);
    assert.equal(registry.installation('phl', { filePath: f.filePath }), null);
    assert.ok(registry.installation('phl-lite', { filePath: f.filePath }));
  } finally { cleanup(f.root); }
});

test('从可执行文件推导安装目录：Windows 取 exe 所在目录，macOS 向上找到 .app', () => {
  assert.equal(registry.installPathFromExecutable('C:\\Users\\me\\Programs\\PH Launcher\\PH Launcher.exe', { platform: 'win32' }),
    path.win32.dirname('C:\\Users\\me\\Programs\\PH Launcher\\PH Launcher.exe'));
  const macExe = '/Applications/PH Launcher.app/Contents/MacOS/PH Launcher';
  assert.equal(registry.installPathFromExecutable(macExe, { platform: 'darwin' }),
    '/Applications/PH Launcher.app');
});

test('record 拒绝相对安装目录，updated_at 写带时区的 ISO 秒值', () => {
  const f = fixture();
  try {
    assert.throws(() => registry.record('phl', { path: 'relative/app' }, f.options), /绝对路径/);
    registry.record('phl', { path: path.join(f.root, 'app'), version: '2.0.13' }, f.options);
    const raw = registry.read({ filePath: f.filePath }).phl;
    assert.match(raw.updated_at, /^2026-11-10T\d{2}:20:00[+-]\d{2}:\d{2}$/);
  } finally { cleanup(f.root); }
});
