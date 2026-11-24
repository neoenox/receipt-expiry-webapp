import { sendReminders } from './shared/reminder.js';
import { sendNotification } from './shared/webpush.js';

/**
 * Cloudflare Cron から呼ばれるリマインダ送信ハンドラ。
 * 認証情報は secret (VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY) から読み、
 * PUSH_KV は wrangler.notify.toml のバインディングを使う。
 */
export async function scheduled(event, env, ctx) {
  const publicKey = env.VAPID_PUBLIC_KEY || '';
  const privateKey = env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) {
    console.warn('[notify] VAPID keys are not configured; reminders skipped');
    return;
  }

  const subject = env.VAPID_SUBJECT || 'mailto:admin@localhost';
  let sent;
  try {
    sent = await sendReminders({
      kv: env.PUSH_KV,
      sendNotification: (subscription, payload) => sendNotification(subscription, payload, {
        publicKey,
        privateKey,
        subject,
      }),
      vapid: { publicKey, privateKey },
      now: new Date(event.scheduledTime),
      listLimit: 200,
    });
  } catch (error) {
    console.error('[notify]', error?.message || error);
    return;
  }

  if (sent === 0) {
    // 設定フラグだけ有効で購読が無い場合など。ユーザー特定情報は残さない。
    console.log('[notify] no eligible subscriptions');
    return;
  }
  console.log(`[notify] sent ${sent} reminder(s)`);
}
