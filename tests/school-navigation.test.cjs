"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const pageSource = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

function schoolNavigationItems(document) {
  const nav = document.querySelector('.primary-nav');
  const label = [...nav.children].find((node) => node.classList?.contains('nav-label') && node.textContent.trim() === '学校应用');
  const items = [];
  for (let node = label.nextElementSibling; node && !node.classList.contains('nav-label'); node = node.nextElementSibling) {
    if (node.matches('button.nav-item')) items.push(node);
  }
  return items;
}

function appHarness() {
  const { window } = parseHTML(pageSource);
  const document = window.document;
  const calls = { hidden: 0, opened: [], school: [], calendar: 0, mail: 0 };
  window.ph = {
    sites: { hide: () => { calls.hidden += 1; }, open: async (site) => { calls.opened.push(site); return true; } },
  };
  window.schoolUI = { open: (route) => { calls.school.push(route); } };
  window.calendarUI = { refresh: () => { calls.calendar += 1; } };
  window.mailUI = { open: () => { calls.mail += 1; } };
  const context = {
    window,
    document,
    console,
    URL,
    Date,
    Intl,
    crypto: { randomUUID: () => 'test-id' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
  };
  vm.runInNewContext(`${appSource}\nthis.__schoolNavigation = { navigate, openSite, handleBodyClick, handleSiteState, state, ROUTE_META };`, context);
  context.__schoolNavigation.state.data = { settings: { siteCleanMode: { mail: false } } };
  return { document, calls, runtime: context.__schoolNavigation };
}

test('学校应用侧栏只保留指定的五项，且顺序固定', () => {
  const { document } = parseHTML(pageSource);
  const items = schoolNavigationItems(document);
  assert.deepEqual(items.map((item) => item.textContent.trim()), ['我的课表', '我的日程', '班级课表', '我的课程', '平和邮箱']);
  assert.deepEqual(items.map((item) => item.dataset.route || `site:${item.dataset.site}`), [
    'timetable', 'calendar', 'class-timetable', 'courses', 'mail',
  ]);
  assert.equal(document.querySelector('.primary-nav [data-site="managebac"]'), null);
  assert.equal(document.querySelector('.primary-nav [data-site="edupage"]'), null);
  assert.equal(document.querySelectorAll('.primary-nav [data-route="calendar"]').length, 1, '日程不能同时留在学习分组');
});

test('学校路由复用学校页面并保持各自的活动状态', () => {
  const { document, calls, runtime } = appHarness();

  runtime.navigate('timetable');
  assert.equal(runtime.state.route, 'timetable');
  assert.equal(document.querySelector('#schoolPage').classList.contains('active'), true);
  assert.equal(document.querySelector('[data-route="timetable"]').classList.contains('active'), true);
  assert.equal(document.querySelector('#topTitle').textContent, '我的课表');
  assert.deepEqual(calls.school, ['timetable']);

  runtime.navigate('class-timetable');
  assert.equal(runtime.state.route, 'class-timetable');
  assert.equal(document.querySelector('#schoolPage').classList.contains('active'), true);
  assert.equal(document.querySelector('[data-route="class-timetable"]').classList.contains('active'), true);
  assert.equal(document.querySelector('#topTitle').textContent, '班级课表');
  assert.deepEqual(calls.school, ['timetable', 'class-timetable']);

  runtime.navigate('school');
  assert.equal(runtime.state.route, 'timetable', '旧 school 路由应继续打开个人课表');
  assert.equal(document.querySelector('#topTitle').textContent, '我的课表');

  runtime.navigate('calendar');
  assert.equal(document.querySelector('#calendarPage').classList.contains('active'), true);
  assert.equal(document.querySelector('#schoolPage').classList.contains('active'), false);
  assert.equal(document.querySelector('#topTitle').textContent, '我的日程');
  assert.equal(calls.calendar, 1);
});

test('平和邮箱通过原生页面打开，不再进入内置网页', () => {
  const { document, calls, runtime } = appHarness();
  assert.doesNotThrow(() => runtime.handleSiteState({ id: 'managebac', url: 'https://shph.managebac.cn/', error: '' }), '隐藏的门户不应让状态更新失败');
  runtime.handleBodyClick({ target: document.querySelector('[data-route="mail"]') });
  assert.deepEqual(calls.opened, []);
  assert.equal(calls.mail, 1);
  assert.equal(document.querySelector('#mailPage').classList.contains('active'), true);
  assert.equal(document.querySelector('[data-route="mail"]').classList.contains('active'), true);
  assert.equal(document.querySelector('#topTitle').textContent, '平和邮箱');
  assert.equal(document.querySelector('#siteToolbar').classList.contains('hidden'), true);
});

test('心理模块作为独立内嵌站点打开，不混入学校账号设置', () => {
  const { document, calls, runtime } = appHarness();
  const button = document.querySelector('[data-site="psychology"]');
  assert.ok(button, '侧栏应提供心理模块');
  runtime.handleBodyClick({ target: button });
  assert.deepEqual(calls.opened, ['psychology']);
  assert.equal(runtime.state.activeSite, 'psychology');
  assert.equal(document.querySelector('#siteToolbar').classList.contains('hidden'), true, '心理模块不显示浏览器地址栏');
  assert.equal(document.querySelector('#internalTopActions').classList.contains('hidden'), false);
  assert.equal(document.querySelector('#topTitle').textContent, '心理');
});

test('首次使用引导覆盖学校账号、可选 AI 与心理模块', () => {
  assert.ok(pageSource.includes('id="onboardingDialog"'));
  assert.match(appSource, /onboardingCompleted/);
  assert.match(appSource, /data-onboarding-account/);
  assert.match(appSource, /onboardingAiSettings/);
  assert.match(appSource, /onboardingPsychology/);
});
