const FORMAT = 'receipt-expiry-backup';
const VERSION = 1;
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 既知のフィールドだけを残し、ファイル由来の値を安全な形に整える。 */
function normalizeItem(raw, index) {
  const label = `${index + 1}行目`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`バックアップの${label}が不正です。`);
  }
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`バックアップの${label}にIDがありません。`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`バックアップの${label}に食材名がありません。`);
  if (!VALID_STORAGE.has(raw.storage)) throw new Error(`バックアップの${label}の保存場所が不正です。`);
  if (!isValidDate(raw.expiryDate)) throw new Error(`バックアップの${label}の賞味期限が不正です。`);
  if (raw.purchaseDate != null && !isValidDate(raw.purchaseDate)) {
    throw new Error(`バックアップの${label}の購入日が不正です。`);
  }
  if (raw.quantity != null && typeof raw.quantity !== 'string') {
    throw new Error(`バックアップの${label}の数量が不正です。`);
  }
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) {
    throw new Error(`バックアップの${label}の登録日時が不正です。`);
  }
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, 80),
    storage: raw.storage,
    expiryDate: raw.expiryDate,
    purchaseDate: isValidDate(raw.purchaseDate) ? raw.purchaseDate : null,
    quantity: typeof raw.quantity === 'string' ? raw.quantity.trim().slice(0, 40) : '',
    createdAt: raw.createdAt,
  };
}

export function serializeBackup(items) {
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    items: items.map(normalizeItem),
  }, null, 2);
}

/** JSON文字列を検証し、ID重複を後勝ちでマージした物品配列を返す。 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONファイルを読み取れませんでした。');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('バックアップファイルの形式が正しくありません。');
  }
  if (data.format !== FORMAT) throw new Error('このアプリのバックアップファイルではありません。');

  const byId = new Map();
  data.items.forEach((raw, index) => {
    const item = normalizeItem(raw, index);
    byId.set(item.id, item);
  });
  return Array.from(byId.values());
}
