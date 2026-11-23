const RATE_PER_MINUTE = 5;
const RATE_PER_DAY = 20;
const BYOK_RATE_PER_MINUTE = 30;
const BYOK_RATE_PER_DAY = 200;

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    // クライアントから渡された時刻を信用しない。過去時刻でバケットを
    // リセットされるため、Durable Object 内で現在時刻を生成する。
    const now = Date.now();
    const byok = body.byok === true;
    const minuteLimit = byok ? BYOK_RATE_PER_MINUTE : RATE_PER_MINUTE;
    const dayLimit = byok ? BYOK_RATE_PER_DAY : RATE_PER_DAY;

    let bucket = await this.state.storage.get('bucket');

    if (!bucket || now >= bucket.minuteUntil) {
      bucket = {
        minuteCount: 0,
        minuteUntil: now + 60_000,
        dayCount: bucket?.dayCount || 0,
        dayUntil: bucket?.dayUntil || now + 86_400_000,
      };
    }
    if (now >= bucket.dayUntil) {
      bucket.dayCount = 0;
      bucket.dayUntil = now + 86_400_000;
    }

    bucket.minuteCount += 1;
    bucket.dayCount += 1;
    await this.state.storage.put('bucket', bucket);

    return new Response(JSON.stringify({
      limited: bucket.minuteCount > minuteLimit || bucket.dayCount > dayLimit,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  fetch() {
    return new Response('receipt-expiry-rate-limiter: ok');
  },
};
