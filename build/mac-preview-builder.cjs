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
    ...base.dmg,
    title: 'PH Launcher 测试安装盘 ${version}',
  },
};
