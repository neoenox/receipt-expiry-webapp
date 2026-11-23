/** Pages Function / Worker 共通のリクエスト検証ヘルパー。 */

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(status, code, message) {
  return json({ error: { code, message } }, status, status === 429 ? { 'Retry-After': '60' } : {});
}

/**
 * 同一オリジンからの JSON POST だけを許可する。
 * Origin 欠落は拒否し、単純リクエスト（text/plain 等）も受け付けない。
 */
export function requireSameOriginJson(request) {
  const origin = request.headers.get('Origin');
  let allowedOrigin;
  try {
    allowedOrigin = new URL(request.url).origin;
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'リクエストが正しくありません。');
  }
  if (!origin || origin !== allowedOrigin) {
    return errorResponse(403, 'FORBIDDEN', 'このリクエストは許可されていません。');
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON形式で送信してください。');
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return errorResponse(403, 'FORBIDDEN', 'このリクエストは許可されていません。');
  }
  return null;
}

/** Content-Length を信用せず、ストリームを読みながら上限を監視する。 */
export async function readJsonWithLimit(request, maxBytes) {
  if (!request.body) return { invalid: true };
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for await (const chunk of request.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) return { tooLarge: true };
      text += decoder.decode(bytes, { stream: true });
    }
    text += decoder.decode();
    return { body: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

export function clientIp(request) {
  // X-Forwarded-For はクライアントが偽装できるため使わない。
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || 'unknown';
}
