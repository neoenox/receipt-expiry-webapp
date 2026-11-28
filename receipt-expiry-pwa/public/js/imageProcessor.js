import { QUALITY_STEPS, MAX_BASE64_CHARS, dataUrlMime, base64FromDataUrl, nextQuality } from './imageOptions.js';
import { cropRect } from './features2.js';

const MAX_SIZE = 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 回転とクロップを適用した canvas を返す（プレビューと本番処理で共有）。 */
export function renderPreviewCanvas(source, { rotate = 0, crop = {}, maxSize = MAX_SIZE } = {}) {
  const originalWidth = source.width || source.naturalWidth;
  const originalHeight = source.height || source.naturalHeight;
  if (!originalWidth || !originalHeight) throw new Error('画像のサイズを取得できませんでした。');

  const swap = Number(rotate) % 180 !== 0;
  const rotatedWidth = swap ? originalHeight : originalWidth;
  const rotatedHeight = swap ? originalWidth : originalHeight;

  const intermediate = document.createElement('canvas');
  intermediate.width = rotatedWidth;
  intermediate.height = rotatedHeight;
  const ictx = intermediate.getContext('2d');
  if (!ictx) throw new Error('画像を処理できませんでした。');
  ictx.fillStyle = '#ffffff';
  ictx.fillRect(0, 0, rotatedWidth, rotatedHeight);
  ictx.translate(rotatedWidth / 2, rotatedHeight / 2);
  ictx.rotate((Number(rotate) * Math.PI) / 180);
  ictx.drawImage(source, -originalWidth / 2, -originalHeight / 2);

  const rect = cropRect(rotatedWidth, rotatedHeight, crop, 0);
  const scale = Math.min(1, maxSize / Math.max(rect.width, rect.height));
  const targetWidth = Math.max(1, Math.round(rect.width * scale));
  const targetHeight = Math.max(1, Math.round(rect.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を処理できませんでした。');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(intermediate, rect.x, rect.y, rect.width, rect.height, 0, 0, targetWidth, targetHeight);
  return canvas;
}

/**
 * レシート画像を長辺1024pxのJPEGへリサイズし、プレフィックスなしのBase64を返す。
 * createImageBitmap がEXIF回転を補正するため、縦撮影画像も正しい向きで描画される。
 */
export async function processReceiptImage(file, options = {}) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('画像ファイルを選択してください。');
  }
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
    throw new Error('画像ファイルが大きすぎます。別の画像をお試しください。');
  }


  let source;
  let release;
  try {
    if (typeof createImageBitmap === 'function') {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      release = () => source.close();
    } else {
      source = await loadImageElement(file);
      release = () => {};
    }

    const canvas = renderPreviewCanvas(source, { rotate: options.rotate, crop: options.crop || {} });

    const webpProbe = canvas.toDataURL('image/webp', QUALITY_STEPS[0]);
    const mimeType = dataUrlMime(webpProbe) === 'image/webp' ? 'image/webp' : 'image/jpeg';

    for (let quality = QUALITY_STEPS[0]; quality !== null; quality = nextQuality(quality)) {
      const dataUrl = canvas.toDataURL(mimeType, quality);
      const base64 = base64FromDataUrl(dataUrl);
      if (base64 && base64.length <= MAX_BASE64_CHARS) {
        return { base64, mimeType };
      }
    }
    throw new Error('画像データを圧縮できませんでした。別の画像をお試しください。');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('画像')) throw error;
    throw new Error(describeImageError(error));
  } finally {
    if (release) release();
  }
}

function describeImageError(error) {
  return error instanceof Error && error.message
    ? `画像を読み込めませんでした。（${error.message}）`
    : '画像を読み込めませんでした。別の画像をお試しください。';
}

export function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像のデコードに失敗しました'));
    };
    image.src = url;
  });
}
