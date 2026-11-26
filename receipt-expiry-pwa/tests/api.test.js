import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/analyze.js';
import { onRequestPost as onMetricsPost } from '../functions/api/metrics.js';
import { onRequestPost as onValidateKeyPost } from '../functions/api/validate-key.js';
import { onRequestPost as onSubscribePost } from '../functions/api/push/subscribe.js';
import { normalizeAnalysis } from '../public/js/apiClient.js';
import { isValidDate } from '../public/js/dates.js';

const ORIGIN = 'https://receipt-expiry-pwa.pages.dev';
const VALID_IMAGE = 'aGVsbG8=';

function makeRequest(body, { origin = ORIGIN, ip = '203.0.113.10' } = {}) {
  return new Request(`${ORIGIN}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(body),
  });
}

function aiResponse(items, purchaseDate = '2026-11-22') {
  const text = JSON.stringify({ purchaseDate, items });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function withMockFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test('metrics ignores client-supplied count and always increments by one', async () => {
  const values = [100, -5, NaN, '100'];
  for (const count of values) {
    const store = new Map();
    const kv = {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
    };
    const request = new Request(`${ORIGIN}/api/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ kind: 'success', count }),
    });
    const response = await onMetricsPost({ request, env: { PUSH_KV: kv } });
    assert.equal(response.status, 200, `count=${String(count)} は受理されるべき`);
    const keys = [...store.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^metrics:success:\d{4}-\d{2}-\d{2}$/);
    assert.equal(store.get(keys[0]), '1', '保存値は1増えるだけ');
  }
});

test('validate-key fails closed when rate-limit KV is unavailable', async (t) => {
  // KV が読めない場合も書けない場合も、検証を通さず 503 にする。
  let fetchCalled = false;
  withMockFetch(t, async () => {
    fetchCalled = true;
    return new Response('{"ok":true}', { status: 200 });
  });
  for (const rateLimitKV of [
    { async get() { throw new Error('KV read failed'); }, async put() {} },
    { async get() { return null; }, async put() { throw new Error('KV write failed'); } },
  ]) {
    const response = await onValidateKeyPost({
      request: new Request(`${ORIGIN}/api/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.70' },
        body: JSON.stringify({ apiKey: 'test-key' }),
      }),
      env: { RATE_LIMIT_KV: rateLimitKV },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'RATE_LIMIT_UNAVAILABLE');
  }
  assert.equal(fetchCalled, false, 'レート制限が確認できない間に Gemini を呼ばないこと');
});

test('subscribe initializes total from a full KV scan and excludes metrics and rate keys', async () => {
  const SUBSCRIPTION = {
    subscription: { endpoint: 'https://example.test/new', keys: { p256dh: 'AAA', auth: 'BBB' } },
    nextExpiry: null,
  };
  const makeKv = (subscriptionCount) => {
    const store = new Map();
    for (let i = 0; i < subscriptionCount; i += 1) {
      store.set(`https://example.test/sub-${i}`, '{}');
    }
    store.set('metrics:success:2026-11-24', '12345');
    store.set('subrate:203.0.113.90:123', '9');
    return {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
      async list({ cursor, limit = 1000 } = {}) {
        const names = [...store.keys()];
        const start = Number(cursor || 0);
        const keys = names.slice(start, start + limit).map((name) => ({ name }));
        const next = start + limit;
        return { keys, list_complete: next >= names.length, cursor: String(next) };
      },
      store,
    };
  };
  const send = (kv, ip) => onSubscribePost({
    request: new Request(`${ORIGIN}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
      body: JSON.stringify(SUBSCRIPTION),
    }),
    env: { PUSH_KV: kv },
  });

  // 999件 + 今回の1件 = 上限の1000件までは許可される。
  const below = makeKv(999);
  assert.equal((await send(below, '203.0.113.91')).status, 200);

  // 1000件すでにある場合は新規購読を拒否する。
  const full = makeKv(1000);
  const limited = await send(full, '203.0.113.92');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'RATE_LIMIT_EXCEEDED');

  // metrics:* / subrate:* は件数に数えない。999件 + これら2件でも許可される。
  const withExcluded = makeKv(999);
  assert.equal((await send(withExcluded, '203.0.113.93')).status, 200);
});

test('subscribe persists the scanned total so later requests skip the full scan', async () => {
  const subscription = {
    subscription: { endpoint: 'https://example.test/persisted', keys: { p256dh: 'AAA', auth: 'BBB' } },
    nextExpiry: null,
  };
  const store = new Map();
  for (let i = 0; i < 12; i += 1) store.set(`https://example.test/sub-${i}`, '{}');
  let listCalls = 0;
  const kv = {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async list({ cursor, limit = 1000 } = {}) {
      listCalls += 1;
      const names = [...store.keys()];
      const start = Number(cursor || 0);
      return {
        keys: names.slice(start, start + limit).map((name) => ({ name })),
        list_complete: start + limit >= names.length,
        cursor: String(start + limit),
      };
    },
  };
  const send = (endpoint, ip) => onSubscribePost({
    request: new Request(`${ORIGIN}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
      body: JSON.stringify({ ...subscription, subscription: { ...subscription.subscription, endpoint } }),
    }),
    env: { PUSH_KV: kv },
  });

  const first = await send('https://example.test/new-1', '203.0.113.94');
  assert.equal(first.status, 200);
  assert.equal(store.get('subcount:total'), '13', '走査した件数が保存されること');
  assert.ok(listCalls > 0, '初回は走査が発生すること');

  const callsAfterFirst = listCalls;
  const second = await send('https://example.test/new-2', '203.0.113.95');
  assert.equal(second.status, 200);
  assert.equal(listCalls, callsAfterFirst, '2回目は KV 全走査をしないこと');
});

test('rejects requests from a different origin', async () => {
  const response = await onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE }, { origin: 'https://evil.example' }),
    env: {},
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
});

test('uses PUBLIC_ORIGIN override instead of the request URL origin', async () => {
  const request = new Request('https://spoofed.example/api/analyze', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: VALID_IMAGE }),
  });
  const allowed = await onRequestPost({ request, env: { PUBLIC_ORIGIN: ORIGIN } });
  assert.notEqual(allowed.status, 403);

  const denied = await onRequestPost({ request, env: { PUBLIC_ORIGIN: 'https://expected.example' } });
  assert.equal(denied.status, 403);
});

test('rejects requests without an Origin or with a non-JSON content type', async () => {
  const noOrigin = new Request(`${ORIGIN}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: VALID_IMAGE }),
  });
  assert.equal((await onRequestPost({ request: noOrigin, env: {} })).status, 403);

  const wrongType = new Request(`${ORIGIN}/api/analyze`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ imageBase64: VALID_IMAGE }),
  });
  assert.equal((await onRequestPost({ request: wrongType, env: {} })).status, 415);
});

test('BYOK requests cannot bypass the shared-key rate limit', async (t) => {
  withMockFetch(t, async () => aiResponse([{ name: '牛乳', storage: 'fridge', expiryDate: '2026-11-29', quantity: '1本' }]));
  const store = new Map();
  const env = {
    GEMINI_API_KEY: 'shared-key',
    RATE_LIMIT_KV: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  let last;
  // BYOK 枠は 30/分。共有キー枠（5/分）をすり抜けても無制限ではないことを確認する。
  const send = () => onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE, customApiKey: 'x' }, { ip: '203.0.113.99' }),
    env,
  });
  for (let i = 0; i < 29; i += 1) {
    last = await send();
    assert.equal(last.status, 200, `BYOK ${i + 1}回目は許可されるべき`);
  }
  last = await send();
  assert.equal(last.status, 200, 'BYOK 30回目はギリギリ許可されるべき');
  last = await send();
  assert.equal(last.status, 429, 'BYOK 31回目は制限されるべき');
  assert.equal((await last.json()).error.code, 'RATE_LIMIT_EXCEEDED');
});

test('accepts declared PNG, JPEG, and WebP magic bytes', async (t) => {
  withMockFetch(t, async () => aiResponse([{ name: '牛乳', storage: 'fridge', expiryDate: '2026-11-29', quantity: '1本' }]));
  const cases = [
    { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff, 0xe0] },
    {
      mimeType: 'image/webp',
      bytes: [...Buffer.from('RIFF'), 0x00, 0x00, 0x00, 0x00, ...Buffer.from('WEBP')],
    },
  ];
  for (const [index, { mimeType, bytes }] of cases.entries()) {
    const response = await onRequestPost({
      request: makeRequest({ imageBase64: Buffer.from(bytes).toString('base64'), mimeType }, { ip: `203.0.113.5${index}` }),
      env: { GEMINI_API_KEY: 'shared-key' },
    });
    assert.equal(response.status, 200, `${mimeType} の宣言一致データは受理されるべき`);
  }
});

test('rejects image data whose magic bytes disagree with the declared MIME type', async () => {
  const cases = [
    { declared: 'image/jpeg', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { declared: 'image/png', bytes: [0xff, 0xd8, 0xff, 0xe0] },
    {
      declared: 'image/png',
      bytes: [...Buffer.from('RIFF'), 0x00, 0x00, 0x00, 0x00, ...Buffer.from('WEBP')],
    },
  ];
  for (const [index, { declared, bytes }] of cases.entries()) {
    const response = await onRequestPost({
      request: makeRequest({ imageBase64: Buffer.from(bytes).toString('base64'), mimeType: declared }, { ip: `203.0.113.6${index}` }),
      env: { GEMINI_API_KEY: 'shared-key' },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_IMAGE');
  }
});

test('unrecognizable image data falls back to the declared MIME type', async (t) => {
  let captured;
  withMockFetch(t, async (url, options) => {
    captured = options;
    return aiResponse([{ name: '牛乳', storage: 'fridge', expiryDate: '2026-11-29', quantity: '1本' }]);
  });
  // VALID_IMAGE ("hello") は既知のシグネチャに一致しない。
  const response = await onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE, mimeType: 'image/webp' }, { ip: '203.0.113.62' }),
    env: { GEMINI_API_KEY: 'shared-key' },
  });
  assert.equal(response.status, 200);
  const sent = JSON.parse(captured.body);
  assert.equal(sent.contents[0].parts[1].inline_data.mime_type, 'image/webp');
});

test('rejects malformed and oversized image data', async () => {
  const malformed = await onRequestPost({
    request: makeRequest({ imageBase64: 'not base64!' }, { ip: '203.0.113.11' }),
    env: { GEMINI_API_KEY: 'dummy' },
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_IMAGE');

  const oversized = await onRequestPost({
    request: makeRequest({ imageBase64: 'A'.repeat(2_800_001) }, { ip: '203.0.113.12' }),
    env: { GEMINI_API_KEY: 'dummy' },
  });
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).error.code, 'INVALID_IMAGE');
});

test('reports a missing shared key', async () => {
  const response = await onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.13' }),
    env: {},
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'API_KEY_NOT_CONFIGURED');
});

test('blocks the sixth shared-key request using the KV counter', async (t) => {
  withMockFetch(t, async () => aiResponse([{ name: '牛乳', storage: 'fridge', expiryDate: '2026-11-29', quantity: '1本' }]));
  const store = new Map();
  const env = {
    GEMINI_API_KEY: 'shared-key',
    RATE_LIMIT_KV: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
    },
  };
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await onRequestPost({
      request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.20' }),
      env,
    });
  }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'RATE_LIMIT_EXCEEDED');
});

test('blocks the sixth shared-key request using the Durable Object counter', async (t) => {
  withMockFetch(t, async () => aiResponse([{ name: '牛乳', storage: 'fridge', expiryDate: '2026-11-29', quantity: '1本' }]));
  const counts = new Map();
  const env = {
    GEMINI_API_KEY: 'shared-key',
    RATE_LIMITER_DO: {
      idFromName: (name) => name,
      get: (id) => ({
        async fetch() {
          const count = (counts.get(id) || 0) + 1;
          counts.set(id, count);
          return new Response(JSON.stringify({ limited: count > 5 }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    },
  };
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await onRequestPost({
      request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.21' }),
      env,
    });
  }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'RATE_LIMIT_EXCEEDED');
});


test('fails closed when rate-limit KV reads or writes fail', async () => {
  for (const rateLimitKV of [
    { async get() { throw new Error('KV read failed'); }, async put() {} },
    { async get() { return null; }, async put() { throw new Error('KV write failed'); } },
  ]) {
    const response = await onRequestPost({
      request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.30' }),
      env: { GEMINI_API_KEY: 'shared-key', RATE_LIMIT_KV: rateLimitKV },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'RATE_LIMIT_UNAVAILABLE');
  }
});

test('sends the key in a header and caps normalized items at 50', async (t) => {
  let captured;
  withMockFetch(t, async (url, options) => {
    captured = { url, options };
    const items = Array.from({ length: 60 }, (_, i) => ({
      name: `食材${i}`, storage: 'unknown', expiryDate: 'bad', quantity: '',
    }));
    return aiResponse(items);
  });

  const response = await onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.40' }),
    env: { GEMINI_API_KEY: 'shared-key' },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(captured.options.headers['x-goog-api-key'], 'shared-key');

  const data = await response.json();
  assert.equal(data.items.length, 50);
  assert.equal(data.items[0].storage, 'pantry');
  assert.equal(data.items[0].expiryDate, '2026-11-29');
});

test('does not leak upstream error details', async (t) => {
  withMockFetch(t, async () => new Response(
    JSON.stringify({ error: { message: 'INTERNAL_SECRET_DETAIL' } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  ));
  const response = await onRequestPost({
    request: makeRequest({ imageBase64: VALID_IMAGE }, { ip: '203.0.113.22' }),
    env: { GEMINI_API_KEY: 'shared-key' },
  });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes('INTERNAL_SECRET_DETAIL'));
});

test('client rejects impossible dates and caps result rows', () => {
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-02-28'), true);
  const result = normalizeAnalysis({
    purchaseDate: 'invalid',
    items: Array.from({ length: 60 }, (_, i) => ({ name: `x${i}`, storage: 'bogus', expiryDate: 'nope' })),
  });
  assert.equal(result.purchaseDate, null);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0].storage, 'pantry');
});
