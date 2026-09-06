'use strict';
const path = require('node:path');

function createTrayImage(nativeImage, appRoot, platform = process.platform) {
  // nativeImage does not rasterize SVG data URLs. Use the shipped, verified PNG.
  const source = nativeImage.createFromPath(path.join(appRoot, 'assets', 'icon.png'));
  if (source.isEmpty()) throw new Error('PH Launcher tray icon could not be loaded');
  const size = platform === 'darwin' ? 18 : 32;
  const icon = source.resize({ width: size, height: size, quality: 'best' });
  if (icon.isEmpty()) throw new Error('PH Launcher tray icon is empty');
  return icon;
}

module.exports = { createTrayImage };
