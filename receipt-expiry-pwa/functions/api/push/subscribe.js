import { clientIp, json, readJsonWithLimit, requireSameOriginJson } from '../../shared/http.js';
import { SUBSCRIPTION_RATE, isSubscriptionRateLimited } from '../../shared/limits.js';
import { jstDate } from '../../shared/schedule.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY_BYTES = 4096;
const SUB_COUNT_KEY = 'subcount:total';


function validEndpoint(endpoint) {
  if (!endpoint || endpoint.length > 1000) return false;
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validDates(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((date) => DATE_PATTERN.test(date || '')))].sort().slice(0, 20)
    : [];
}

function validNotifiedDates(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((date) => DATE_PATTERN.test(date || '')))].sort().slice(-20)
    : [];
}

function parseStoredEntry(raw) {
  if (!raw) return {};
  try {
    const entry = JSON.parse(raw);
    return entry && typeof entry === 'object' ? entry : {};
  } catch {
    return {};
  }
}

function daysUntilDate(date, today) {
  return date ? Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000) : null;
}

export async function onRequestPost({ request, env }) {
  const rejected = requireSameOriginJson(request, env?.PUBLIC_ORIGIN);
  if (rejected) return rejected;

  const parsed = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (parsed.invalid) return json({ error: { code: 'INVALID_REQUEST' } }, 400);
  const body = parsed.body;

  const subscription = body?.subscription;
  const endpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint : '';
  const p256dh = typeof subscription?.keys?.p256dh === 'string' ? subscription.keys.p256dh : '';
  const auth = typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth : '';
  if (!validEndpoint(endpoint) || !p256dh || !auth) {
    return json({ error: { code: 'INVALID_SUBSCRIPTION' } }, 400);
  }

  const kv = env?.PUSH_KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const ip = clientIp(request);
      const window = Math.floor(Date.now() / 3_600_000);
      const rateKey = `subrate:${ip}:${window}`;
      const [rateRaw, totalRaw] = await Promise.all([
        kv.get(rateKey),
        kv.get(SUB_COUNT_KEY),
      ]);
      // 初回は既存キーを数えてカウンタを初期化する（metrics:* は除外）。
      let total = Number(totalRaw || 0);
      if (!totalRaw) {
        let cursor;
        do {
          const page = await kv.list({ cursor, limit: 1000 });
          total += page.keys.filter((key) => !key.name.startsWith('metrics:')
            && !key.name.startsWith('subrate:')
            && key.name !== SUB_COUNT_KEY).length;
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        // 走査結果を永続化し、total キーが消えた状態での毎回のフル走査を防ぐ。
        // TTL は付けない (付けるとまた期限切れで走査が復活する)。
        await kv.put(SUB_COUNT_KEY, String(total));
      }
      const count = Number(rateRaw || 0) + 1;
      if (isSubscriptionRateLimited(count, total)) {
        return json({ error: { code: 'RATE_LIMIT_EXCEEDED' } }, 429);
      }
      await kv.put(rateKey, String(count), { expirationTtl: SUBSCRIPTION_RATE.windowSeconds });
    } catch {
      return json({ error: { code: 'STORE_UNAVAILABLE' } }, 503);
    }
  }

  const requestedExpiry = DATE_PATTERN.test(body.nextExpiry || '') ? body.nextExpiry : null;
  const expiryDates = validDates(body.expiryDates);
  const daysUntil = Number.isFinite(body.daysUntil) ? Math.max(-365, Math.min(365, Math.round(body.daysUntil))) : null;
  const notifyHour = Number.isFinite(body.notifyHour) ? Math.max(0, Math.min(23, Math.round(body.notifyHour))) : 6;
  if (!kv) return json({ ok: true });

  try {
    const existingRaw = await kv.get(endpoint);
    const previous = parseStoredEntry(existingRaw);
    const today = jstDate(new Date());
    const notified = new Set(validNotifiedDates(previous.notifiedExpiryDates));
    const previousExpiryDates = validDates(previous.expiryDates);

    // Legacy records stored notifiedAt but not the expiry date. When the
    // client re-registers an expiry that was already in the old date list
    // after the worker advanced/cleared nextExpiry, retain that notification.
    const legacyNotified = Boolean(
      previous.notifiedAt
      && requestedExpiry
      && previous.nextExpiry !== requestedExpiry
      && previousExpiryDates.includes(requestedExpiry)
    );
    if (legacyNotified) notified.add(requestedExpiry);

    const dates = validDates([...expiryDates, requestedExpiry].filter(Boolean));
    const nextExpiry = requestedExpiry && !notified.has(requestedExpiry)
      ? requestedExpiry
      : dates.filter((date) => date >= today && !notified.has(date)).sort()[0] || null;
    const entry = {
      subscription: { endpoint, keys: { p256dh, auth } },
      nextExpiry,
      expiryDates: dates,
      daysUntil: nextExpiry ? daysUntilDate(nextExpiry, today) : null,
      notifyHour,
      notifiedExpiryDates: [...notified].sort().slice(-20),
      ...(previous.notifiedAt ? { notifiedAt: previous.notifiedAt } : {}),
      updatedAt: Date.now(),
    };

    await kv.put(endpoint, JSON.stringify(entry));
    if (!existingRaw) {
      const total = Number(await kv.get(SUB_COUNT_KEY) || 0) + 1;
      await kv.put(SUB_COUNT_KEY, String(total));
    }
  } catch {
    return json({ error: { code: 'STORE_UNAVAILABLE' } }, 503);
  }
  return json({ ok: true });
}
