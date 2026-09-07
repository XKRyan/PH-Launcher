const packageJson = require('../package.json');

const base = packageJson.build;

// pdfjs uses the browser implementation in PH Launcher. Do not ship its
// optional native canvas packages: they are platform-specific and otherwise
// make electron-builder's Universal merge fail on macOS.
const files = [...(base.files || []), '!node_modules/@napi-rs/canvas*/**'];

module.exports = {
  ...base,
  files,
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
    ...base.dmg,
    title: 'PH Launcher 测试安装盘 ${version}',
  },
};
