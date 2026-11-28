/** リマインダ判定用の時刻ヘルパー。public/ に依存せず Functions 単体で使える。 */

/** JST の日付（YYYY-MM-DD）を返す。 */
export function jstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 通知すべきか。未設定ならデフォルト6時。
 * notifiedDate を渡すと「設定時刻を過ぎていて、その日はまだ通知していない」場合も
 * true を返す（サーバーダウン時の取りこぼしを防ぐ catch-up）。
 */
export function shouldSendAtHour(entry, now = new Date(), notifiedDate) {
  const hour = Number.isFinite(entry?.notifyHour) ? Math.max(0, Math.min(23, entry.notifyHour)) : 6;
  const jstHour = (now.getUTCHours() + 9) % 24;
  const today = jstDate(now);
  // 同じ日・同じ設定時刻にCronが再実行されても二重通知しない。
  if (jstHour === hour) return notifiedDate !== today;
  if (notifiedDate === undefined) return false;
  // 設定時刻を過ぎていて、今日まだ通知していなければ送る。
  return jstHour > hour && notifiedDate !== today;
}
