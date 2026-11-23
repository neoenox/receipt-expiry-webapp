import { json, readJsonWithLimit, requireSameOriginJson } from '../shared/http.js';

const MAX_BODY_BYTES = 1024;

export async function onRequestPost({ request, env }) {
  const rejected = requireSameOriginJson(request, env?.PUBLIC_ORIGIN);
  if (rejected) return rejected;

  const parsed = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (parsed.invalid) return json({ error: { code: 'INVALID_REQUEST' } }, 400);

  const kind = parsed.body?.kind === 'error' ? 'error' : 'success';
  const increment = Math.min(100, Math.max(1, Math.round(Number(parsed.body?.count) || 1)));
  const kv = env?.PUSH_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return json({ ok: true });

  try {
    const key = `metrics:${kind}:${new Date().toISOString().slice(0, 10)}`;
    const count = Number(await kv.get(key)) + increment;
    await kv.put(key, String(count), { expirationTtl: 30 * 86_400 });
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
