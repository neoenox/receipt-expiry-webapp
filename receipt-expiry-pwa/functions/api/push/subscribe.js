import { isSubscriptionRateLimited } from '../../public/js/features2.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RATE_WINDOW_SECONDS = 3600;
const MAX_PER_HOUR = 10;
const MAX_TOTAL = 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || 'unknown';
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: 'INVALID_REQUEST' } }, 400);
  }

  const subscription = body?.subscription;
  const endpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint : '';
  const p256dh = typeof subscription?.keys?.p256dh === 'string' ? subscription.keys.p256dh : '';
  const auth = typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth : '';
  if (!endpoint || endpoint.length > 1000 || !p256dh || !auth) {
    return json({ error: { code: 'INVALID_SUBSCRIPTION' } }, 400);
  }

  const kv = env?.PUSH_KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const ip = clientIp(request);
      const window = Math.floor(Date.now() / 3_600_000);
      const rateKey = `subrate:${ip}:${window}`;
      const count = Number(await kv.get(rateKey)) + 1;
      const listing = await kv.list({ limit: MAX_TOTAL + 1 });
      if (isSubscriptionRateLimited(count, listing.keys.length, MAX_PER_HOUR, MAX_TOTAL)) {
        return json({ error: { code: 'RATE_LIMIT_EXCEEDED' } }, 429);
      }
      await kv.put(rateKey, String(count), { expirationTtl: RATE_WINDOW_SECONDS });
    } catch {
      return json({ error: { code: 'STORE_UNAVAILABLE' } }, 503);
    }
  }

  const nextExpiry = DATE_PATTERN.test(body.nextExpiry || '') ? body.nextExpiry : null;
  const daysUntil = Number.isFinite(body.daysUntil) ? Math.max(-365, Math.min(365, Math.round(body.daysUntil))) : null;
  const notifyHour = Number.isFinite(body.notifyHour) ? Math.max(0, Math.min(23, Math.round(body.notifyHour))) : 6;
  const entry = {
    subscription: { endpoint, keys: { p256dh, auth } },
    nextExpiry,
    daysUntil,
    notifyHour,
    updatedAt: Date.now(),
  };
  if (!kv) return json({ ok: true });

  try {
    await kv.put(endpoint, JSON.stringify(entry));
  } catch {
    return json({ error: { code: 'STORE_UNAVAILABLE' } }, 503);
  }
  return json({ ok: true });
}
