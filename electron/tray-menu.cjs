'use strict';

// Tray menu: opening the launcher plus quick entries that jump straight to the
// pages a student uses most. Every entry focuses the existing window instead of
// starting a second copy.
const QUICK_ENTRIES = [
  { route: 'today', zh: '今天', en: 'Today' },
  { route: 'timetable', zh: '我的课表', en: 'My timetable' },
  { route: 'courses', zh: '我的课程与作业', en: 'Classes & assignments' },
  { route: 'calendar', zh: '我的日程', en: 'My calendar' },
  { route: 'mail', zh: '平和邮箱', en: 'Pinghe Mail' },
  { route: 'psychology', zh: '心履', en: 'Xinlv' },
  { route: 'plan', zh: '计划', en: 'Plan' },
];

function trayMenu({ language = 'zh-CN', open, openRoute, quit }) {
  const english = language === 'en';
  return [
    { label: english ? 'Open PH Launcher' : '打开 PH Launcher', click: open },
    { type: 'separator' },
    ...QUICK_ENTRIES.map((entry) => ({
      label: english ? entry.en : entry.zh,
      click: () => (typeof openRoute === 'function' ? openRoute(entry.route) : open()),
    })),
    { type: 'separator' },
    { label: english ? 'Quit' : '退出', click: quit },
  ];
}

module.exports = { trayMenu, TRAY_QUICK_ENTRIES: QUICK_ENTRIES };
