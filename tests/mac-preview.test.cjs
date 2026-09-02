const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { preparePreviewAssets, sha256 } = require('../scripts/prepare-mac-preview-assets.cjs');

const projectDirectory = path.resolve(__dirname, '..');
const expectedPreviewMarker = [
  'PH_LAUNCHER_MAC_PREVIEW',
  'tag=mac-preview-v0.5.0-1',
  'version=0.5.0',
  'publish-prerelease=true',
  '',
].join('\n');

function validateOptionalPreviewMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return { present: false, valid: true };
  return {
    present: true,
    valid: fs.readFileSync(markerPath, 'utf8') === expectedPreviewMarker,
  };
}

test('macOS DMG has a branded 720x480 install layout and first-open help', () => {
  const dmg = require('../build/mac-preview-builder.cjs').dmg;
  assert.equal(dmg.background, 'build/mac-dmg-background.png');
  assert.deepEqual(dmg.window, { width: 720, height: 480 });
  assert.equal(dmg.iconSize, 84);
  assert.deepEqual(dmg.contents, [
    { x: 150, y: 250 },
    { x: 570, y: 250, type: 'link', path: '/Applications' },
    { x: 360, y: 410, type: 'file', path: 'build/mac-first-open-help.html', name: '首次打开帮助.html' },
  ]);

  const png = fs.readFileSync(path.join(projectDirectory, dmg.background));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 720);
  assert.equal(png.readUInt32BE(20), 480);
});

test('macOS app icon is a full-size 1024 PNG suitable for ICNS conversion', () => {
  const png = fs.readFileSync(path.join(projectDirectory, 'assets', 'icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.ok(png.length > 100_000);
});

test('first-open help follows Apple guidance and states unsigned preview risk', () => {
  const help = fs.readFileSync(path.join(projectDirectory, 'build', 'mac-first-open-help.html'), 'utf8');
  assert.match(help, /没有 Developer ID 身份签名且未经 Apple 公证/);
  assert.match(help, /系统设置/);
  assert.match(help, /隐私与安全性/);
  assert.match(help, /仍要打开/);
  assert.match(help, /support\.apple\.com\/zh-cn\/guide\/mac-help\/-mh40616\/mac/);
  assert.match(help, /不需要运行任何终端命令/);
  assert.doesNotMatch(help, /\bxattr\b|\bspctl\b|\bsudo\b/i);
});

test('macOS preview verifies both Mach-O architectures without parsing lipo text', () => {
  const verifier = fs.readFileSync(path.join(projectDirectory, 'scripts', 'verify-mac-preview.sh'), 'utf8');
  assert.match(verifier, /lipo "\$candidate" -verify_arch x86_64 arm64/);
  assert.doesNotMatch(verifier, /lipo -verify_arch[^\n]*"\$candidate"/);
  assert.match(verifier, /lipo -archs "\$candidate" 2>\/dev\/null \|\| echo unknown/);
  assert.doesNotMatch(verifier, /" \$architectures " !=/);
});

test('one-time preview marker is optional but must match the exact reviewed payload when present', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-preview-marker-'));
  const markerPath = path.join(temporaryDirectory, 'preview.trigger');
  try {
    assert.deepEqual(validateOptionalPreviewMarker(markerPath), { present: false, valid: true });
    fs.writeFileSync(markerPath, expectedPreviewMarker);
    assert.deepEqual(validateOptionalPreviewMarker(markerPath), { present: true, valid: true });
    fs.writeFileSync(markerPath, `${expectedPreviewMarker}unexpected=true\n`);
    assert.deepEqual(validateOptionalPreviewMarker(markerPath), { present: true, valid: false });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('preview asset preparation emits only DMG, ZIP, checksum and Chinese notes', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-mac-preview-assets-'));
  try {
    const releaseDirectory = path.join(temporaryDirectory, 'release');
    fs.mkdirSync(releaseDirectory);
    const version = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8')).version;
    const dmg = path.join(releaseDirectory, `PH-Launcher-${version}-macOS-universal.dmg`);
    const zip = path.join(releaseDirectory, `PH-Launcher-${version}-macOS-universal.zip`);
    fs.writeFileSync(dmg, 'fake-dmg-for-manifest-test');
    fs.writeFileSync(zip, 'fake-zip-for-manifest-test');

    const result = preparePreviewAssets({ projectDirectory, releaseDirectory, minimumAssetBytes: 1 });
    assert.equal(result.assets.length, 4);
    const manifest = fs.readFileSync(path.join(releaseDirectory, 'SHA256SUMS.txt'), 'utf8');
    assert.match(manifest, new RegExp(`^${sha256(dmg)}  PH-Launcher-${version}-macOS-universal\\.dmg`, 'm'));
    assert.match(manifest, new RegExp(`^${sha256(zip)}  PH-Launcher-${version}-macOS-universal\\.zip`, 'm'));
    const notesName = `PH-Launcher-${version}-macOS-UNSIGNED-TEST-zh-CN.md`;
    const notes = fs.readFileSync(path.join(releaseDirectory, notesName), 'utf8');
    assert.match(notes, /pre-release（预发布版本）/);
    assert.match(notes, /没有 Developer ID 开发者身份签名/);
    assert.doesNotMatch(notes, /\{\{VERSION\}\}/);
    assert.ok(result.assets.some((asset) => path.basename(asset) === notesName));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('macOS preview workflow is fixed, manual-safe and fail-closed for publishing', () => {
  const workflowPath = path.join(projectDirectory, '.github', 'workflows', 'prepare-macos-preview.yml');
  const source = fs.readFileSync(workflowPath, 'utf8');
  assert.doesNotThrow(() => yaml.load(source, { schema: yaml.JSON_SCHEMA }));
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /default: false/);
  assert.match(source, /\.github\/releases\/mac-preview-v0\.5\.0-1\.trigger/);
  assert.match(source, /PREVIEW_TAG: mac-preview-v0\.5\.0-1/);
  assert.match(source, /permissions:\n\s+contents: read/);
  assert.match(source, /publish:[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(source, /Unable to prove that \$label is absent/);
  assert.equal((source.match(/local http_status/g) || []).length, 2);
  assert.doesNotMatch(source, /\blocal status\b|\bcase "\$status"/);
  assert.match(source, /--prerelease/);
  assert.match(source, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(source, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(source, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(source, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.doesNotMatch(source, /\.pkg\b/);
  assert.doesNotMatch(source, /refs\/tags\/v\*/);

  const shellPayload = expectedPreviewMarker.trimEnd().replaceAll('\n', '\\n');
  assert.ok(source.includes(`expected=$'${shellPayload}'`));

  const repositoryMarkerPath = path.join(projectDirectory, '.github', 'releases', 'mac-preview-v0.5.0-1.trigger');
  assert.equal(validateOptionalPreviewMarker(repositoryMarkerPath).valid, true);
});
