const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const SOURCE_COMMIT = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b';
const SOURCE_SHA256 = '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf';
const SOURCE_URL = `https://raw.githubusercontent.com/skywind3000/ECDICT/${SOURCE_COMMIT}/ecdict.csv`;
const MAXIMUM_BYTES = 100 * 1024 * 1024;
const cacheDirectory = path.join(__dirname, '..', '.cache', 'ECDICT-meta');
const destinationPath = path.join(cacheDirectory, 'ecdict.csv');
const commitPath = path.join(cacheDirectory, '.source-commit');

function sha256(filePath) {
  const hash = createHash('sha256');
  const file = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(file, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest('hex');
}

async function main() {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  if (fs.existsSync(destinationPath) && sha256(destinationPath) === SOURCE_SHA256) {
    fs.writeFileSync(commitPath, `${SOURCE_COMMIT}\n`, 'utf8');
    console.log('Pinned ECDICT source is already available.');
    return;
  }

  const temporaryPath = path.join(cacheDirectory, `ecdict-${randomUUID()}.part`);
  try {
    const response = await fetch(SOURCE_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60_000),
      headers: { 'user-agent': 'PH Launcher dictionary builder' },
    });
    if (!response.ok || !response.body) throw new Error(`ECDICT download failed with HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAXIMUM_BYTES) throw new Error('ECDICT source exceeds the reviewed size limit');

    let downloaded = 0;
    const hash = createHash('sha256');
    const monitor = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > MAXIMUM_BYTES) return callback(new Error('ECDICT source exceeds the reviewed size limit'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), monitor, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== SOURCE_SHA256) throw new Error(`ECDICT SHA-256 mismatch: ${actualSha256}`);
    fs.renameSync(temporaryPath, destinationPath);
    fs.writeFileSync(commitPath, `${SOURCE_COMMIT}\n`, 'utf8');
    console.log(`Pinned ECDICT source downloaded and verified (${downloaded} bytes).`);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
