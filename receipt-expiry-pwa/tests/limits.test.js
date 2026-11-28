import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisLimits,
  isSubscriptionRateLimited,
  SUBSCRIPTION_RATE,
  VALIDATE_RATE_PER_MINUTE,
} from '../functions/shared/limits.js';
import { RateLimiter } from '../ratelimit-worker/index.js';

function createState() {
  const store = new Map();
  return {
    storage: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
    },
  };
}

async function isLimited(limiter, byok) {
  const response = await limiter.fetch(new Request('https://rate-limiter/', {
    method: 'POST',
    body: JSON.stringify({ byok }),
  }));
  return (await response.json()).limited;
}

test('rate policies have one authoritative value set', () => {
  assert.deepEqual(analysisLimits(false), { minuteLimit: 5, dayLimit: 20 });
  assert.deepEqual(analysisLimits(true), { minuteLimit: 30, dayLimit: 200 });
  assert.equal(VALIDATE_RATE_PER_MINUTE, 10);
});

test('durable object enforces the same analysis policy as the handlers', async () => {
  for (const byok of [false, true]) {
    const limiter = new RateLimiter(createState());
    const { minuteLimit } = analysisLimits(byok);
    for (let i = 0; i < minuteLimit; i += 1) {
      assert.equal(await isLimited(limiter, byok), false);
    }
    assert.equal(await isLimited(limiter, byok), true);
  }
});

test('durable object enforces the shared daily analysis policy', async () => {
  const originalNow = Date.now;
  const start = Date.UTC(2026, 10, 23);
  let now = start;
  Date.now = () => now;
  try {
    for (const byok of [false, true]) {
      const limiter = new RateLimiter(createState());
      const { dayLimit } = analysisLimits(byok);
      for (let i = 0; i < dayLimit; i += 1) {
        now = start + i * 60_000; // 毎回別の分にして分上限をリセットする
        assert.equal(await isLimited(limiter, byok), false);
      }
      now = start + dayLimit * 60_000;
      assert.equal(await isLimited(limiter, byok), true);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('subscription limit uses the shared policy', () => {
  assert.equal(isSubscriptionRateLimited(SUBSCRIPTION_RATE.perHour - 1, 0), false);
  assert.equal(isSubscriptionRateLimited(SUBSCRIPTION_RATE.perHour + 1, 0), true);
  assert.equal(isSubscriptionRateLimited(0, SUBSCRIPTION_RATE.total), true);
});
