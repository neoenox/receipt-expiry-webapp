/** ブラウザ側のドメイン値。保存・表示・バリデーションはここを唯一の情報源とする。 */
export const STORAGE_TYPES = Object.freeze(['fridge', 'freezer', 'pantry']);
export const STORAGE_LABELS = Object.freeze({
  fridge: '冷蔵',
  freezer: '冷凍',
  pantry: '常温',
});
export const CONSUMPTION_REASONS = Object.freeze(['eaten', 'discarded']);
export const THEMES = Object.freeze(['auto', 'light', 'dark']);
export const DEFAULT_NOTIFY_HOUR = 6;
