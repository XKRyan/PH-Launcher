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
  const render = (size, destination, profileSuffix) => {
    // Chromium enforces a minimum headless viewport on Windows. A responsive
    // SVG would therefore be cropped for the small ICO frames, so render a
    // size-specific SVG whose intrinsic dimensions match the screenshot.
    const renderSourcePath = path.join(temporaryProfile, `icon-render-${size}.svg`);
    fs.writeFileSync(
      renderSourcePath,
      sourceMarkup
        .replace(/width="256"/, `width="${size}"`)
        .replace(/height="256"/, `height="${size}"`),
      'utf8',
    );
    return execFileSync(edge, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--user-data-dir=${path.join(temporaryProfile, profileSuffix)}`,
      `--screenshot=${destination}`,
      pathToFileURL(renderSourcePath).toString(),
    ], { windowsHide: true, stdio: 'ignore' });
  };
  render(1024, pngPath, 'profile-1024');
  const windowsImages = WINDOWS_ICON_SIZES.map((size) => {
    const windowsPngPath = path.join(temporaryProfile, `icon-${size}.png`);
    render(size, windowsPngPath, `profile-${size}`);
    return { size, png: fs.readFileSync(windowsPngPath) };
  });
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(windowsImages));
  console.log(`Generated full-canvas assets/icon.png and ${WINDOWS_ICON_SIZES.length}-size assets/icon.ico`);
} finally {
  const resolvedTemp = path.resolve(temporaryProfile);
  const resolvedRoot = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`)) fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
