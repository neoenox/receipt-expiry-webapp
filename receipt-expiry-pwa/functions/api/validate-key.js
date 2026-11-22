const TIMEOUT_MS = 10_000;

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

export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: 'INVALID_REQUEST' } }, 400);
  }
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim().slice(0, 256) : '';
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
