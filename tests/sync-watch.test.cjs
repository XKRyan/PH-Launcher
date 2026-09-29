'use strict';

/**
 * 长轮询（sync/watch）在 PHL 侧的接线测试。
 *
 * 用户 2026-09-28：同步延迟要秒级。原来 PHL 是**每秒**请求一次服务端清单，
 * 而 PHL Lite 是**每 10 分钟**才同步一轮。现在统一改成：
 * 服务端挂住请求（`/api/v1/sync/watch`），一有变化立刻返回，客户端马上去同步。
 *
 * 这里守住三件事：
 *   1. 客户端真的打到 /sync/watch，且超时比服务端挂起时间长；
 *   2. 一秒一次的定时器**不再打服务端**（只查本地文件指纹）—— 否则白折腾；
 *   3. startAutoSync 真的起了长轮询循环，而且它失败不会把程序带崩。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sessionSrc = fs.readFileSync(require.resolve('../electron/phix-session.cjs'), 'utf8');
const cloudSrc = fs.readFileSync(require.resolve('../electron/cloudsync.cjs'), 'utf8');

test('客户端有 watch()，打的是 /sync/watch 且带了光标', () => {
  assert.match(cloudSrc, /watch\(cursor = '', token = DEFAULT_TOKEN\)/);
  assert.match(cloudSrc, /`\/sync\/watch\$\{query\}`/);
  assert.match(cloudSrc, /encodeURIComponent\(cursor\)/, '光标要转义，里面有冒号');
});

test('客户端超时比服务端挂起时间长', () => {
  // 服务端最多挂 25 秒（api/syncwatch.py 的 MAX_HOLD_SECONDS）；
  // 客户端反过来会在服务端刚要返回时掐断，变成一连串无意义的失败重连。
  assert.match(cloudSrc, /const SYNC_WATCH_TIMEOUT_MS = 35_000;/);
  assert.match(cloudSrc, /const SYNC_WATCH_RETRY_MS = 3_000;/);
  assert.match(cloudSrc, /SYNC_WATCH_RETRY_MS,\s*\n\s*SYNC_WATCH_TIMEOUT_MS,/,
    '两个常数要导出，PHL Lite 那边对齐同一套');
});

test('一秒一次的定时器只查本地，不再打服务端', () => {
  assert.match(sessionSrc, /AUTO_POLL_MS = 1000/);
  assert.match(sessionSrc, /await this\.pollOnce\(\{ skipRemote: true \}\)/,
    '本地那把定时器必须跳过远端检查');
  assert.match(sessionSrc, /async pollOnce\(\{ skipRemote = false \} = \{\}\)/);
  assert.match(sessionSrc, /if \(!localChanged && !due && !skipRemote\)/,
    '远端检查只作为长轮询不可用时的兜底');
});

test('startAutoSync 起长轮询循环；stopAutoSync 能让它停下', () => {
  assert.match(sessionSrc, /async #watchLoop\(\)/);
  assert.match(sessionSrc, /void this\.#watchLoop\(\);/);
  assert.match(sessionSrc, /this\.watchCursor = '';/, '启动时要清掉旧光标');
  assert.match(sessionSrc, /const result = await this\.client\.watch\(this\.watchCursor\)/);
  assert.match(sessionSrc, /if \(result\?\.changed\)/, '变了才同步');
  // 循环条件必须看 stopped，否则 stopAutoSync 停不下来
  assert.match(sessionSrc, /while \(!this\.stopped\) \{/);
});

test('长轮询失败会退避重试，不会被异常带崩', () => {
  const loop = sessionSrc.slice(sessionSrc.indexOf('async #watchLoop()'));
  const body = loop.slice(0, loop.indexOf('\n  }') + 4);
  assert.match(body, /catch \(error\)/, '必须自己吞掉异常');
  assert.match(body, /SYNC_WATCH_RETRY_MS/, '退避而不是原地死循环');
  assert.doesNotMatch(body.slice(body.indexOf('catch')), /throw /, 'catch 里不许再抛');
});

test('服务端名额满了（retry_after）要等一下再挂，不能热循环', () => {
  // 服务端同时挂起的个数有上限（挂起占一个 waitress 线程，见 api/syncwatch.py
  // 的 WATCH_SLOTS）。名额满了它会**立刻**回一个 changed=false + retry_after。
  // 这个回包和"正常挂满 25 秒超时"长得一模一样，但含义相反：
  //   超时  → 立刻再挂上（长轮询接力，这是正常节奏）
  //   被打回 → 必须先等一会儿（否则就是拿热循环打服务器，比不挂还糟）
  // 所以循环里必须**认 retry_after 这个信号**，光看 changed 是不够的。
  const loop = sessionSrc.slice(sessionSrc.indexOf('async #watchLoop()'));
  const body = loop.slice(0, loop.indexOf('\n  }') + 4);
  assert.match(body, /retry_after/, '必须读服务端的 retry_after');
  assert.match(body, /Number\.isFinite\(retryAfter\)/, '要挡住脏值，别把 NaN 当延时');
  assert.match(body, /await sleep\(/, '被打回时要真的等');
  assert.match(body, /Math\.min\(retryAfter \* 1000, SYNC_WATCH_RETRY_MS\)/,
    'retry_after 是秒，要换成毫秒，并给自己留个上限');
});

test('状态里能看出走的是长轮询（排障用）', () => {
  assert.match(sessionSrc, /watching: !this\.stopped/);
  assert.match(sessionSrc, /watch_cursor: this\.watchCursor \|\| ''/);
  assert.match(sessionSrc, /last_watch_hit_at:/);
});
