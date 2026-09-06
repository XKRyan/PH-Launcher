// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { encodeRpcBody, parseRpcResponse } = require('../electron/edupage-auth-rpc.cjs');

test('EduPage RPC request uses the upstream eqap/eqacs/eqaz envelope', () => {
  const body = new URLSearchParams(encodeRpcBody({ username: 'student', edupage: '' }));
  assert.equal(body.get('eqaz'), '1');
  assert.equal(body.get('eqacs'), createHash('sha1').update(body.get('eqap')).digest('hex'));
  assert.ok(body.get('eqap').startsWith('dz:'));
  const inner = inflateRawSync(Buffer.from(body.get('eqap').slice(3), 'base64')).toString('utf8');
  const rpcparams = new URLSearchParams(inner).get('rpcparams');
  assert.deepEqual(JSON.parse(rpcparams), { username: 'student', edupage: '' });
});

test('EduPage RPC response accepts plain and upstream base64 envelopes, never code', () => {
  const payload = { status: 'OK', token: 'synthetic' };
  const json = JSON.stringify(payload);
  assert.deepEqual(parseRpcResponse(json), payload);
  assert.deepEqual(parseRpcResponse(`eqz:${Buffer.from(json).toString('base64')}`), payload);
  assert.deepEqual(parseRpcResponse(`eqwd:${Buffer.from(json).toString('base64')}`), payload);
  assert.equal(parseRpcResponse('not-json'), null);
  assert.equal(parseRpcResponse('{"__proto__":{}, broken'), null);
});
