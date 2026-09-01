const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const assets = path.join(__dirname, '..', 'assets');
const source = path.join(assets, 'icon.svg');
const pngPath = path.join(assets, 'icon.png');
const edgeCandidates = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const edge = edgeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
if (!edge) throw new Error('Microsoft Edge is required to render the development icon');

const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-icon-'));
try {
  const render = (size, destination, profileSuffix) => execFileSync(edge, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--user-data-dir=${path.join(temporaryProfile, profileSuffix)}`,
      `--screenshot=${destination}`,
      pathToFileURL(source).toString(),
    ], { windowsHide: true, stdio: 'ignore' });
  const windowsPngPath = path.join(temporaryProfile, 'icon-256.png');
  render(1024, pngPath, 'profile-1024');
  render(256, windowsPngPath, 'profile-256');
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(fs.readFileSync(windowsPngPath)));
  console.log('Generated 1024px assets/icon.png and assets/icon.ico');
} finally {
  const resolvedTemp = path.resolve(temporaryProfile);
  const resolvedRoot = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`)) fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
