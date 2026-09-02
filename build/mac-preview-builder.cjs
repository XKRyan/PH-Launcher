const packageJson = require('../package.json');

const base = packageJson.build;

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    target: ['dmg', 'zip'],
    identity: '-',
    notarize: false,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.preview.plist',
    entitlementsInherit: 'build/entitlements.mac.preview.inherit.plist',
  },
  dmg: {
    title: 'PH Launcher ${version} 测试版',
    background: 'build/mac-dmg-background.png',
    iconSize: 84,
    iconTextSize: 13,
    window: {
      width: 720,
      height: 480,
    },
    contents: [
      { x: 150, y: 250 },
      { x: 570, y: 250, type: 'link', path: '/Applications' },
      {
        x: 360,
        y: 410,
        type: 'file',
        path: 'build/mac-first-open-help.html',
        name: '首次打开帮助.html',
      },
    ],
  },
};
