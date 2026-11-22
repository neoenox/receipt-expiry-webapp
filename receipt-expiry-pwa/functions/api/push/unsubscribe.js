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
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return json({ error: { code: 'INVALID_SUBSCRIPTION' } }, 400);

  await env.PUSH_KV.delete(endpoint);
  return json({ ok: true });
}
