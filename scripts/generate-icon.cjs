const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WINDOWS_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directorySize = 6 + (images.length * 16);
  let imageOffset = directorySize;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
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
  const sourceMarkup = fs.readFileSync(source, 'utf8');
  const masterSourcePath = path.join(temporaryProfile, 'icon-render-1024.svg');
  fs.writeFileSync(
    masterSourcePath,
    sourceMarkup.replace(/width="256"/, 'width="1024"').replace(/height="256"/, 'height="1024"'),
    'utf8',
  );
  execFileSync(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--window-size=1024,1024',
    `--user-data-dir=${path.join(temporaryProfile, 'profile-1024')}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(masterSourcePath).toString(),
  ], { windowsHide: true, stdio: 'ignore' });

  // Chromium enforces a minimum headless viewport on Windows. Asking it to
  // screenshot a 16–128 px SVG produced transparent frames even though the ICO
  // directory advertised valid sizes. Resize the known-good 1024 px master in
  // Electron instead, where nativeImage preserves the full canvas and alpha.
  const electronPath = require('electron');
  const frameDirectory = path.join(temporaryProfile, 'windows-frames');
  fs.mkdirSync(frameDirectory, { recursive: true });
  execFileSync(electronPath, [
    path.join(__dirname, 'resize-icon-frames.cjs'),
    pngPath,
    frameDirectory,
    WINDOWS_ICON_SIZES.join(','),
  ], { windowsHide: true, stdio: 'ignore' });

  const windowsImages = WINDOWS_ICON_SIZES.map((size) => {
    const windowsPngPath = path.join(frameDirectory, `icon-${size}.png`);
    return { size, png: fs.readFileSync(windowsPngPath) };
  });
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(windowsImages));
  console.log(`Generated full-canvas assets/icon.png and ${WINDOWS_ICON_SIZES.length}-size assets/icon.ico`);
} finally {
  const resolvedTemp = path.resolve(temporaryProfile);
  const resolvedRoot = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`)) fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
