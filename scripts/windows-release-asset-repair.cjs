const crypto = require('node:crypto');
const fs = require('node:fs');

const TAG = 'v0.5.1';
const TARGET_COMMIT = '8c88df2ce67bfe571272e71abe4efd7e4a9572d3';
const MANIFEST_NAME = 'PH-Launcher-0.5.1-SHA256.txt';

const FIXED_ASSETS = [
  {
    name: 'PH-Launcher-0.5.1-x64.exe',
    size: 152_900_666,
    digest: '03e85e0dbd1d5ffe10aee6ed8c01f95edcd8e011d71b57e2070b3bba597921b3',
  },
  {
    name: 'PH-Launcher-0.5.1-Portable.exe',
    size: 136_998_236,
    digest: '618c3437052d287bf92bed279e494b36ac9ca25d024936c2e1dc251b9cd403ea',
  },
  {
    name: 'PH-Launcher-0.5.1-Source.zip',
    size: 1_235_999,
    digest: '4f54319612a2bdf673de858e4e9c3228039d2d0c66657d5ccfe3e472b0382afd',
  },
];

const DOCUMENT_ASSETS = [
  {
    oldName: 'PH-Launcher-.md',
    name: 'PH-Launcher-User-Guide-zh-CN.md',
    label: 'PH Launcher 使用指南',
    size: 11_760,
    digest: '55cf9ccbbcc07ab5db7c21b5f5262b73501919e104764afcecf667209a31ec32',
  },
  {
    oldName: 'PH-Launcher-0.5.1-.md',
    name: 'PH-Launcher-0.5.1-Release-and-Security-Notes-zh-CN.md',
    label: 'v0.5.1 发布与安全说明',
    size: 3_546,
    digest: '8a5b321b0fb823e443f7ec96366d0f121938b8ec2672161f1171e27733930d60',
  },
];

const FIXED_MANIFEST_CONTENT = [
  ...FIXED_ASSETS.map((asset) => `${asset.digest}  ${asset.name}`),
  ...DOCUMENT_ASSETS.map((asset) => `${asset.digest}  ${asset.name}`),
  '',
].join('\n');

const OLD_MANIFEST = {
  size: 492,
  digest: 'ec6fba9e90e4837acc4b0cb6f050add5a5cf86d379b90b52b21dada96ad2c2da',
};

const NEW_MANIFEST = {
  size: Buffer.byteLength(FIXED_MANIFEST_CONTENT),
  digest: crypto.createHash('sha256').update(FIXED_MANIFEST_CONTENT).digest('hex'),
};

function assertReleaseShape(release) {
  if (!release || typeof release !== 'object') throw new Error('Release response is missing.');
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error('Windows v0.5.1 must remain a published stable release.');
  }
  if (!Array.isArray(release.assets)) throw new Error('Release assets are missing.');
  const names = release.assets.map((asset) => asset?.name);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
    throw new Error('Release asset names must be present and unique.');
  }
}

function assertAsset(asset, expected) {
  if (!asset) throw new Error(`Missing release asset: ${expected.name}`);
  if (asset.size !== expected.size) throw new Error(`Unexpected size for ${asset.name}.`);
  if (asset.digest !== `sha256:${expected.digest}`) throw new Error(`Unexpected digest for ${asset.name}.`);
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error(`Invalid asset id for ${asset.name}.`);
}

function analyzeRelease(release) {
  assertReleaseShape(release);
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const allowedNames = new Set([MANIFEST_NAME]);

  for (const expected of FIXED_ASSETS) {
    allowedNames.add(expected.name);
    assertAsset(byName.get(expected.name), expected);
  }

  const renames = [];
  for (const expected of DOCUMENT_ASSETS) {
    allowedNames.add(expected.oldName);
    allowedNames.add(expected.name);
    const matches = [byName.get(expected.oldName), byName.get(expected.name)].filter(Boolean);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one of ${expected.oldName} or ${expected.name}.`);
    }
    const selected = matches[0];
    assertAsset(selected, { ...expected, name: selected.name });
    if (selected.name === expected.oldName) {
      renames.push({
        assetId: selected.id,
        oldName: expected.oldName,
        newName: expected.name,
        label: expected.label,
      });
    }
  }

  const unexpected = release.assets.filter((asset) => !allowedNames.has(asset.name));
  if (unexpected.length) throw new Error(`Unexpected release asset: ${unexpected[0].name}`);
  if (release.assets.length < 5 || release.assets.length > 6) {
    throw new Error(`Unexpected release asset count: ${release.assets.length}`);
  }

  const manifest = byName.get(MANIFEST_NAME);
  let manifestAction = 'upload';
  let manifestId = null;
  if (manifest) {
    manifestId = manifest.id;
    if (manifest.size === OLD_MANIFEST.size && manifest.digest === `sha256:${OLD_MANIFEST.digest}`) {
      manifestAction = 'replace';
    } else if (manifest.size === NEW_MANIFEST.size && manifest.digest === `sha256:${NEW_MANIFEST.digest}`) {
      manifestAction = 'keep';
    } else {
      throw new Error('The checksum manifest is neither the reviewed old version nor the reviewed repaired version.');
    }
    if (!Number.isSafeInteger(manifest.id) || manifest.id <= 0) throw new Error('Invalid checksum manifest asset id.');
  }

  return { renames, manifestAction, manifestId };
}

function validateFinalRelease(release) {
  const plan = analyzeRelease(release);
  if (plan.renames.length) throw new Error('A documentation asset still has its normalized GitHub name.');
  if (plan.manifestAction !== 'keep') throw new Error('The repaired checksum manifest is not present.');
  if (release.assets.length !== 6) throw new Error('The repaired release must contain exactly six assets.');
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'write-manifest') {
    const outputPath = process.argv[3];
    if (!outputPath) throw new Error('Manifest output path is required.');
    fs.writeFileSync(outputPath, FIXED_MANIFEST_CONTENT, 'utf8');
    return;
  }
  const release = JSON.parse(await readStdin());
  if (mode === 'analyze') {
    process.stdout.write(JSON.stringify(analyzeRelease(release)));
    return;
  }
  if (mode === 'verify-final') {
    validateFinalRelease(release);
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DOCUMENT_ASSETS,
  FIXED_ASSETS,
  FIXED_MANIFEST_CONTENT,
  MANIFEST_NAME,
  NEW_MANIFEST,
  OLD_MANIFEST,
  TAG,
  TARGET_COMMIT,
  analyzeRelease,
  validateFinalRelease,
};
