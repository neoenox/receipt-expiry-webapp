/** レート制限ポリシーの唯一の情報源。ランタイムごとの実装はこの値だけを参照する。 */

export const ANALYSIS_RATE = Object.freeze({
  shared: Object.freeze({ perMinute: 5, perDay: 20 }),
  // BYOK はユーザー自身の枠だが、共有キーへのバイパスを防ぐため最低限残す。
  byok: Object.freeze({ perMinute: 30, perDay: 200 }),
});

export const SUBSCRIPTION_RATE = Object.freeze({
  perHour: 10,
  total: 1000,
  windowSeconds: 3600,
});

export const VALIDATE_RATE_PER_MINUTE = 10;

/** 解析リクエストの分/日上限を返す。 */
export function analysisLimits(byok) {
  const limits = byok ? ANALYSIS_RATE.byok : ANALYSIS_RATE.shared;
  return { minuteLimit: limits.perMinute, dayLimit: limits.perDay };
}

/** 購読登録が上限を超えたか。 */
export function isSubscriptionRateLimited(count, total) {
  return (Number(count) || 0) > SUBSCRIPTION_RATE.perHour
    || (Number(total) || 0) >= SUBSCRIPTION_RATE.total;
}
