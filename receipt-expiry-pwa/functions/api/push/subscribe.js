const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

  const nextExpiry = DATE_PATTERN.test(body.nextExpiry || '') ? body.nextExpiry : null;
  const daysUntil = Number.isFinite(body.daysUntil) ? Math.max(-365, Math.min(365, Math.round(body.daysUntil))) : null;
  const entry = {
    subscription: { endpoint, keys: { p256dh, auth } },
    nextExpiry,
    daysUntil,
    updatedAt: Date.now(),
  };
  try {
    await env.PUSH_KV.put(endpoint, JSON.stringify(entry));
  } catch {
    return json({ error: { code: 'STORE_UNAVAILABLE' } }, 503);
  }
  return json({ ok: true });
}
