import { isValidDate } from './dates.js';
const FORMAT = 'receipt-expiry-backup';
const VERSION = 3;
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);
const VALID_REASONS = new Set(['eaten', 'discarded']);

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
function normalizeShopping(raw, index) {
  const label = `買い物${index + 1}行目`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`バックアップの${label}が不正です。`);
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`バックアップの${label}にIDがありません。`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`バックアップの${label}に食材名がありません。`);
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) throw new Error(`バックアップの${label}の登録日時が不正です。`);
  if (raw.storage != null && !VALID_STORAGE.has(raw.storage)) throw new Error(`バックアップの${label}の保存場所が不正です。`);
  if (raw.expiryDate != null && !isValidDate(raw.expiryDate)) throw new Error(`バックアップの${label}の賞味期限が不正です。`);
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, 80),
    storage: VALID_STORAGE.has(raw.storage) ? raw.storage : '',
    expiryDate: isValidDate(raw.expiryDate) ? raw.expiryDate : '',
    createdAt: raw.createdAt,
  };
}

function normalizeSettings(raw) {
  const source = raw || {};
  const theme = ['auto', 'light', 'dark'].includes(source.theme) ? source.theme : 'auto';
  const hour = Number.isFinite(source.notifyHour) ? Math.max(0, Math.min(23, Math.round(source.notifyHour))) : 6;
  return { theme, notifyHour: hour, notifyEnabled: Boolean(source.notifyEnabled) };
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

    shopping: (source.shopping || []).map(normalizeShopping),
    settings: normalizeSettings(source.settings),
  }, null, 2);
}

export const LAST_BACKUP_KEY = 'receipt-expiry-last-backup';
export const BACKUP_REMINDER_DAYS = 7;

/** ISO 日時文字列として妥当ならそのまま返す。不正なら null。 */
export function normalizeLastBackup(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * 最終バックアップが古いかどうか。未記録・不正な値は安全側（古い）として扱う。
 */
export function isBackupStale(lastBackup, now = new Date(), days = BACKUP_REMINDER_DAYS) {
  const normalized = normalizeLastBackup(lastBackup);
  if (!normalized) return true;
  const elapsed = now.getTime() - Date.parse(normalized);
  return elapsed >= days * 86_400_000;
}

/** 表示用の日付（YYYY-MM-DD）。不正なら null。 */
export function formatLastBackupDate(lastBackup) {
  const normalized = normalizeLastBackup(lastBackup);
  return normalized ? normalized.slice(0, 10) : null;
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
  const shopping = (data.shopping || []).map(normalizeShopping);
  const settings = normalizeSettings(data.settings);
  return {
    items: mergeByKey(items, (item) => item.id),
    history: mergeByKey(history, (entry) => entry.id),
    hints: mergeByKey(hints, (hint) => hint.name),
    shopping: mergeByKey(shopping, (entry) => entry.id),
    settings,
  };
}
