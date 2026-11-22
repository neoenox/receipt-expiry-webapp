const ENDPOINT = '/api/analyze';
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);
const MAX_ITEMS = 50;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** /api/analyze へ画像を送信し、検証済みの解析結果を返す。 */
export async function analyzeReceipt({ imageBase64, mimeType, clientDate, customApiKey }) {
  const payload = { imageBase64, mimeType, clientDate };
  if (customApiKey) payload.customApiKey = customApiKey;

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('サーバーに接続できませんでした。通信環境を確認してください。');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('解析結果を読み取れませんでした。しばらくして再度お試しください。');
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || `解析に失敗しました（${response.status}）`);
  }
  return normalizeAnalysis(data);
}

/** AI応答の型・値を画面で安全に扱える形へ整える。 */
export function normalizeAnalysis(data) {
  const items = [];
  const rawItems = Array.isArray(data?.items) ? data.items : [];

  for (const raw of rawItems) {
    if (items.length >= MAX_ITEMS) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    if (!name) continue;
    items.push({
      name,
      storage: VALID_STORAGE.has(raw.storage) ? raw.storage : 'pantry',
      expiryDate: isValidDate(raw.expiryDate) ? raw.expiryDate : '',
      quantity: typeof raw.quantity === 'string' ? raw.quantity.trim().slice(0, 40) : '',
    });
  }

  return {
    purchaseDate: isValidDate(data?.purchaseDate) ? data.purchaseDate : null,
    items,
  };
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
