'use strict';

function trayMenu({ language = 'zh-CN', open, quit }) {
  return [
    { label: language === 'en' ? 'Open PH Launcher' : '打开 PH Launcher', click: open },
    { type: 'separator' },
    { label: language === 'en' ? 'Quit' : '退出', click: quit },
  ];
}

module.exports = { trayMenu };
