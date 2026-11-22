const FORMAT = 'receipt-expiry-backup';
const VERSION = 2;
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);
const VALID_REASONS = new Set(['eaten', 'discarded']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeItem(raw, index) {
  const label = `在庫${index + 1}行目`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`バックアップの${label}が不正です。`);
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`バックアップの${label}にIDがありません。`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`バックアップの${label}に食材名がありません。`);
  if (!VALID_STORAGE.has(raw.storage)) throw new Error(`バックアップの${label}の保存場所が不正です。`);
  if (!isValidDate(raw.expiryDate)) throw new Error(`バックアップの${label}の賞味期限が不正です。`);
  if (raw.purchaseDate != null && !isValidDate(raw.purchaseDate)) throw new Error(`バックアップの${label}の購入日が不正です。`);
  if (raw.quantity != null && typeof raw.quantity !== 'string') throw new Error(`バックアップの${label}の数量が不正です。`);
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) throw new Error(`バックアップの${label}の登録日時が不正です。`);
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

function normalizeHistory(raw, index) {
  const label = `履歴${index + 1}行目`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`バックアップの${label}が不正です。`);
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`バックアップの${label}にIDがありません。`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`バックアップの${label}に食材名がありません。`);
  if (!VALID_REASONS.has(raw.reason)) throw new Error(`バックアップの${label}の種別が不正です。`);
  if (typeof raw.consumedAt !== 'number' || !Number.isFinite(raw.consumedAt)) throw new Error(`バックアップの${label}の記録日時が不正です。`);
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, 80),
    storage: VALID_STORAGE.has(raw.storage) ? raw.storage : 'pantry',
    expiryDate: isValidDate(raw.expiryDate) ? raw.expiryDate : '',
    quantity: typeof raw.quantity === 'string' ? raw.quantity.trim().slice(0, 40) : '',
    reason: raw.reason,
    consumedAt: raw.consumedAt,
  };
}

function normalizeHint(raw, index) {
  const label = `学習値${index + 1}行目`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`バックアップの${label}が不正です。`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`バックアップの${label}に食材名がありません。`);
  if (!isValidDate(raw.expiryDate)) throw new Error(`バックアップの${label}の賞味期限が不正です。`);
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) throw new Error(`バックアップの${label}の更新日時が不正です。`);
  return { name: raw.name.trim().slice(0, 80), expiryDate: raw.expiryDate, updatedAt: raw.updatedAt };
}

function mergeByKey(items, keyOf) {
  const map = new Map();
  for (const item of items) map.set(keyOf(item), item);
  return Array.from(map.values());
}

export function serializeBackup(data) {
  const source = Array.isArray(data) ? { items: data } : (data || {});
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    items: (source.items || []).map(normalizeItem),
    history: (source.history || []).map(normalizeHistory),
    hints: (source.hints || []).map(normalizeHint),
  }, null, 2);
}

/** 形式・必須項目を検証し、キー重複は後勝ちでマージしたデータを返す。 */
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

  const items = (data.items || []).map(normalizeItem);
  const history = (data.history || []).map(normalizeHistory);
  const hints = (data.hints || []).map(normalizeHint);
  return {
    items: mergeByKey(items, (item) => item.id),
    history: mergeByKey(history, (entry) => entry.id),
    hints: mergeByKey(hints, (hint) => hint.name),
  };
}
