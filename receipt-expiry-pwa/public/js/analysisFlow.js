import { retryDelayMs } from './features2.js';

/**
 * 複数画像を順番に解析し、結果を1つにまとめる。DOMには触れない。
 * 各 payload の成否を results に残すため、呼び出し側は失敗分だけキューへ戻せる。
 * 429 はレート制限バケットが回復するまで待つ必要があるため、ここでは再試行せず
 * retryAfter を添えて呼び出し側へ返す（キュー側で nextAttemptAt を設定する）。
 */
export async function analyzePayloads(payloads, { analyzeReceipt, getApiKey, onMetric, onError } = {}) {
  const items = [];
  const results = [];
  let purchaseDate = null;
  let errors = 0;

  for (const payload of payloads || []) {
    let result;
    let retryAfter = 0;
    const options = { ...payload, customApiKey: getApiKey?.() || undefined };
    try {
      result = await analyzeReceipt(options);
    } catch (error) {
      if (error?.status === 429) {
        retryAfter = Number(error.retryAfter) || 60;
        errors += 1;
        onError?.(error);
      } else {
        const delay = retryDelayMs(error?.status, error?.retryAfter);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          try {
            result = await analyzeReceipt(options);
          } catch (retryError) {
            errors += 1;
            onError?.(retryError);
          }
        } else {
          errors += 1;
          onError?.(error);
        }
      }
    }

    if (result) {
      onMetric?.('success');
      if (!purchaseDate && result.purchaseDate) purchaseDate = result.purchaseDate;
      items.push(...(result.items || []));
      results.push({ payload, ok: true, result });
    } else {
      onMetric?.('error');
      results.push({ payload, ok: false, retryAfter });
    }
  }

  return { items, purchaseDate, errors, results };
}
