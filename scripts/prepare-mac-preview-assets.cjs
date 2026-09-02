const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function sha256(filePath) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function preparePreviewAssets(options = {}) {
  const projectDirectory = path.resolve(options.projectDirectory || path.join(__dirname, '..'));
  const releaseDirectory = path.resolve(options.releaseDirectory || path.join(projectDirectory, 'release'));
  const minimumAssetBytes = options.minimumAssetBytes ?? (100 * 1024 * 1024);
  if (!Number.isSafeInteger(minimumAssetBytes) || minimumAssetBytes < 1) {
    throw new Error('minimumAssetBytes must be a positive safe integer');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('package.json version is invalid');

  const diskImageName = `PH-Launcher-${version}-macOS-universal.dmg`;
  const zipName = `PH-Launcher-${version}-macOS-universal.zip`;
  const requiredFiles = [diskImageName, zipName];
  for (const fileName of requiredFiles) {
    const filePath = path.join(releaseDirectory, fileName);
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < minimumAssetBytes) {
      throw new Error(`Missing or unexpectedly small macOS preview asset: ${fileName}`);
    }
  }

  const templatePath = path.join(projectDirectory, 'build', 'mac-unsigned-preview-notes.md');
  const notesName = `PH-Launcher-${version}-macOS-UNSIGNED-TEST-说明.md`;
  const notesPath = path.join(releaseDirectory, notesName);
  const notes = fs.readFileSync(templatePath, 'utf8').replaceAll('{{VERSION}}', version);
  if (notes.includes('{{VERSION}}')) throw new Error('Preview notes still contain an unresolved version placeholder');
  fs.writeFileSync(notesPath, notes, 'utf8');

  const manifestPath = path.join(releaseDirectory, 'SHA256SUMS.txt');
  const manifest = requiredFiles
    .map((fileName) => `${sha256(path.join(releaseDirectory, fileName))}  ${fileName}`)
    .join('\n');
  fs.writeFileSync(manifestPath, `${manifest}\n`, 'utf8');

  return {
    version,
    assets: [...requiredFiles, 'SHA256SUMS.txt', notesName].map((fileName) => path.join(releaseDirectory, fileName)),
  };
}

if (require.main === module) {
  try {
    const result = preparePreviewAssets();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { preparePreviewAssets, sha256 };
