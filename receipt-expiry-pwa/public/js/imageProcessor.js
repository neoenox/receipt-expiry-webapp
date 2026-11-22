const MAX_SIZE = 1024;
const JPEG_QUALITY = 0.8;

/**
 * レシート画像を長辺1024pxのJPEGへリサイズし、プレフィックスなしのBase64を返す。
 * createImageBitmap がEXIF回転を補正するため、縦撮影画像も正しい向きで描画される。
 */
export async function processReceiptImage(file) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('画像ファイルを選択してください。');
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

    const originalWidth = source.width || source.naturalWidth;
    const originalHeight = source.height || source.naturalHeight;
    if (!originalWidth || !originalHeight) {
      throw new Error('画像のサイズを取得できませんでした。');
    }

    const scale = Math.min(1, MAX_SIZE / Math.max(originalWidth, originalHeight));
    const targetWidth = Math.max(1, Math.round(originalWidth * scale));
    const targetHeight = Math.max(1, Math.round(originalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像を処理できませんでした。');

    // 透過PNGをJPEGに変換すると黒背景になるため、先に白で塗りつぶす。
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!base64) throw new Error('画像の変換に失敗しました。');

    return { base64, mimeType: 'image/jpeg' };
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

function loadImageElement(file) {
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
