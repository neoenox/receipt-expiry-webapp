const RATE_PER_MINUTE = 5;
const RATE_PER_DAY = 20;

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const now = Number(body.now) || Date.now();
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
      limited: bucket.minuteCount > RATE_PER_MINUTE || bucket.dayCount > RATE_PER_DAY,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  fetch() {
    return new Response('receipt-expiry-rate-limiter: ok');
  },
};
