import { json, readJsonWithLimit, requireSameOriginJson } from '../../shared/http.js';

const MAX_BODY_BYTES = 2048;
const SUB_COUNT_KEY = 'subcount:total';

export async function onRequestPost({ request, env }) {
  const rejected = requireSameOriginJson(request, env?.PUBLIC_ORIGIN);
  if (rejected) return rejected;

  const parsed = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (parsed.invalid) return json({ error: { code: 'INVALID_REQUEST' } }, 400);
  const endpoint = typeof parsed.body?.endpoint === 'string' ? parsed.body.endpoint : '';
  if (!endpoint) return json({ error: { code: 'INVALID_SUBSCRIPTION' } }, 400);

  const kv = env?.PUSH_KV;
  if (!kv || typeof kv.delete !== 'function') return json({ ok: true });
  await kv.delete(endpoint);
  const current = Number(await kv.get(SUB_COUNT_KEY) || 0);
  if (current > 0) await kv.put(SUB_COUNT_KEY, String(current - 1));
  return json({ ok: true });
}
