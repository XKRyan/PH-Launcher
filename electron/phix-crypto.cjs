/**
 * phix 客户端密码学（PHL 侧实现；与 PLL 侧 hellopinghe/phixcrypto.py 逐字节一致）。
 *
 * 三层密钥（详见 D:\phix\phix-协议规范.md §2）：
 *
 *     口令 --scrypt--> KEK --解开--> DEK --HKDF--> 对象密钥 --AES-GCM--> 密文信封
 *
 * **为什么是三层而不是"口令直接加密数据"**：换口令时只需重新包裹 DEK 一次，
 * 云端所有密文一个字节都不用动；忘记口令时还能用恢复码解出同一把 DEK。
 *
 * 互操作测试：D:\phix\server\devtools\test_crypto_interop.py（Python ↔ 本模块）。
 * 改这里的任何常量/字段名 = 改协议，必须同步改 Python 侧。
 */

'use strict';

const crypto = require('node:crypto');

// ---- 协议常量（与规范 §2.4 一致；两端必须完全一致，改这里 = 改协议） ----
const ENVELOPE_PREFIX = 'PHIX1.';
const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 必须显式给：Node 默认 32MiB 装不下 N=2^15,r=8
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const GCM_TAG_BYTES = 16;
const OBJECT_KEY_SALT = Buffer.from('phix/v1/object-keys', 'utf8');
const KEYCHECK_NAME = '__keycheck__';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1
const RECOVERY_CHARS = 24;

// ---------------- 编码 ----------------

/** 字节 → base64url（无填充），与 Python b64e 一致。 */
function b64e(raw) {
  return Buffer.from(raw).toString('base64url');
}

/** base64url（可无填充）→ 字节，与 Python b64d 一致。 */
function b64d(text) {
  if (typeof text !== 'string') throw new TypeError('base64url 必须是字符串');
  // 注意：JS 的 `-text.length % 4` 等价于 `(-text.length) % 4`（负数），
  // 与 Python 的 `-len(text) % 4` 不同，必须写成 `(4 - len % 4) % 4`
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const out = Buffer.from(padded, 'base64url');
  // Node 的 base64 解码会静默丢弃非法字符，这里对齐 Python 的"要么解出来要么抛错"
  if (out.toString('base64url') !== text.replace(/=+$/, '')) {
    throw new Error('base64url 解码失败');
  }
  return out;
}

/** 入参归一为 Buffer：接受 Buffer / Uint8Array / hex 字符串（便于跨语言调用）。 */
function toBytes(value, what = '字节') {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string' && /^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, 'hex');
  }
  throw new TypeError(`${what}必须是 Buffer / Uint8Array / hex 字符串`);
}

/** 口令归一化：NFKC + 去首尾空白 → UTF-8 字节。两端都要做。 */
function normalizePassphrase(s) {
  if (typeof s !== 'string') throw new TypeError('口令必须是字符串');
  // String.prototype.trim 的空白集合与 Python str.strip() 基本一致（含全角空格 U+3000）
  return Buffer.from(s.normalize('NFKC').trim(), 'utf8');
}

/** 新盐：16 字节的 hex 字符串（与 Python new_salt 一致）。 */
function newSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

// ---------------- AAD：两族，各自绑定的东西不同 ----------------
//
// 身份族绑 username：注册**之前**就要算好 key_wrap / recovery_wrap / key_check，
//   那时还拿不到 user_id，所以身份族只能用 username。
// 对象族绑 user_id + 对象名：同步发生在登录之后，user_id 已知，
//   绑死"谁 + 哪个文件"，服务端张冠李戴就解不开。

/** 身份族 AAD：`phix/v1/identity|<username>`。 */
function aadIdentity(username) {
  return Buffer.from(`phix/v1/identity|${username}`, 'utf8');
}

/** 对象族 AAD：`phix/v1/object|<user_id>|<name>`。 */
function aadObject(userId, name) {
  return Buffer.from(`phix/v1/object|${userId}|${name}`, 'utf8');
}

// ---------------- KDF ----------------
//
// 两代派生方式（对应 `加密链路思路.md` §2.2）：
//
//   v1（老账号）  口令 --scrypt--> KEK                  KEK 直接用来包 DEK
//   v2（新账号）  口令 --scrypt--> MK --HKDF("auth")--> AuthHash  ← 发给服务器
//                                   --HKDF("enc") --> KEK       ← 永不出客户端
//
// **v2 的意义**：服务器只拿到 AuthHash，而 `AuthHash = HKDF(MK)` 是**单向**的 ——
// 它反推不出 MK，也就永远算不出 KEK。于是即使服务器被入侵、即使它记下了登录时
// 收到的东西，也解不开用户云端的数据。v1 做不到这一点（服务器见过口令，等于见过钥匙）。

const KDF_ALGO_V1 = 'scrypt-n15-r8-p1';
const KDF_ALGO_V2 = 'scrypt-hkdf-v2';
/** 新账号默认用 v2（服务器只拿到 AuthHash，永远算不出 KEK）。 */
const KDF_ALGO = KDF_ALGO_V2;
const KDF_ALGOS = Object.freeze([KDF_ALGO_V1, KDF_ALGO_V2]);
const AUTH_INFO = Buffer.from('phix/v1/auth', 'utf8');
const ENC_INFO = Buffer.from('phix/v1/enc', 'utf8');

/**
 * 盐的 hex → 字节，并校验长度（规范只允许 16 字节）。
 * 两代 KDF 都用它，免得各处自己 `Buffer.from(hex,'hex')` 少校验。
 */
function saltBytes(saltHex) {
  if (typeof saltHex !== 'string') throw new TypeError('盐必须是十六进制字符串');
  if (!/^[0-9a-fA-F]*$/.test(saltHex) || saltHex.length % 2 !== 0) throw new Error('盐不是合法的十六进制');
  const raw = Buffer.from(saltHex, 'hex');
  if (raw.length !== SALT_BYTES) throw new Error(`盐长度不对（应为 ${SALT_BYTES} 字节，实际 ${raw.length}）`);
  return raw;
}

// ---- MK 缓存（**只是省时间，不改变任何密码学行为**） ----
//
// 为什么需要：登录一次要跑**两次** scrypt —— 一次算 AuthHash、一次解 DEK，
// 而这两次输入完全相同（同一个口令、同一个盐、同一组参数）。
// 实测每次约 130~150 ms（N=2^15），也就是**每次登录白花一次**。
//
// 边界（必须守住）：
//   · 只在**进程内存**里，绝不落盘。
//   · 键 = (口令, 盐, 参数)，换账号/换盐不会串味。
//   · 有上限（8 条）与 TTL（300 秒）。
//   · 登出/切换账号时调 `clearMkCache()` 立刻抹掉。
const MK_CACHE_MAX = 8;
const MK_CACHE_TTL_MS = 300 * 1000;
const _mkCache = new Map();
const _mkStats = { hit: 0, miss: 0 };

function clearMkCache() {
  _mkCache.clear();
}

function mkCacheStats() {
  return { ..._mkStats, size: _mkCache.size };
}

function _mkCacheKey(pass, saltHex) {
  return `${pass}\u0000${saltHex}\u0000${SCRYPT_N}\u0000${SCRYPT_R}\u0000${SCRYPT_P}`;
}

/** 口令 → MK（两代共用这一步：都是 scrypt）。同输入只算一次（见上面缓存说明）。 */
function deriveMk(passphrase, saltHex) {
  const pass = normalizePassphrase(passphrase);
  const key = _mkCacheKey(pass, saltHex);
  const now = Date.now();
  const hit = _mkCache.get(key);
  if (hit && now - hit.at <= MK_CACHE_TTL_MS) {
    _mkStats.hit += 1;
    return hit.mk;
  }
  if (hit) _mkCache.delete(key);
  _mkStats.miss += 1;
  const mk = crypto.scryptSync(pass, saltBytes(saltHex), DEK_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  _mkCache.set(key, { at: now, mk });
  for (const [k, v] of _mkCache) {
    if (now - v.at > MK_CACHE_TTL_MS) _mkCache.delete(k);
  }
  while (_mkCache.size > MK_CACHE_MAX) {
    // Map 保持插入顺序：删最旧的那个（够用，不必精确 LRU）
    _mkCache.delete(_mkCache.keys().next().value);
  }
  return mk;
}

/** 口令 → KEK（32 字节）。`algo` 决定用哪一代；v1 的 KEK 就是 MK。 */
function deriveKek(passphrase, saltHex, algo = KDF_ALGO) {
  const mk = deriveMk(passphrase, saltHex);
  if (algo === KDF_ALGO_V1) return mk;
  if (algo !== KDF_ALGO_V2) throw new Error(`不认识的 KDF：${algo}`);
  return Buffer.from(crypto.hkdfSync('sha256', mk, saltBytes(saltHex), ENC_INFO, DEK_BYTES));
}

/**
 * 口令 → AuthHash（32 字节）。**这是唯一可以发给服务器的东西。**
 *
 * v1 账号没有这个概念（服务器直接比对口令原文），调用它会报错 ——
 * 那种账号只能继续走老路径。
 */
function deriveAuthHash(passphrase, saltHex, algo = KDF_ALGO) {
  if (algo === KDF_ALGO_V1) throw new Error('v1 账号没有 AuthHash（它只能发口令原文）');
  if (algo !== KDF_ALGO_V2) throw new Error(`不认识的 KDF：${algo}`);
  const mk = deriveMk(passphrase, saltHex);
  return Buffer.from(crypto.hkdfSync('sha256', mk, saltBytes(saltHex), AUTH_INFO, DEK_BYTES));
}

/** 给服务器发的那串东西（hex）。 */
function authHashHex(passphrase, saltHex, algo = KDF_ALGO) {
  return deriveAuthHash(passphrase, saltHex, algo).toString('hex');
}

/** 这个账号的 KDF 版本是否需要发 AuthHash（而不是口令原文）。 */
function usesAuthHash(algo) {
  return (algo || KDF_ALGO) !== KDF_ALGO_V1;
}

/** DEK + 对象名 → 对象密钥。**只依赖 DEK 与名字**，所以换口令不会让密文作废。 */
function deriveObjectKey(dek, name) {
  const key = crypto.hkdfSync('sha256', toBytes(dek, 'DEK'), OBJECT_KEY_SALT, Buffer.from(name, 'utf8'), 32);
  return Buffer.from(key); // hkdfSync 返回 ArrayBuffer，必须包一层
}

// ---------------- 信封 ----------------

/** 加密 → 信封字符串 `PHIX1.<b64 nonce>.<b64 ct||tag>`。 */
function seal(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', toBytes(key, '密钥'), nonce);
  if (aad && aad.length) cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(toBytes(plaintext, '明文')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${b64e(nonce)}.${b64e(Buffer.concat([body, tag]))}`;
}

/** 解密信封；口令 / 名字 / 用户不对会抛错（认证标签失败）。 */
function unseal(key, envelope, aad) {
  if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
    throw new Error('不是 PHIX1 信封');
  }
  const rest = envelope.slice(ENVELOPE_PREFIX.length);
  let nonce;
  let body;
  try {
    const cut = rest.indexOf('.');
    if (cut < 0) throw new Error('信封格式损坏');
    nonce = b64d(rest.slice(0, cut));
    body = b64d(rest.slice(cut + 1));
  } catch {
    throw new Error('信封格式损坏');
  }
  if (nonce.length !== NONCE_BYTES || body.length < GCM_TAG_BYTES) throw new Error('信封格式损坏');
  const decipher = crypto.createDecipheriv('aes-256-gcm', toBytes(key, '密钥'), nonce);
  if (aad && aad.length) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(body.subarray(body.length - GCM_TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - GCM_TAG_BYTES)), decipher.final()]);
}

/** 加密对象（对象密钥 + 对象族 AAD）。 */
function sealObject(dek, userId, name, plaintext) {
  return seal(deriveObjectKey(dek, name), plaintext, aadObject(userId, name));
}

/** 解密对象（对象密钥 + 对象族 AAD）。 */
function unsealObject(dek, userId, name, envelope) {
  return unseal(deriveObjectKey(dek, name), envelope, aadObject(userId, name));
}

// ---------------- DEK 包裹 / 解包（身份族 AAD） ----------------

/** 口令包裹 DEK。 */
function wrapDek(dek, passphrase, saltHex, username, algo = KDF_ALGO) {
  return seal(deriveKek(passphrase, saltHex, algo), dek, aadIdentity(username));
}

/** 口令解出 DEK；长度不对直接报错。 */
function unwrapDek(envelope, passphrase, saltHex, username, algo = null) {
  // algo 不传时**自动判**：老账号是 v1（KEK = MK），新账号是 v2。
  // 传错会解不开（GCM 认证失败），所以调用方拿到账号的 kdf_algo 时应该传进来。
  const candidates = algo ? [algo] : KDF_ALGOS;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const dek = unseal(deriveKek(passphrase, saltHex, candidate), envelope, aadIdentity(username));
      if (dek.length !== DEK_BYTES) throw new Error('DEK 长度不对');
      return dek;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('口令不对');
}

/**
 * 自检块：用 `__keycheck__` 的对象密钥加密**一串随机明文**（不是公开常量）。
 *
 * 明文由服务端保存且**任何接口都不下发**，所以"报一串常量"伪造不了
 * 「我手里有 DEK」这件事；只有解开这个信封才能拿到它。
 */
function makeKeyCheck(dek, username, plainHex) {
  return seal(deriveObjectKey(dek, KEYCHECK_NAME), Buffer.from(plainHex, 'hex'), aadIdentity(username));
}

/** 新自检明文：32 字节随机数的 hex。 */
function newKeyCheckPlain() {
  return crypto.randomBytes(32).toString('hex');
}

/** 解出服务端存的自检块明文（hex）。解不开 → 口令/DEK 不对。 */
function proveDek(dek, username, keyCheck) {
  return unseal(deriveObjectKey(dek, KEYCHECK_NAME), keyCheck, aadIdentity(username)).toString('hex');
}

/** 自检块解得开 ⟹ DEK 正确（GCM 认证标签保证）。 */
function checkDek(dek, username, keyCheck) {
  try {
    proveDek(dek, username, keyCheck);
  } catch {
    return false;
  }
  return true;
}

// ---------------- 应用层加密传输（密封盒 / 信封） ----------------
//
// 对应 `加密链路思路.md` §3：**用应用层加密替代 HTTPS**，让网线上只有密文。
// 与上面的"对象加密"是两回事：
//
//   对象加密 = 数据在云端怎么存（长期密钥，DEK 派生）
//   密封盒   = 数据在网线上怎么走（一次性会话密钥 SK，用完就扔）
//
// 每次请求换一把 SK：截获了也没用，因为它只对那一次请求有效。
// 服务端那侧的权威实现在 PLL 的 `hellopinghe/phixcrypto.py`（`seal_box` 一族），
// 两边必须**逐字节一致**；互操作测试见 `D:\phix\server\devtools\test_crypto_interop.py`。

const SEAL_INFO = Buffer.from('phix/v1/seal', 'utf8');
const REQ_AAD_PREFIX = 'phix/v1/req|';
const EPK_LEN = 32;
const NONCE_LEN = 12;
const SK_LEN = 32;
/** X25519 公钥的 DER 外壳（SPKI）：`302a300506032b656e032100` + 32 字节原始公钥。 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** X25519 私钥的 DER 外壳（PKCS8）：`302e020100300506032b656e04220420` + 32 字节原始私钥。 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * Node 的 X25519 公钥 → 32 字节原始公钥。
 *
 * Node 只给 DER/PEM，协议要的是 Python `serialization.Encoding.Raw` 那 32 字节。
 * SPKI 的**尾巴**正好就是它，所以直接切出来；切之前核对前缀，
 * 免得以后 Node/OpenSSL 换了封装格式还默默按 32 字节切（那是错的字节，不会报错）。
 */
function x25519PublicRaw(key) {
  const der = Buffer.from(key.export({ type: 'spki', format: 'der' }));
  if (!der.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)) {
    throw new Error('不是 X25519 公钥（SPKI 前缀不认识）');
  }
  return der.subarray(-EPK_LEN);
}

/** 32 字节原始公钥 → Node 公钥对象。 */
function x25519PublicFromRaw(raw) {
  const bytes = toBytes(raw, 'X25519 公钥');
  if (bytes.length !== EPK_LEN) throw new Error('X25519 公钥必须是 32 字节');
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki',
  });
}

/** Node 的 X25519 私钥 → 32 字节原始私钥（PKCS8 尾巴）。 */
function x25519PrivateRaw(key) {
  const der = Buffer.from(key.export({ type: 'pkcs8', format: 'der' }));
  if (!der.subarray(0, X25519_PKCS8_PREFIX.length).equals(X25519_PKCS8_PREFIX)) {
    throw new Error('不是 X25519 私钥（PKCS8 前缀不认识）');
  }
  return der.subarray(-SK_LEN);
}

/** 32 字节原始私钥 → Node 私钥对象。 */
function x25519PrivateFromRaw(raw) {
  const bytes = toBytes(raw, 'X25519 私钥');
  if (bytes.length !== SK_LEN) throw new Error('X25519 私钥必须是 32 字节');
  return crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8',
  });
}

/** X25519(raw_sk, raw_pk) → 32 字节共享密钥。 */
function x25519Shared(rawSk, rawPk) {
  return Buffer.from(crypto.diffieHellman({
    privateKey: x25519PrivateFromRaw(rawSk),
    publicKey: x25519PublicFromRaw(rawPk),
  }));
}

/** 新生成一对 X25519 密钥（返回**原始字节**，便于与 Python 互操作）。 */
function newX25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { sk: Buffer.from(x25519PrivateRaw(privateKey)), pk: Buffer.from(x25519PublicRaw(publicKey)) };
}

/** HKDF-SHA256（与 Python `_hkdf_sha256` 一致；`hkdfSync` 返回 ArrayBuffer 要包一层）。 */
function hkdf(ikm, salt, info, length = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', toBytes(ikm, 'ikm'), Buffer.from(salt), Buffer.from(info), length));
}

/** 裸 AES-256-GCM 加密（返回 `密文||tag`，不带信封前缀）。 */
function sealRaw(key, nonce, plaintext, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', toBytes(key, '密钥'), Buffer.from(nonce));
  if (aad && aad.length) cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(toBytes(plaintext, '明文')), cipher.final(), cipher.getAuthTag()]);
}

/** 裸 AES-256-GCM 解密（输入是 `密文||tag`）。 */
function openRaw(key, nonce, body, aad) {
  const bytes = toBytes(body, '密文');
  if (bytes.length < GCM_TAG_BYTES) throw new Error('密文太短');
  const decipher = crypto.createDecipheriv('aes-256-gcm', toBytes(key, '密钥'), Buffer.from(nonce));
  if (aad && aad.length) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(bytes.length - GCM_TAG_BYTES));
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - GCM_TAG_BYTES)), decipher.final()]);
}

/** 把消息密封给某个 X25519 公钥的持有者（只有对方能开）。 */
function sealBox(msg, recipientPk) {
  const pk = toBytes(recipientPk, '接收方公钥');
  if (pk.length !== EPK_LEN) throw new Error('接收方公钥必须是 32 字节');
  const { sk: esk, pk: epk } = newX25519KeyPair();
  const shared = x25519Shared(esk, pk);
  const salt = Buffer.concat([epk, pk]);                    // 64 字节
  const key = hkdf(shared, salt, SEAL_INFO);
  const nonce = crypto.randomBytes(NONCE_LEN);
  return Buffer.concat([epk, nonce, sealRaw(key, nonce, msg, salt)]);
}

/** 打开给自己的密封盒（用 X25519 私钥**原始字节**）。 */
function openBox(sealed, recipientSkRaw, recipientPk) {
  const bytes = toBytes(sealed, '密封盒');
  const pk = toBytes(recipientPk, '本机公钥');
  if (bytes.length < EPK_LEN + NONCE_LEN + GCM_TAG_BYTES) throw new Error('密封盒长度不对');
  const epk = bytes.subarray(0, EPK_LEN);
  const nonce = bytes.subarray(EPK_LEN, EPK_LEN + NONCE_LEN);
  const ct = bytes.subarray(EPK_LEN + NONCE_LEN);
  const shared = x25519Shared(toBytes(recipientSkRaw, '本机私钥'), epk);
  const salt = Buffer.concat([epk, pk]);
  return openRaw(hkdf(shared, salt, SEAL_INFO), nonce, ct, salt);
}

/** 信封的 AAD：`phix/v1/req|<方法>|<完整路径>`（路径带 `/api/v1` 前缀）。 */
function envAad(method, path) {
  return Buffer.from(`${REQ_AAD_PREFIX}${method}|${path}`, 'utf8');
}

/** 新的一次性会话密钥。 */
function newSessionKey() {
  return crypto.randomBytes(SK_LEN);
}

/**
 * 把一个请求包装成信封。返回 `{ envelope, sk }`（SK 是这一次请求的会话密钥）。
 *
 * `path` 必须是**完整路径**（含 `/api/v1` 前缀）——服务端 `request.path` 就是它，
 * AAD 里也用它。查询串放进信封的 `q` 字段，**URL 上不带 `?`**（URL 里什么都不泄露）。
 */
function makeEnvelope(serverPk, method, path, body = null, query = '') {
  const sk = newSessionKey();
  const inner = {
    m: method,
    p: path,
    q: query,
    b: body === undefined ? null : body,
    ts: Math.floor(Date.now() / 1000),
    nonce: b64e(crypto.randomBytes(16)),
  };
  const iv = crypto.randomBytes(NONCE_LEN);
  const ct = sealRaw(sk, iv, Buffer.from(JSON.stringify(inner), 'utf8'), envAad(method, path));
  return {
    envelope: { sealed_sk: b64e(sealBox(sk, serverPk)), iv: b64e(iv), ct: b64e(ct) },
    sk,
  };
}

/** 解开服务器返回的信封（AAD 与请求相同）。 */
function openEnvelopeResponse(sk, method, path, envelope) {
  const iv = b64d(envelope.iv);
  const ct = b64d(envelope.ct);
  return openRaw(toBytes(sk, '会话密钥'), iv, ct, envAad(method, path));
}

// ---------------- 恢复码 ----------------

/** 24 位 base32（去掉易混字符）≈ 115 bit 熵，格式 XXXX-XXXX-…-XXXX 便于抄写。 */
function newRecoveryCode() {
  const chars = [];
  for (let i = 0; i < RECOVERY_CHARS; i += 1) {
    chars.push(RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
  }
  const joined = chars.join('');
  const groups = [];
  for (let i = 0; i < RECOVERY_CHARS; i += 4) groups.push(joined.slice(i, i + 4));
  return groups.join('-');
}

/** 去掉分隔符与空白、统一大写；比对与派生都用它。 */
function normalizeRecoveryCode(code) {
  if (typeof code !== 'string') throw new TypeError('恢复码必须是字符串');
  return Array.from(code.normalize('NFKC').toUpperCase())
    .filter((ch) => /[0-9A-Za-z]/.test(ch))
    .join('');
}

/** 恢复码包裹 DEK（AAD 仍是身份族）。 */
function wrapDekWithRecovery(dek, code, saltHex, username, algo = KDF_ALGO) {
  return seal(deriveKek(normalizeRecoveryCode(code), saltHex, algo), dek, aadIdentity(username));
}

/** 恢复码解出 DEK。 */
function unwrapDekWithRecovery(envelope, code, saltHex, username, algo = null) {
  const candidates = algo ? [algo] : KDF_ALGOS;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const dek = unseal(deriveKek(normalizeRecoveryCode(code), saltHex, candidate), envelope, aadIdentity(username));
      if (dek.length !== DEK_BYTES) throw new Error('DEK 长度不对');
      return dek;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('恢复码不对');
}

// ---------------- 一站式：生成 / 重新包裹密钥材料 ----------------

/**
 * 用一把已知 DEK 生成整套密钥材料（注册与「换口令重新包裹」都走它）。
 *
 * `key_check_plain` 在**重新包裹**时必须把原来那串传进来 —— 它是服务端认定的
 * 秘密，换了就对不上了。注册时留空则自动生成。
 *
 * **两个盐、两条链，不能混**（混过一次，见下面的注意事项）：
 *
 * | 名字 | 用途 | 什么时候变 |
 * |---|---|---|
 * | `kdf_salt` | 派生 **KEK**（包 DEK 的那把） | 换包裹口令时**会变** |
 * | `auth_salt` | 派生 **AuthHash**（发给服务器的登录凭证） | **注册时定下，永不改变** |
 *
 * 两者共用一个盐的话：切「独立同步口令」会换 `kdf_salt`，AuthHash 跟着变，
 * 而服务器存的还是旧的 → **下次登录直接失败**。
 *
 * `auth_passphrase` 是**登录口令**（默认等于 `passphrase`）：切成同步口令模式时
 * 登录口令没变，AuthHash 也就不该变 —— 所以要把登录口令单独传进来。
 *
 * 返回键名与 Python material_from_dek 完全一致，另加 `dek_hex` 便于 JSON 序列化。
 */
function materialFromDek(dek, username, passphrase, keyMode = 'password', recoveryCode = null,
  keyCheckPlain = null, kdfAlgo = KDF_ALGO, authSalt = null, authPassphrase = null) {
  const dekBuf = toBytes(dek, 'DEK');
  const code = recoveryCode || newRecoveryCode();
  const plain = keyCheckPlain || newKeyCheckPlain();
  const salt = newSalt();
  const resetSalt = authSalt || newSalt();
  const recoverySalt = newSalt();
  const out = {
    dek: dekBuf,
    dek_hex: dekBuf.toString('hex'),
    recovery_code: code,
    kdf_algo: kdfAlgo,
    kdf_salt: salt,
    auth_salt: resetSalt,
    recovery_salt: recoverySalt,
    key_wrap: wrapDek(dekBuf, passphrase, salt, username, kdfAlgo),
    recovery_wrap: wrapDekWithRecovery(dekBuf, code, recoverySalt, username, kdfAlgo),
    key_check: makeKeyCheck(dekBuf, username, plain),
    key_check_plain: plain,
    key_mode: keyMode,
  };
  if (usesAuthHash(kdfAlgo)) {
    out.auth_hash = authHashHex(authPassphrase || passphrase, resetSalt, kdfAlgo);
  }
  return out;
}

/** 注册新账号：随机生成一把 DEK，返回整套材料 + 恢复码 + AuthHash。 */
function newMaterial(username, passphrase, keyMode = 'password', kdfAlgo = KDF_ALGO) {
  return materialFromDek(crypto.randomBytes(DEK_BYTES), username, passphrase, keyMode,
    null, null, kdfAlgo);
}

/** 换口令 / 切模式：**同一把 DEK**，只换包裹。密文一个字节都不动。 */
function rewrap(dek, username, newPassphrase, keyMode = 'password', recoveryCode = null,
  keyCheckPlain = null, kdfAlgo = KDF_ALGO, authSalt = null, authPassphrase = null) {
  return materialFromDek(dek, username, newPassphrase, keyMode, recoveryCode, keyCheckPlain,
    kdfAlgo, authSalt, authPassphrase);
}

// ---------------- 便于测试：纯函数式自检 ----------------

/** 跑一遍本地往返，确认这套参数在本机能正常工作。 */
function selfCheck() {
  const username = 'selfcheck';
  const mat = newMaterial(username, 'correct horse battery staple');
  const dek = mat.dek;
  const okWrap = unwrapDek(mat.key_wrap, 'correct horse battery staple', mat.kdf_salt, username).equals(dek);
  const okCheck = checkDek(dek, username, mat.key_check);
  const badCheck = checkDek(crypto.randomBytes(32), username, mat.key_check);
  const okProof = proveDek(dek, username, mat.key_check) === mat.key_check_plain;
  const okRec = unwrapDekWithRecovery(mat.recovery_wrap, mat.recovery_code, mat.recovery_salt, username).equals(dek);
  const env = sealObject(dek, 7, 'schedule', Buffer.from('{"hello":"中文"}', 'utf8'));
  const back = unsealObject(dek, 7, 'schedule', env);
  let wrongName = false;
  try {
    unsealObject(dek, 7, 'timetable', env);
  } catch {
    wrongName = true;
  }
  const rw = rewrap(dek, username, 'new phrase', 'password', mat.recovery_code, mat.key_check_plain);
  const okRewrap = unwrapDek(rw.key_wrap, 'new phrase', rw.kdf_salt, username).equals(dek)
    && rw.key_check_plain === mat.key_check_plain;
  // 应用层加密传输：密封盒自开 + 信封往返 + AAD 绑路径
  const { sk: boxSk, pk: boxPk } = newX25519KeyPair();
  const sealed = sealBox(Buffer.from('线上只有密文', 'utf8'), boxPk);
  const okBox = openBox(sealed, boxSk, boxPk).toString('utf8') === '线上只有密文';
  let boxBindsKey = false;
  try {
    const other = newX25519KeyPair();
    openBox(sealed, other.sk, other.pk);
  } catch { boxBindsKey = true; }
  const { envelope, sk: envSk } = makeEnvelope(boxPk, 'POST', '/api/v1/auth/login', { username: 'someone' });
  const okEnvelope = JSON.stringify(Object.keys(envelope)) === JSON.stringify(['sealed_sk', 'iv', 'ct'])
    && openEnvelopeResponse(envSk, 'POST', '/api/v1/auth/login', envelope).length > 0;
  let envelopeBindsPath = false;
  try {
    openEnvelopeResponse(envSk, 'POST', '/api/v1/auth/register', envelope);
  } catch { envelopeBindsPath = true; }
  return {
    key_wrap_roundtrip: okWrap,
    key_check_ok: okCheck,
    key_check_rejects_wrong_dek: !badCheck,
    dek_proof_matches: okProof,
    recovery_roundtrip: okRec,
    object_roundtrip: back.toString('utf8').startsWith('{'),
    aad_binds_name: wrongName,
    rewrap_keeps_dek_and_check: okRewrap,
    seal_box_roundtrip: okBox,
    seal_box_binds_key: boxBindsKey,
    envelope_roundtrip: okEnvelope,
    envelope_binds_path: envelopeBindsPath,
  };
}

module.exports = {
  // 常量
  ENVELOPE_PREFIX,
  KDF_ALGO,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SCRYPT_MAXMEM,
  DEK_BYTES,
  NONCE_BYTES,
  SALT_BYTES,
  GCM_TAG_BYTES,
  OBJECT_KEY_SALT,
  KEYCHECK_NAME,
  RECOVERY_ALPHABET,
  RECOVERY_CHARS,
  // 编码
  b64e,
  b64d,
  normalizePassphrase,
  newSalt,
  // AAD
  aadIdentity,
  aadObject,
  // KDF
  deriveKek,
  deriveObjectKey,
  // MK 缓存（省一次 scrypt；登出/换账号时清）
  clearMkCache,
  mkCacheStats,
  // 信封
  seal,
  unseal,
  sealObject,
  unsealObject,
  // DEK 包裹
  wrapDek,
  unwrapDek,
  makeKeyCheck,
  newKeyCheckPlain,
  proveDek,
  checkDek,
  // KDF 两代（v1 老账号 / v2 新账号，服务器只拿到 AuthHash）
  KDF_ALGO_V1,
  KDF_ALGO_V2,
  KDF_ALGOS,
  AUTH_INFO,
  ENC_INFO,
  saltBytes,
  deriveMk,
  deriveAuthHash,
  authHashHex,
  usesAuthHash,
  // 应用层加密传输：密封盒 + 信封（对应 加密链路思路.md §3）
  SEAL_INFO,
  REQ_AAD_PREFIX,
  EPK_LEN,
  NONCE_LEN,
  SK_LEN,
  x25519PublicRaw,
  x25519PublicFromRaw,
  x25519PrivateRaw,
  x25519PrivateFromRaw,
  x25519Shared,
  newX25519KeyPair,
  hkdf,
  sealRaw,
  openRaw,
  sealBox,
  openBox,
  envAad,
  newSessionKey,
  makeEnvelope,
  openEnvelopeResponse,
  // 恢复码
  newRecoveryCode,
  normalizeRecoveryCode,
  wrapDekWithRecovery,
  unwrapDekWithRecovery,
  // 一站式
  materialFromDek,
  newMaterial,
  rewrap,
  selfCheck,
};
