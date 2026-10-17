'use strict';
// phix P3 面板：**设备/会话列表与注销**（`src/phix-ui.js`）。
//
// P3 之后"一次登录 = 一个会话 = 一台设备"，服务端 `GET /auth/devices` 返回的是
// `sessions`（正式形态）+ `devices`（老式长期令牌，兼容期）；
// `POST /auth/devices/revoke` 能注销某一台或除本机外全部。
// 这里用 linkedom 起最小 DOM，只盯界面这一层：列得出来、点得动、参数对、不注入。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const UI_SOURCE = fs.readFileSync(require.resolve('../src/phix-ui.js'), 'utf8');

const plain = (value) => JSON.parse(JSON.stringify(value));

const STATUS = {
  configured: true, server: 'http://127.0.0.1:8931', username: 'someone', user_id: 12,
  logged_in: true, unlocked: true, key_mode: 'password', auto_sync: true,
  sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '家里的台式机',
  objects: ['schedule'], has_token: true, has_access_token: true, has_refresh_token: true,
  last_report: null, state: { last_sync_at: '', objects: {}, conflicts: [] },
};

function harness({ sessions = [], devices = [] } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><div id="phixSettings"></div></body></html>');
  const log = { sessions: 0, revoke: [] };
  window.ph = {
    phix: {
      status: async () => ({ ok: true, data: STATUS }),
      sessions: async () => {
        log.sessions += 1;
        return {
          ok: true,
          data: {
            sessions: sessions.map((item) => ({ ...item })),
            devices: devices.map((item) => ({ ...item })),
            access_ttl: 900, refresh_ttl: 2592000,
          },
        };
      },
      revokeSession: async (input) => {
        log.revoke.push(input);
        return { ok: true, data: { revoked: 1, sessions: 1, tokens: 0 } };
      },
      // 老接口留着，确认界面已经改用 sessions
      devices: async () => ({ ok: true, data: { devices: [] } }),
      sync: async () => ({ ok: true, data: {} }),
    },
  };
  window.confirm = () => true;
  vm.runInNewContext(UI_SOURCE, {
    window, document: window.document, console, setTimeout, clearTimeout, Promise,
    Date, Number, Object, Array, String, Math, RegExp, JSON, Map, Set, Boolean, Error,
    CustomEvent: window.CustomEvent,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { window, document: window.document, log, settle };
}

const click = (window, node) => {
  assert.ok(node, 'expected a clickable node');
  node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
};
const textOf = (document) => document.getElementById('phixSettings').textContent;

const TWO_SESSIONS = [
  { id: 3, device: '家里的台式机', current: true, last_seen_at: '2026-09-12T10:00:00+08:00' },
  { id: 4, device: '笔记本', current: false, last_seen_at: '2026-09-11T09:00:00+08:00' },
];

test('P3 界面：列出会话，本机那台没有注销按钮，别的设备有', async () => {
  const { window, document, log, settle } = harness({ sessions: TWO_SESSIONS });
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  assert.equal(log.sessions, 1, '走的是 sessions 接口');
  const rows = [...document.querySelectorAll('#phixDevicesList .phix-device')];
  assert.equal(rows.length, 2);
  assert.match(textOf(document), /家里的台式机/);
  assert.match(textOf(document), /笔记本/);
  assert.match(textOf(document), /共有 2 台已登录设备/);
  const buttons = [...document.querySelectorAll('#phixDevicesList [data-phix-revoke]')];
  assert.equal(buttons.length, 1, '只给"别的设备"注销按钮');
  assert.equal(buttons[0].dataset.phixRevoke, '4');
  assert.equal(textOf(document).includes('本机'), true, '本机那台标出来');
});

test('P3 界面：点"注销这一台" → 带上 session_id 发到主进程', async () => {
  const { window, document, log, settle } = harness({ sessions: TWO_SESSIONS });
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  click(window, document.querySelector('#phixDevicesList [data-phix-revoke]'));
  await settle();
  await settle();
  assert.deepEqual(plain(log.revoke), [{ session_id: 4 }]);
  assert.equal(log.sessions, 2, '注销之后重新拉一次列表');
});

test('P3 界面：两台以上别的设备时给"注销其它全部"，并带上 all_except_current', async () => {
  const { window, document, log, settle } = harness({
    sessions: [
      ...TWO_SESSIONS,
      { id: 5, device: '平板', current: false, created_at: '2026-09-10T08:00:00+08:00' },
    ],
  });
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  const all = document.getElementById('phixRevokeOthers');
  assert.ok(all, '有"注销其它全部设备"按钮');
  click(window, all);
  await settle();
  await settle();
  assert.deepEqual(plain(log.revoke), [{ all_except_current: true }]);
  assert.match(textOf(document), /已注销其它设备/);
});

test('P3 界面：老式长期令牌也列出来（兼容期），但没有注销按钮', async () => {
  const { window, document, settle } = harness({
    devices: [{ id: 9, device: '旧设备', kind: 'legacy', last_used_at: '2026-09-10T08:00:00+08:00' }],
  });
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  assert.match(textOf(document), /旧设备/);
  assert.match(textOf(document), /旧式令牌/);
  assert.equal(document.querySelectorAll('#phixDevicesList [data-phix-revoke]').length, 0);
});

test('P3 界面：一台都没有时说清楚，而且不炸', async () => {
  const { window, document, settle } = harness();
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  assert.match(textOf(document), /没有其它已登录的设备/);
  assert.equal(document.querySelectorAll('#phixDevicesList [data-phix-revoke]').length, 0);
});

test('P3 界面：设备名当文本渲染，不注入', async () => {
  const { window, document, settle } = harness({
    sessions: [{ id: 4, device: '<img src=x onerror=alert(1)>', current: false }],
  });
  await settle();
  click(window, document.getElementById('phixSessions'));
  await settle();
  await settle();
  assert.equal(document.querySelectorAll('#phixDevicesList img').length, 0, '不该出现注入进来的 img');
  assert.match(textOf(document), /<img src=x onerror=alert\(1\)>/, '原样当文字显示');
});
