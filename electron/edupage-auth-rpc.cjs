// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) EdupageAPI/edupage-api contributors
// Copyright (c) 2026 PH Launcher contributors
//
// Compatible with edupage-api 0.12.5's RequestData and login RPC envelope.

'use strict';

const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');

const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;

// urllib.parse.quote(), used by edupage-api, leaves '/' unescaped and encodes
// the five punctuation characters that encodeURIComponent intentionally keeps.
function formQuote(value) {
  return encodeURIComponent(String(value))
    .replace(/%2F/gi, '/')
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formEncode(entries) {
  return Object.entries(entries).map(([key, value]) => `${formQuote(key)}=${formQuote(value)}`).join('&');
}

function encodeRpcBody(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new TypeError('RPC parameters must be an object');
  const rpcparams = formEncode({ rpcparams: JSON.stringify(parameters) });
  const eqap = `dz:${deflateRawSync(Buffer.from(rpcparams, 'utf8')).toString('base64')}`;
  return formEncode({
    eqap,
    eqacs: createHash('sha1').update(eqap).digest('hex'),
    eqaz: '1',
  });
}

function decodeEnvelope(text) {
  if (text.startsWith('eqwd:')) return Buffer.from(text.slice(5), 'base64').toString('utf8');
  if (text.startsWith('eqz:')) return Buffer.from(text.slice(4), 'base64').toString('utf8');
  return text;
}

function parseRpcResponse(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_RPC_RESPONSE_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(decodeEnvelope(value)); } catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

module.exports = { MAX_RPC_RESPONSE_BYTES, encodeRpcBody, parseRpcResponse };
