/** UUID v4。非対応環境では用途が分かるプレフィックス付きのIDへフォールバックする。 */
export function newId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
