const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [sourcePath, destinationDirectory, rawSizes] = process.argv.slice(2);

async function main() {
  if (!sourcePath || !destinationDirectory || !rawSizes) {
    throw new Error('Source PNG, destination directory and icon sizes are required');
  }
  const sizes = rawSizes.split(',').map(Number);
  if (sizes.some((size) => !Number.isInteger(size) || size < 16 || size > 256)) {
    throw new Error('Windows icon sizes must be integers between 16 and 256');
  }

  await app.whenReady();
  const master = nativeImage.createFromPath(path.resolve(sourcePath));
  if (master.isEmpty()) throw new Error('The master application icon could not be loaded');
  fs.mkdirSync(destinationDirectory, { recursive: true });
  for (const size of sizes) {
    const frame = master.resize({ width: size, height: size, quality: 'best' });
    if (frame.isEmpty() || frame.getSize().width !== size || frame.getSize().height !== size) {
      throw new Error(`Failed to create the ${size}x${size} Windows icon frame`);
    }
    fs.writeFileSync(path.join(destinationDirectory, `icon-${size}.png`), frame.toPNG());
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
    app.quit();
  });
