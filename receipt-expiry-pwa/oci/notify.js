import { setVapidDetails, sendNotification } from 'web-push';
import path from 'node:path';
import { createKvAdapter } from './kv-adapter.js';
import { shouldSendAtHour } from '../public/js/features2.js';
import { buildReminderBody } from '../notify-worker/index.js';

const DATA_DIR = process.env.DATA_DIR || '/var/lib/receipt-expiry';
const KV = createKvAdapter(path.join(DATA_DIR, 'store.json'));

const REMINDER_TITLE = 'レシート賞味期限';

async function sendReminders() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) {
    console.warn('[notify] VAPID keys are not configured; skipping');
    return;
  }
  setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@localhost', publicKey, privateKey);

  const today = new Date().toISOString().slice(0, 10);
  let cursor;
  do {
    const page = await KV.list({ cursor, limit: 200 });
    for (const { name } of page.keys) {
      const raw = await KV.get(name);
      if (!raw) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry?.subscription?.endpoint || !entry.nextExpiry || entry.nextExpiry > today) continue;
      if (!shouldSendAtHour(entry, new Date())) continue;

      try {
        await sendNotification(
          entry.subscription,
          JSON.stringify({ title: REMINDER_TITLE, body: buildReminderBody(entry.daysUntil), url: '/' })
        );
        await KV.put(name, JSON.stringify({ ...entry, nextExpiry: null, notifiedAt: Date.now() }));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await KV.delete(name);
          const current = Number(await KV.get('subcount:total') || 0);
          if (current > 0) await KV.put('subcount:total', String(current - 1));
        } else {
          console.error('[notify]', name, error.message);
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

sendReminders().catch((error) => {
  console.error('[notify]', error);
  process.exitCode = 1;
});
