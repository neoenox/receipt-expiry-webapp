export const QUALITY_STEPS = [0.9, 0.8, 0.7];
export const MAX_BASE64_CHARS = 2_700_000;

export function dataUrlMime(dataUrl) {
  const match = /^data:([^;,]+)/.exec(String(dataUrl || ''));
  return match ? match[1] : '';
}

export function base64FromDataUrl(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : '';
}

export function nextQuality(quality) {
  const index = QUALITY_STEPS.indexOf(Number(quality));
  if (index < 0 || index + 1 >= QUALITY_STEPS.length) return null;
  return QUALITY_STEPS[index + 1];
}
