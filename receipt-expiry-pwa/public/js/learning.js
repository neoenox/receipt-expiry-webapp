const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 表記ゆれを吸収するためのローカル正規化。AIにも送信しない。 */
export function normalizeFoodName(name) {
  if (typeof name !== 'string') return '';
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

export function createExpiryHint(name, expiryDate) {
  const key = normalizeFoodName(name);
  if (!key) throw new Error('食材名がありません。');
  if (!DATE_PATTERN.test(expiryDate || '')) throw new Error('賞味期限が不正です。');
  return { name: key, expiryDate, updatedAt: Date.now() };
}

export function buildHintMap(hints) {
  const map = new Map();
  for (const hint of hints || []) {
    if (!hint || typeof hint.name !== 'string') continue;
    if (!DATE_PATTERN.test(hint.expiryDate || '')) continue;
    map.set(hint.name, hint.expiryDate);
  }
  return map;
}
