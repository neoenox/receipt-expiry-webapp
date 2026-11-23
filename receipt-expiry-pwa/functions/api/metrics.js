function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (origin !== new URL(request.url).origin) return json({ error: { code: 'FORBIDDEN' } }, 403);
    } catch {
      return json({ error: { code: 'INVALID_REQUEST' } }, 400);
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: 'INVALID_REQUEST' } }, 400);
  }
  const kind = body?.kind === 'error' ? 'error' : 'success';
  const kv = env?.PUSH_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return json({ ok: true });

  try {
    const key = `metrics:${kind}:${new Date().toISOString().slice(0, 10)}`;
    const count = Number(await kv.get(key)) + 1;
    await kv.put(key, String(count), { expirationTtl: 30 * 86_400 });
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
