import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/analyze.js';
import { normalizeAnalysis, isValidDate } from '../public/js/apiClient.js';

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
  for (let i = 0; i < 31; i += 1) {
    last = await onRequestPost({
      request: makeRequest({ imageBase64: VALID_IMAGE, customApiKey: 'x' }, { ip: '203.0.113.99' }),
      env,
    });
  }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'RATE_LIMIT_EXCEEDED');
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
