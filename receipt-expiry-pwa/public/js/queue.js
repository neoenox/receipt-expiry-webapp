const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_QUEUE_ATTEMPTS = 3;

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** APIキーは端末設定から再取得するため、キューには保存しない。 */
export function createQueuedAnalysis({ imageBase64, mimeType, clientDate }) {
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    throw new Error('画像データがありません。');
  }
  return {
    id: newId(),
    imageBase64,
    mimeType: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
    clientDate: DATE_PATTERN.test(clientDate || '') ? clientDate : new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    attempts: 0,
  };
}

export function nextAttempt(job) {
  return { ...job, attempts: (Number(job.attempts) || 0) + 1 };
}

export function shouldDiscard(job) {
  return (Number(job.attempts) || 0) >= MAX_QUEUE_ATTEMPTS;
}
