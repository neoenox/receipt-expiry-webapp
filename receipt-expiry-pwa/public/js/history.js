import { newId } from './ids.js';
import { CONSUMPTION_REASONS } from './domain.js';

const REASONS = new Set(CONSUMPTION_REASONS);


export function createConsumption(item, reason) {
  if (!REASONS.has(reason)) throw new Error('記録の種別が不正です。');
  if (!item || typeof item.name !== 'string') throw new Error('食材情報が不正です。');
  return {
    id: newId('history'),
    name: item.name,
    storage: item.storage || 'pantry',
    expiryDate: item.expiryDate || '',
    quantity: item.quantity || '',
    reason,
    consumedAt: Date.now(),
  };
}

/** 今月の件数を集計する。日付はローカルタイムゾーンの「今月」で判定。 */
export function summarizeHistory(entries, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const result = { eaten: 0, discarded: 0, total: 0 };
  for (const entry of entries || []) {
    const at = new Date(entry?.consumedAt);
    if (at.getFullYear() !== year || at.getMonth() !== month) continue;
    if (!REASONS.has(entry.reason)) continue;
    result[entry.reason] += 1;
    result.total += 1;
  }
  return result;
}
