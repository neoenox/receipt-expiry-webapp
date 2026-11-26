const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD の暦日として有効か判定する。 */
export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Date をローカル日付の YYYY-MM-DD に変換する。 */
export function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = String(date.getFullYear()).padStart(4, '0');
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayISO(now = new Date()) {
  return formatDate(now);
}

export function defaultExpiryISO(now = new Date(), days = 7) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

/** 指定日までの日数をローカル日付基準で返す（当日=0、昨日=-1）。 */
export function daysUntilDate(dateString, now = new Date()) {
  if (!isValidDate(dateString)) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  const target = new Date(0);
  target.setFullYear(year, month - 1, day);
  target.setHours(0, 0, 0, 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
