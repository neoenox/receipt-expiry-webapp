const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 指定日までの日数をローカル日付基準で返す（当日=0、昨日=-1）。 */
export function daysUntilDate(dateString, now = new Date()) {
  if (typeof dateString !== 'string' || !DATE_PATTERN.test(dateString)) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  if (target.getFullYear() !== year || target.getMonth() !== month - 1 || target.getDate() !== day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
