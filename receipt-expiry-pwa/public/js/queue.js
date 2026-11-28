import { newId } from './ids.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_QUEUE_ATTEMPTS = 3;


/** APIキーは端末設定から再取得するため、キューには保存しない。 */
export function createQueuedAnalysis({ imageBase64, mimeType, clientDate }, { retryAfter = 0 } = {}) {
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    throw new Error('画像データがありません。');
  }
  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  return {
    id: newId('job'),
    imageBase64,
    // imageProcessor.js は WebP 対応ブラウザで image/webp を返す。
    // サーバーは image/png と image/webp を受け付けるので、実データと宣言がずれないよう保持する。
    mimeType: ['image/png', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg',
    clientDate: DATE_PATTERN.test(clientDate || '') ? clientDate : new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    attempts: 0,
    // 429 の Retry-After を保持し、バケット回復まで再試行しない。
    nextAttemptAt: Date.now() + delayMs,
  };
}

export function nextAttempt(job) {
  return { ...job, attempts: (Number(job.attempts) || 0) + 1, nextAttemptAt: 0 };
}

export function shouldDiscard(job) {
  return (Number(job.attempts) || 0) >= MAX_QUEUE_ATTEMPTS;
}
