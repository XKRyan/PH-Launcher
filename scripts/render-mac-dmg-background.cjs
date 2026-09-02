const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const WIDTH = 720;
const HEIGHT = 480;
const projectDirectory = path.resolve(__dirname, '..');
const sourcePath = path.join(projectDirectory, 'build', 'mac-dmg-background.svg');
const outputPath = path.join(projectDirectory, 'build', 'mac-dmg-background.png');

async function render() {
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
