const NAME_KEY = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '');
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);

/** 消費履歴から、現在の在庫にない食材を頻度順に提案する。 */
export function buildShoppingSuggestions(history, items, limit = 8) {
  const inStock = new Set((items || []).map((item) => NAME_KEY(item.name)));
  const counts = new Map();
  for (const entry of history || []) {
    if (entry?.reason !== 'eaten') continue;
    const key = NAME_KEY(entry.name);
    if (!key || inStock.has(key)) continue;
    const current = counts.get(key) || { name: entry.name, count: 0, lastAt: 0, storage: null };
    current.count += 1;
    current.lastAt = Math.max(current.lastAt, Number(entry.consumedAt) || 0);
    if (!current.storage && VALID_STORAGE.has(entry.storage)) current.storage = entry.storage;
    counts.set(key, current);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit);
}

/** 月送りを1回だけ適用し、年またぎを処理する。 */
export function shiftMonth(year, month, direction) {
  let nextYear = year;
  let nextMonth = month + (direction === 'prev' ? -1 : 1);
  if (nextMonth < 0) { nextMonth = 11; nextYear -= 1; }
  if (nextMonth > 11) { nextMonth = 0; nextYear += 1; }
  return { year: nextYear, month: nextMonth };
}

/** 月カレンダーの日付 -> アイテム一覧を作成する。 */
export function buildCalendar(items, year, month) {
  const days = new Map();
  for (const item of items || []) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item?.expiryDate || '');
    if (!match) continue;
    if (Number(match[1]) !== year || Number(match[2]) !== month + 1) continue;
    const day = Number(match[3]);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(item);
  }
  return days;
}

/** トリミング範囲（0〜1）をピクセル矩形へ変換する。 */
export function cropRect(width, height, crop, rotation = 0) {
  const source = rotation % 180 === 0 ? [width, height] : [height, width];
  const left = Math.max(0, Math.min(0.9, Number(crop?.left) || 0)) * source[0];
  const right = Math.max(0, Math.min(0.9, Number(crop?.right) || 0)) * source[0];
  const top = Math.max(0, Math.min(0.9, Number(crop?.top) || 0)) * source[1];
  const bottom = Math.max(0, Math.min(0.9, Number(crop?.bottom) || 0)) * source[1];
  return {
    x: left,
    y: top,
    width: Math.max(1, source[0] - left - right),
    height: Math.max(1, source[1] - top - bottom),
  };
}


/** 429 の Retry-After（秒）を上限付きの待機ミリ秒へ変換する。 */
export function retryDelayMs(status, retryAfter, maxMs = 5000) {
  if (status !== 429) return 0;
  const seconds = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 1;
  return Math.min(maxMs, Math.round(seconds * 1000));
}
