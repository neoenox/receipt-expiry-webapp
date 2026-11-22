const MAX_IMAGE_CHARS = 2_800_000;
const RATE_PER_MINUTE = 5;
const RATE_PER_DAY = 20;
const VALID_STORAGE = new Set(['fridge', 'freezer', 'pantry']);

// Cloudflareのアイソレートは短期間で破棄されるため、共有キー利用時のみの簡易制限。
const rateBuckets = new Map();

const responseSchema = {
  type: 'OBJECT',
  properties: {
    purchaseDate: { type: 'STRING', description: 'レシートから読み取った購入日 (YYYY-MM-DD)' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '補正後の分かりやすい食材名' },
          storage: {
            type: 'STRING',
            enum: ['fridge', 'freezer', 'pantry'],
            description: '推奨保存場所',
          },
          expiryDate: { type: 'STRING', description: '予想賞味期限 (YYYY-MM-DD)' },
          quantity: { type: 'STRING', description: '数量や容量の補足（不明なら空文字）' },
        },
        required: ['name', 'storage', 'expiryDate', 'quantity'],
      },
    },
  },
  required: ['purchaseDate', 'items'],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(status, code, message) {
  return json({ error: { code, message } }, status);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function todayString() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
    || 'unknown';
}

/** 共有キー利用時のみ適用。BYOKはユーザー自身の枠なので制限しない。 */
function isRateLimited(request) {
  const now = Date.now();
  if (rateBuckets.size > 1000) {
    for (const [key, bucket] of rateBuckets) {
      if (bucket.minuteUntil < now && bucket.dayUntil < now) rateBuckets.delete(key);
    }
  }

  const ip = clientIp(request);
  const bucket = rateBuckets.get(ip) || {
    minuteCount: 0,
    minuteUntil: now + 60_000,
    dayCount: 0,
    dayUntil: now + 86_400_000,
  };
  if (now >= bucket.minuteUntil) {
    bucket.minuteCount = 0;
    bucket.minuteUntil = now + 60_000;
  }
  if (now >= bucket.dayUntil) {
    bucket.dayCount = 0;
    bucket.dayUntil = now + 86_400_000;
  }
  bucket.minuteCount += 1;
  bucket.dayCount += 1;
  rateBuckets.set(ip, bucket);

  return bucket.minuteCount > RATE_PER_MINUTE || bucket.dayCount > RATE_PER_DAY;
}

function buildPrompt(clientDate) {
  return `あなたは日本のスーパーやコンビニのレシートを解析する専門家です。
画像から「食品・飲料」のみを抽出し、JSON形式で出力してください。

【ルール】
1. レシートに記載された購入日を読み取り purchaseDate (YYYY-MM-DD) に設定してください。読み取れない場合は基準日（${clientDate}）を使用してください。
2. 半角カタカナや略称商品名は、一般的で分かりやすい日本語の食材名に補正してください（例: ﾄｸﾉｳｷﾞｭｳﾆｭｳ -> 特濃牛乳）。
3. レジ袋、ティッシュ、洗剤、割り箸などの日用品・非食品や、小計・消費税・ポイント表記は完全に除外してください。
4. 各食材について、purchaseDate を起点とした一般的な日持ち日数から予想賞味期限（expiryDate: YYYY-MM-DD）を算出してください。
   - 生鮮肉・魚介類: 2〜3日後
   - 葉物野菜・カット野菜: 3〜5日後
   - 根菜類（じゃがいも・玉ねぎ等）: 14〜30日後
   - 牛乳・乳製品・卵: 7〜14日後
   - パン・惣菜: 1〜4日後
   - 冷凍食品・缶詰・乾物・調味料: 30〜180日後
5. 適切な保存場所を fridge（冷蔵）、freezer（冷凍）、pantry（常温）のいずれかで判定してください。
6. 必ず指定されたスキーマに従う JSON オブジェクトのみを出力し、説明文やコードフェンスは付けないでください。`;
}

function normalizeAIResult(data, fallbackDate) {
  const purchaseDate = isValidDateString(data?.purchaseDate) ? data.purchaseDate : fallbackDate;
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const items = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    if (!name) continue;
    items.push({
      name,
      storage: VALID_STORAGE.has(raw.storage) ? raw.storage : 'pantry',
      expiryDate: isValidDateString(raw.expiryDate) ? raw.expiryDate : addDays(purchaseDate, 7),
      quantity: typeof raw.quantity === 'string' ? raw.quantity.trim().slice(0, 40) : '',
    });
  }
  return { purchaseDate, items };
}

function extractJsonText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('no parts');
  const text = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('').trim();
  const withoutFence = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return withoutFence;
}

async function geminiFailureMessage(response, usingCustomKey) {
  let detail = '';
  try {
    const payload = await response.json();
    if (typeof payload?.error?.message === 'string') detail = payload.error.message.slice(0, 240);
  } catch {
    // エラー本文がJSONでない場合はステータスコードのみで判定する。
  }
  const reason = detail.toLowerCase();
  if (response.status === 429 || reason.includes('quota') || reason.includes('resource_exhausted')) {
    return usingCustomKey
      ? '設定したGemini APIの利用上限に達しました。プランや課金設定を確認してください。'
      : 'AIの利用上限に達しました。設定画面からご自身のAPIキーをご利用ください。';
  }
  if (response.status === 403 || reason.includes('api key not valid') || reason.includes('api_key_invalid') || reason.includes('api key expired')) {
    return 'Gemini APIキーが無効です。設定画面のキーを確認してください。';
  }
  if (reason.includes('model') && reason.includes('not found')) {
    return '指定されたGeminiモデルが利用できません。APIキーの権限を確認してください。';
  }
  return detail ? `AIがリクエストを拒否しました: ${detail}` : 'AIがリクエストを受理しませんでした。APIキーを確認してください。';
}


export async function onRequestPost(context) {
  const { request, env } = context;

  // 同一オリジンのフロントエンドからのみ許可する。
  const origin = request.headers.get('Origin');
  if (origin) {
    let allowedOrigin;
    try {
      allowedOrigin = new URL(request.url).origin;
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'リクエストが正しくありません。');
    }
    if (origin !== allowedOrigin) {
      return errorResponse(403, 'FORBIDDEN', 'このリクエストは許可されていません。');
    }
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_IMAGE_CHARS + 4096) {
    return errorResponse(400, 'PAYLOAD_TOO_LARGE', '画像データが大きすぎます。');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'リクエストの形式が正しくありません。');
  }

  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : '';
  if (!imageBase64 || imageBase64.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    return errorResponse(400, 'INVALID_IMAGE', '画像データが正しくありません。');
  }

  const customApiKey = typeof body?.customApiKey === 'string' ? body.customApiKey.trim().slice(0, 256) : '';
  const sharedApiKey = typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  const apiKey = customApiKey || sharedApiKey;
  if (!apiKey) {
    return errorResponse(500, 'API_KEY_NOT_CONFIGURED', '解析用のAPIキーが未設定です。設定画面からご自身のGemini APIキーを登録するか、運用者に共通キーの設定を依頼してください。');
  }
  if (!customApiKey && isRateLimited(request)) {
    return errorResponse(429, 'RATE_LIMIT_EXCEEDED', '解析リクエストの上限に達しました。しばらく待つか、設定画面からご自身のAPIキーをご利用ください。');
  }

  const clientDate = isValidDateString(body.clientDate) ? body.clientDate : todayString();
  const mimeType = body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';

  let geminiResponse;
  try {
    geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: buildPrompt(clientDate) },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      }
    );
  } catch {
    return errorResponse(502, 'AI_UNAVAILABLE', 'AIサービスに接続できませんでした。しばらくして再度お試しください。');
  }

  if (!geminiResponse.ok) {
    const code = geminiResponse.status === 429 ? 'AI_QUOTA_EXCEEDED'
      : (geminiResponse.status === 400 || geminiResponse.status === 403 ? 'AI_REQUEST_REJECTED' : 'AI_ERROR');
    return errorResponse(502, code, await geminiFailureMessage(geminiResponse, Boolean(customApiKey)));
  }

  let result;
  try {
    const payload = await geminiResponse.json();
    result = normalizeAIResult(JSON.parse(extractJsonText(payload)), clientDate);
  } catch {
    return errorResponse(502, 'INVALID_AI_RESPONSE', '解析結果を読み取れませんでした。再度お試しください。');
  }

  if (result.items.length === 0) {
    return errorResponse(422, 'NO_FOOD_ITEMS', 'レシートから食材を検出できませんでした。');
  }
  return json(result);
}
