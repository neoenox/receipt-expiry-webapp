/**
 * Web Push (RFC 8030 / 8291 / 8292) の送信を Web Crypto だけで実装する。
 * Cloudflare Workers で web-push (Node 依存) を使わずに送るための最小実装。
 * oci/server.js が web-push で送っていた形式 (aes128gcm / VAPID ES256) に揃えている。
 */

const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    throw new Error('Invalid base64url value');
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** VAPID 秘密鍵 (base64url, 32byte) を CryptoKey にする。 */
async function importVapidPrivateKey(privateKey) {
  return crypto.subtle.importKey(
    'pkcs8',
    buildPkcs8(base64UrlDecode(privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/** 生の 32byte 秘密鍵を PKCS#8 (SEC1 ECPrivateKey ラッパー) にする。 */
function buildPkcs8(rawPrivateKey) {
  // SEC1 ECPrivateKey: version=1, privateKey(32), [0] namedCurve=OID 1.2.840.10045.3.1.7
  const ecBody = concatBytes(
    new Uint8Array([0x02, 0x01, 0x01]),
    new Uint8Array([0x04, 0x20]),
    rawPrivateKey,
    new Uint8Array([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])
  );
  const ecPrivateKey = concatBytes(new Uint8Array([0x30, ecBody.length]), ecBody);
  // PKCS#8: version=0, alg=id-ecPublicKey+prime256v1, privateKey=OCTET STRING
  const alg = new Uint8Array([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ]);
  const body = concatBytes(
    new Uint8Array([0x02, 0x01, 0x00]),
    alg,
    new Uint8Array([0x04, ecPrivateKey.length]),
    ecPrivateKey
  );
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

/** RFC 8292 の VAPID Authorization ヘッダ値を生成する。 */
export async function buildVapidAuthorization(privateKey, publicKey, audience, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: subject,
  })));
  const unsigned = `${header}.${payload}`;
  const key = await importVapidPrivateKey(privateKey);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned)
  ));
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${publicKey}`;
}

export async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/** RFC 8291 の aes128gcm 暗号化を行い、HTTP ボディを返す。 */
export async function encryptPayload(subscription, payload) {
  const uaPublic = base64UrlDecode(subscription.keys.p256dh);
  const authSecret = base64UrlDecode(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04 || authSecret.length !== 16) {
    throw new Error('Invalid subscription keys');
  }

  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256
  ));

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, serverPublic);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // 平文末尾に padding delimiter 0x02 を付ける (RFC 8188)。
  const plain = concat(encoder.encode(payload), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', prk, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, plain
  ));

  const header = new Uint8Array(86);
  header.set(salt, 0);
  header[16] = 0x10; // rs = 4096 (16bit big endian)
  header[17] = 0x00;
  header.set(serverPublic, 18);
  return concatBytes(header, ciphertext);
}

function concat(...parts) {
  return concatBytes(...parts);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * 購読先へプッシュ通知を送る。reminder.js の sendNotification に渡す形。
 * 404 / 410 は caller (reminder.js) が購読削除を処理できるよう statusCode を付ける。
 */
export async function sendNotification(subscription, payload, vapid) {
  const endpoint = subscription?.endpoint;
  if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error('Invalid endpoint');
  const url = new URL(endpoint);
  const body = await encryptPayload(subscription, payload);
  const subject = vapid.subject || 'mailto:admin@localhost';
  const authorization = await buildVapidAuthorization(vapid.privateKey, vapid.publicKey, url.origin, subject);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: authorization,
      'TTL': '3600',
      'Urgency': 'normal',
    },
    body,
  });
  if (!response.ok) {
    const error = new Error(`Push service returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}
