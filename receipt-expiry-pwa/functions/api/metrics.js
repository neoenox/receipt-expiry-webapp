import { json, readJsonWithLimit, requireSameOriginJson } from '../shared/http.js';

const MAX_BODY_BYTES = 1024;

export async function onRequestPost({ request, env }) {
  const rejected = requireSameOriginJson(request, env?.PUBLIC_ORIGIN);
  if (rejected) return rejected;

  const parsed = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (parsed.invalid) return json({ error: { code: 'INVALID_REQUEST' } }, 400);

  const kind = parsed.body?.kind === 'error' ? 'error' : 'success';
  // count は受け付けるが無視する。呼び出し側の値に関わらず 1 リクエスト = 1 加算。
  const increment = 1;
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
