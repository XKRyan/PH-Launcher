'use strict';
// 共用账号存储（`electron/shared-account-store.cjs`）的**热更新**行为。
//
// 背景：账号只认共用 `data/settings.yaml` 的 `accounts` 段（PHL 与 Lite 共用一份）。
// phix 云同步会把 `settings.accounts` 直接写进这个文件 —— 也就是说**程序运行期间
// 文件会被别的进程改**。如果存储层一直用启动时那份内存缓存，就会出现：
// 明明同步下来了账号，账号页还写"未保存密码"、课表页还写"输入账号密码"，
// 每次都得手点一次"登录并同步"。用户 2026-09-17 反馈的正是这个现象。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SharedAccountStore } = require('../electron/shared-account-store.cjs');

function tmpSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-shared-accounts-'));
  return path.join(dir, 'settings.yaml');
}

const ACCOUNTS_BLOCK = (username = 'someone@example.com') => [
  'accounts:',
  '  edupage:',
  '    subdomain: pingheschool',
  `    username: ${username}`,
  '    password: pw-for-test',
  '  managebac:',
  '    base_url: https://school.managebac.cn',
  `    email: ${username}`,
  '    password: pw-for-test',
  '  mail:',
  `    email: ${username}`,
  '    imap_host: imap.example.invalid',
  '    authcode: authcode-for-test',
  '',
].join('\n');

test('文件里本来没有账号：状态如实说"没保存"', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, 'version: 1\n', 'utf8');
  const store = new SharedAccountStore({ filePath });
  const status = store.status();
  assert.equal(status.sites.edupage.saved, false);
  assert.equal(status.sites.managebac.saved, false);
  assert.equal(status.sites.mail.saved, false);
  assert.equal(store.getForLogin('edupage'), null, '没账号就不能自动登录');
});

test('运行期间文件被写入（= 云同步把账号拉下来了）→ 下一次读就认出来', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, 'version: 1\n', 'utf8');
  const store = new SharedAccountStore({ filePath });
  assert.equal(store.status().sites.edupage.saved, false, '先读一次，把缓存建起来');

  // 模拟 phix 同步：另一个进程把 accounts 写进同一个文件
  fs.writeFileSync(filePath, `version: 1\n${ACCOUNTS_BLOCK()}`, 'utf8');

  const after = store.status();
  assert.equal(after.sites.edupage.saved, true, '同步完之后账号页就该显示已登录');
  assert.equal(after.sites.managebac.saved, true);
  assert.equal(after.sites.mail.saved, true, '邮箱也要认出来');
  assert.equal(after.sites.edupage.displayUsername, 's•••@example.com', '只显示打码用户名');

  const login = store.getForLogin('edupage');
  assert.ok(login, '有了账号就应该能自动登录（否则课表页会一直"输入账号密码"）');
  assert.equal(login.username, 'someone@example.com');
  assert.equal(login.autoLogin, true);
  const fill = store.getForFill('mail', { allowDisabled: true });
  assert.equal(fill.authcode, 'authcode-for-test', '邮箱走客户端授权码');
});

test('文件被**改回**空账号（换了账号/登出）→ 缓存也要跟着失效', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, `version: 1\n${ACCOUNTS_BLOCK()}`, 'utf8');
  const store = new SharedAccountStore({ filePath });
  assert.equal(store.status().sites.managebac.saved, true);

  fs.writeFileSync(filePath, 'version: 1\n', 'utf8');
  assert.equal(store.status().sites.managebac.saved, false, '不能拿着旧缓存不放');
  assert.equal(store.getForLogin('managebac'), null);
});

test('换一个账号名也算变更（mtime 变了就必须重读）', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, `version: 1\n${ACCOUNTS_BLOCK('first@example.com')}`, 'utf8');
  const store = new SharedAccountStore({ filePath });
  assert.equal(store.status().sites.edupage.username, 'first@example.com');

  fs.writeFileSync(filePath, `version: 1\n${ACCOUNTS_BLOCK('second@example.com')}`, 'utf8');
  assert.equal(store.status().sites.edupage.username, 'second@example.com');
});

test('本机保存账号：写进共用文件，别的字段原样保留，读回来一致', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, [
    '# 注释要留着',
    'version: 1',
    'lessons:',
    '- subject: TOK',
    '  teacher: Jiabin Xu',
    'phix:',
    '  server: http://127.0.0.1:8931',
    '',
  ].join('\n'), 'utf8');
  const store = new SharedAccountStore({ filePath });
  store.saveCredential({ siteId: 'edupage', username: 'me@example.com', password: 'pw-123456', autoFill: true, autoLogin: true });

  const text = fs.readFileSync(filePath, 'utf8');
  assert.match(text, /# 注释要留着/, '注释不能丢');
  assert.match(text, /lessons:\n- subject: TOK/, '别的段不能丢');
  assert.match(text, /phix:\n {2}server: http:\/\/127\.0\.0\.1:8931/, 'phix 段不能丢');
  assert.match(text, /phl_auto_login: true/, 'PHL 自己的两个开关写在平台下面');

  const status = store.status();
  assert.equal(status.sites.edupage.saved, true);
  assert.equal(status.sites.edupage.autoLogin, true);
  assert.equal(store.getForLogin('edupage').password, 'pw-123456');
});

test('删账号：只删该平台，别的平台与其它段都不动', () => {
  const filePath = tmpSettings();
  fs.writeFileSync(filePath, `version: 1\n${ACCOUNTS_BLOCK()}`, 'utf8');
  const store = new SharedAccountStore({ filePath });
  store.removeCredential('edupage');
  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(/edupage:/.test(text), false, 'edupage 段没了');
  assert.match(text, /managebac:/, 'managebac 还在');
  assert.match(text, /mail:/, 'mail 还在');
  assert.equal(store.status().sites.edupage.saved, false);
  assert.equal(store.status().sites.managebac.saved, true);
});
