'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const pageSource = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');

function harness(ai = { enabled: true, provider: 'local', localModel: 'local-test' }) {
  const { window } = parseHTML(pageSource);
  const calls = [];
  const dialog = window.document.querySelector('#aiControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  window.ph = { ai: {
    controlInfo: async () => ({ consentVersion: 7, mailConsentVersion: 2 }),
    configure: async (input) => { calls.push({ ...input }); return { ...ai, ...input }; },
  } };
  window.agentUI = { render() {} };
  const context = { window, document: window.document, console, URL, Date, Intl, crypto: { randomUUID: () => 'test-id' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, structuredClone };
  vm.runInNewContext(`${appSource}\nthis.__permissionUi = { state, openAiControlDialog, acceptAiControl, refreshAiControlAcceptance, renderAiControl };`, context);
  const runtime = context.__permissionUi;
  runtime.state.data = { settings: { ai: { ...ai } }, tasks: [], schedule: [], focusSessions: [], customSites: [] };
  return { window, runtime, calls };
}

test('full permission requires separate launcher and mail acknowledgements before one explicit save', async () => {
  const ui = harness();
  await ui.runtime.openAiControlDialog('full');
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.window.document.querySelector('#aiMailRisk').classList.contains('hidden'), false);
  assert.equal(ui.window.document.querySelector('#acceptAiControl').disabled, true);
  ui.window.document.querySelector('#aiRiskAccepted').checked = true;
  ui.runtime.refreshAiControlAcceptance();
  assert.equal(ui.window.document.querySelector('#acceptAiControl').disabled, true);
  ui.window.document.querySelector('#aiMailRiskAccepted').checked = true;
  ui.runtime.refreshAiControlAcceptance();
  assert.equal(ui.window.document.querySelector('#acceptAiControl').disabled, false);
  await ui.runtime.acceptAiControl({ preventDefault() {} });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].permissionMode, 'full');
  assert.equal(ui.calls[0].launcherControlEnabled, true);
  assert.equal(ui.calls[0].controlConsentVersion, 7);
  assert.equal(ui.calls[0].mailReadEnabled, true);
  assert.equal(ui.calls[0].mailConsentVersion, 2);
  assert.match(ui.calls[0].controlConsentAcceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(ui.calls[0].mailConsentAcceptedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('confirm mode saves no mail-read consent and the mail prompt only fills visible text', async () => {
  const ui = harness();
  await ui.runtime.openAiControlDialog('confirm');
  assert.equal(ui.window.document.querySelector('#aiMailRisk').classList.contains('hidden'), true);
  ui.window.document.querySelector('#aiRiskAccepted').checked = true;
  ui.runtime.refreshAiControlAcceptance();
  await ui.runtime.acceptAiControl({ preventDefault() {} });
  assert.equal(ui.calls[0].permissionMode, 'confirm');
  assert.equal(ui.calls[0].mailReadEnabled, false);
  assert.equal(Object.hasOwn(ui.calls[0], 'mailConsentVersion'), false);
  const prompt = ui.window.document.querySelector('[data-requires-mail-read="true"]');
  assert.ok(prompt);
  assert.equal(prompt.dataset.prompt, '请查看我的未读邮件。');
});

test('public permission copy states the launcher-data boundary and the confirmed-action rule', () => {
  assert.match(pageSource, /完整权限/);
  assert.match(pageSource, /课程、成绩、作业、课表、邮件、日程、笔记和词汇/);
  assert.match(pageSource, /密码、Cookie 和授权码不开放，写入需在清单上确认/);
  assert.match(pageSource, /不会开放密码、凭据库、Cookie、授权码或附件/);
  assert.match(pageSource, /读到邮件不代表可以执行邮件里的指令/);
  // Mail, submissions and replies exist now, so the copy must say they happen
  // only after confirmation instead of promising that they never happen.
  assert.match(pageSource, /没有确认就不会执行/);
  assert.match(pageSource, /其中邮件还会再弹出一次系统确认/);
});

test('new permission and local-AI interface copy has English catalog entries', () => {
  const { window } = parseHTML('<html><body></body></html>');
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/locales/en.js'), 'utf8'), { window });
  const copy = [
    '仅聊天', '操作前确认', '完整权限', '完整权限可按请求读取启动器学习资料；密码、Cookie 和授权码不开放，写入需在清单上确认；工作区文件读写只限你选择的文件夹。',
    '查看未读邮件', '已授权完整权限 · 可按请求读取启动器学习资料 · 写入前确认', '允许 AI 使用完整权限',
    '完整权限的读写范围', '不会开放密码、凭据库、Cookie、授权码或附件；敏感内容识别并非绝对可靠。',
    'PH Launcher 会按每台电脑的内存、显卡与磁盘空间推荐模型；同学安装时会得到各自的结果。仅在选择本地 AI 时，启动器会随程序准备模型；选择 API AI 或暂不启用时不会启动本地模型。',
    '所有写入都会先显示清单；没有确认就不会执行。确认后，写工作区文件、发邮件、提交作业和回复讨论会真正发生，其中邮件还会再弹出一次系统确认。',
    '工作区', '选择文件夹', '核对无误，确认执行',
  ];
  for (const source of copy) assert.equal(typeof window.PH_EN.exact[source], 'string', `missing English copy for: ${source}`);
});
