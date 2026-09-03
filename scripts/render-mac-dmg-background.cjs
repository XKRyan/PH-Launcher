const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const WIDTH = 720;
const HEIGHT = 480;
const projectDirectory = path.resolve(__dirname, '..');
const sourcePath = path.join(projectDirectory, 'build', 'mac-dmg-background.svg');
const outputPath = path.join(projectDirectory, 'build', 'mac-dmg-background.png');
const requiredGuidance = [
  '只拖本窗口左侧 App',
  '按住这里 ↓',
  '放到这里 ↓',
  '不要拖桌面上的“PH Launcher 安装盘”',
];

function verifySourceGuidance() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!source.includes(`width="${WIDTH}" height="${HEIGHT}"`)) {
    throw new Error(`DMG background SVG must be ${WIDTH}x${HEIGHT}`);
  }
  for (const phrase of requiredGuidance) {
    if (!source.includes(phrase)) throw new Error(`DMG background is missing required guidance: ${phrase}`);
  }
}

async function render() {
  verifySourceGuidance();
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    await window.loadFile(sourcePath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const size = image.getSize();
    if (size.width !== WIDTH || size.height !== HEIGHT) {
      throw new Error(`Unexpected background size: ${size.width}x${size.height}`);
    }
    fs.writeFileSync(outputPath, image.toPNG());
    process.stdout.write(`Rendered ${outputPath} (${WIDTH}x${HEIGHT})\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}

render().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
