const test = require('node:test');
const assert = require('node:assert/strict');
const { trayMenu } = require('../electron/tray-menu.cjs');
test('tray only exposes open and quit, using the saved interface language', () => {
  for (const language of ['zh-CN', 'en']) {
    const called = [];
    const menu = trayMenu({ language, open: () => called.push('open'), quit: () => called.push('quit') });
    assert.equal(menu.length, 3);
    assert.equal(menu[1].type, 'separator');
    assert.deepEqual(menu.filter(item => item.label).map(item => item.label), language === 'en' ? ['Open PH Launcher', 'Quit'] : ['打开 PH Launcher', '退出']);
    menu[0].click(); menu[2].click(); assert.deepEqual(called, ['open', 'quit']);
  }
});
