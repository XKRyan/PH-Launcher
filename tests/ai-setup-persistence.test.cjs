'use strict';

/**
 * AI 页面的「选择使用方式」不该被数据刷新冲掉。
 *
 * 用户 2026-09-24 报：「在那个 AI 页面我点啥东西，他不到半秒会自动跳回
 * 不使用 AI 那个选项」。
 *
 * 根因：点「本地 / API」**只改内存里的 state**（用户还没填表单、没点保存），
 * 而主进程每推一次数据快照（学校同步、邮箱、phix 同步…），
 * `window.ph.data.onChanged` 就会把 `state.data` **整体替换**成主进程那份 ——
 * 那份里的 provider 还是旧值，于是 `renderAi()` 下次重画时把选择按钮和人一起
 * 抹回 `off`，顺带把 `#aiConfigPanel` 重建、正在填的表单也清空。
 *
 * 修法：把"还没保存的选择"记进 `state.aiPendingProvider`，渲染时叠加在快照之上；
 * 并且数据刷新时**不重建**已经画好的配置面板。真正保存或离开这一页时清除。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');

test('an unsaved provider pick survives a data refresh', () => {
  assert.match(app, /aiPendingProvider:/, 'state 里要有"还没保存的选择"');
  assert.match(app, /function effectiveAi\(\)/, '渲染要经过一个叠加函数');
  assert.match(app, /if \(!state\.aiPendingProvider \|\| state\.aiPendingProvider === ai\.provider\) return ai;/,
    '和快照一致就直接用快照');
  assert.match(app, /return \{ \.\.\.ai, provider: state\.aiPendingProvider \};/,
    '不一致时用未保存的选择覆盖快照里的 provider');
  // 两个取配置的入口都要走 effectiveAi()，漏一个就还会跳回去
  assert.match(app, /function renderAi\(\) \{\s*\n\s*if \(!state\.data\) return;\s*\n\s*const ai = effectiveAi\(\);/);
  assert.match(app, /function renderAiConfig\(force = false\) \{\s*\n\s*if \(!state\.data\) return;\s*\n\s*const ai = effectiveAi\(\);/);
});

test('clicking a choice records the pick and repaints the panel', () => {
  assert.match(app, /const picked = aiProvider\.dataset\.aiProvider;/);
  assert.match(app, /state\.aiPendingProvider = picked;/);
  assert.match(app, /state\.aiPanelProvider = '';\s*\/\/ 换了 provider，面板必须重画/);
});

test('a data refresh does not rebuild the config panel the user is filling in', () => {
  // renderAi() 里那一处是非强制调用 —— 数据刷新驱动的重画不该清掉表单
  assert.match(app, /if \(showSetup\) \{\s*\n\s*renderAiConfig\(\/\* data refresh: don't rebuild the form \*\/\);/);
  // 其余调用点（用户操作、硬件信息回来）必须传 true
  assert.match(app, /if \(!force && state\.aiPanelProvider === ai\.provider && panel\.childElementCount\) return;/);
  const forced = (app.match(/renderAiConfig\(true\)/g) || []).length;
  assert.ok(forced >= 8, `用户操作路径应强制重画，实际只有 ${forced} 处`);
});

test('saving and leaving the setup clear the pending pick', () => {
  // 保存成功
  assert.match(app, /state\.aiPendingProvider = '';\s*\n\s*state\.aiPanelProvider = '';\s*\n\s*await window\.agentUI\?\.loadHistory\?\.\(\);/);
  // 离开这一页
  assert.match(app, /state\.aiEditing = false;\s*\n\s*\/\/ 离开这一页就把"还没保存的选择"丢掉/);
});
