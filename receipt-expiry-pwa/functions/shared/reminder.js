import { jstDate, shouldSendAtHour } from '../../public/js/features2.js';

export const REMINDER_TITLE = 'レシート賞味期限';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REMINDER_BODY = 'まもなく賞味期限の食材があります。アプリを開いて確認してください。';
const REMINDER_SUFFIX = 'アプリを開いて確認してください。';

function validExpiryDates(entry) {
  return Array.isArray(entry?.expiryDates)
    ? [...new Set(entry.expiryDates.filter((date) => DATE_PATTERN.test(date || '')))].sort()
    : [];
}

function notifiedExpirySet(entry) {
  return new Set(
    Array.isArray(entry?.notifiedExpiryDates)
      ? entry.notifiedExpiryDates.filter((date) => DATE_PATTERN.test(date || ''))
      : []
  );
}

function daysUntilDate(date, today) {
  return date ? Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000) : null;
}

function nextUnnotifiedExpiry(dates, today, notified) {
  return dates.filter((date) => date > today && !notified.has(date)).sort()[0] || null;
}

export function buildReminderBody(daysUntil) {
  if (!Number.isFinite(daysUntil)) return REMINDER_BODY;
  const days = Math.round(daysUntil);
  if (days <= 0) return `本日が賞味期限の食材があります。${REMINDER_SUFFIX}`;
  if (days === 1) return `明日が賞味期限の食材があります。${REMINDER_SUFFIX}`;
  return `最も近い賞味期限まであと${days}日です。${REMINDER_SUFFIX}`;
}

/**
 * KV 上の購読を走査して期限リマインダを送る。
 * OCI と Cloudflare Worker の両方から呼べるよう、KV と Web Push 送信関数を
 * 引数で受け取る（副作用をこのモジュールに閉じ込めない）。
 */
export async function sendReminders({ kv, sendNotification, vapid, now = new Date(), listLimit = 200 }) {
  const { publicKey, privateKey } = vapid || {};
  if (!publicKey || !privateKey) return 0;

  const today = jstDate(now);
  let cursor;
  let sent = 0;
  do {
    const page = await kv.list({ cursor, limit: listLimit });
    for (const { name } of page.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry?.subscription?.endpoint || !entry.nextExpiry) continue;

      const expiryDates = validExpiryDates(entry);
      const notified = notifiedExpirySet(entry);
      // A stale client can re-register an expiry that the worker already sent.
      // Advance it without sending again, preserving the per-expiry ledger.
      if (notified.has(entry.nextExpiry)) {
        const next = nextUnnotifiedExpiry(expiryDates, today, notified);
        await kv.put(name, JSON.stringify({
          ...entry,
          nextExpiry: next,
          daysUntil: daysUntilDate(next, today),
        }));
        continue;
      }
      if (entry.nextExpiry > today) continue;

      const notifiedDate = entry.notifiedAt ? jstDate(new Date(entry.notifiedAt)) : null;
      if (!shouldSendAtHour(entry, now, notifiedDate)) continue;

      try {
        await sendNotification(
          entry.subscription,
          JSON.stringify({ title: REMINDER_TITLE, body: buildReminderBody(entry.daysUntil), url: '/' })
        );
        notified.add(entry.nextExpiry);
        const next = nextUnnotifiedExpiry(expiryDates, today, notified);
        await kv.put(name, JSON.stringify({
          ...entry,
          nextExpiry: next,
          daysUntil: daysUntilDate(next, today),
          notifiedExpiryDates: [...notified].sort().slice(-20),
          notifiedAt: Date.now(),
        }));
        sent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await kv.delete(name);
          const current = Number(await kv.get('subcount:total') || 0);
          if (current > 0) await kv.put('subcount:total', String(current - 1));
        } else {
          console.error('[notify]', name, error.message);
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}
