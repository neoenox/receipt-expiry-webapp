import { retryDelayMs } from './features2.js';

/** 複数画像を順番に解析し、結果を1つにまとめる。DOMには触れない。 */
export async function analyzePayloads(payloads, { analyzeReceipt, getApiKey, onMetric, onError } = {}) {
  const items = [];
  let purchaseDate = null;
  let errors = 0;

  for (const payload of payloads || []) {
    let result;
    const options = { ...payload, customApiKey: getApiKey?.() || undefined };
    try {
      result = await analyzeReceipt(options);
    } catch (error) {
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

    if (result) {
      onMetric?.('success');
      if (!purchaseDate && result.purchaseDate) purchaseDate = result.purchaseDate;
      items.push(...(result.items || []));
    } else {
      onMetric?.('error');
    }
  }

  return { items, purchaseDate, errors };
}
