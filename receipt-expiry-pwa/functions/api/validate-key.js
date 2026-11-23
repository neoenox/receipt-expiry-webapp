import { clientIp, errorResponse, json, readJsonWithLimit, requireSameOriginJson } from '../shared/http.js';

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4096;
const RATE_PER_MINUTE = 10;
const localBuckets = new Map();

async function isRateLimited(request, env) {
  const ip = `validate:${clientIp(request)}`;
  const now = Date.now();
  const kv = env?.RATE_LIMIT_KV;
  const key = `validate-rl:${ip}:${Math.floor(now / 60_000)}`;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const count = Number(await kv.get(key) || 0) + 1;
      await kv.put(key, String(count), { expirationTtl: 60 });
      return count > RATE_PER_MINUTE;
    } catch {
      throw new Error('RATE_LIMIT_STORAGE_UNAVAILABLE');
    }
  }
  const bucket = localBuckets.get(ip) || { count: 0, until: now + 60_000 };
  if (now >= bucket.until) {
    bucket.count = 0;
    bucket.until = now + 60_000;
  }
  bucket.count += 1;
  localBuckets.set(ip, bucket);
  return bucket.count > RATE_PER_MINUTE;
}

export async function onRequestPost({ request, env }) {
  const rejected = requireSameOriginJson(request, env?.PUBLIC_ORIGIN);
  if (rejected) return rejected;

  try {
    if (await isRateLimited(request, env)) {
      return json({ error: { code: 'RATE_LIMIT_EXCEEDED' } }, 429);
    }
  } catch {
    return json({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } }, 503);
  }

  const parsed = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (parsed.tooLarge) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'リクエストが大きすぎます。');
  if (parsed.invalid) return json({ error: { code: 'INVALID_REQUEST' } }, 400);

  const apiKey = typeof parsed.body?.apiKey === 'string' ? parsed.body.apiKey.trim().slice(0, 256) : '';
  if (!apiKey) return json({ error: { code: 'INVALID_KEY' } }, 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }] }),
      }
    );
    if (!response.ok) return json({ error: { code: 'INVALID_KEY' } }, 400);
    return json({ ok: true });
  } catch {
    return json({ error: { code: 'AI_UNAVAILABLE' } }, 502);
  } finally {
    clearTimeout(timer);
  }
}
