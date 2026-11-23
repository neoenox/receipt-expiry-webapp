import { setVapidDetails, sendNotification } from 'web-push';
import { buildReminderBody, sendReminders } from '../functions/shared/reminder.js';

export { buildReminderBody };

async function sendScheduledReminders(env) {
  setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:admin@localhost',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  await sendReminders({
    kv: env.PUSH_KV,
    sendNotification,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    now: new Date(),
    listLimit: 1000,
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendScheduledReminders(env));
  },
  async fetch(request) {
    if (request.method === 'GET') return new Response('receipt-expiry-notify: ok');
    return new Response('Method Not Allowed', { status: 405 });
  },
};
