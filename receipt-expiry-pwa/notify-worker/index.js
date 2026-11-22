import { setVapidDetails, sendNotification } from 'web-push';

const REMINDER_TITLE = 'レシート賞味期限';
const REMINDER_BODY = 'まもなく賞味期限の食材があります。アプリを開いて確認してください。';

async function sendReminders(env) {
  const { keys } = await env.PUSH_KV.list();
  if (!keys.length) return;

  setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:neoenox@gmail.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const today = new Date().toISOString().slice(0, 10);
  for (const { name } of keys) {
    const raw = await env.PUSH_KV.get(name);
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry?.nextExpiry || entry.nextExpiry > today) continue;

    try {
      await sendNotification(
        entry.subscription,
        JSON.stringify({ title: REMINDER_TITLE, body: REMINDER_BODY, url: '/' })
      );
      await env.PUSH_KV.put(name, JSON.stringify({ ...entry, nextExpiry: null, notifiedAt: Date.now() }));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await env.PUSH_KV.delete(name);
      } else {
        console.error('[push]', name, error);
      }
    }
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
  async fetch(request, env) {
    if (request.method === 'GET') return new Response('receipt-expiry-notify: ok');
    return new Response('Method Not Allowed', { status: 405 });
  },
};
