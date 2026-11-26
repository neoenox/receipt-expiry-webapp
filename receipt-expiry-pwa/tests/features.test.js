import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createQueuedAnalysis, nextAttempt, shouldDiscard, MAX_QUEUE_ATTEMPTS } from '../public/js/queue.js';
import { createConsumption, summarizeHistory } from '../public/js/history.js';
import { normalizeFoodName, createExpiryHint, buildHintMap } from '../public/js/learning.js';
import { filterAndSortItems, annotateResultItems } from '../public/js/inventory.js';
import { buildShoppingSuggestions, buildCalendar, shiftMonth, cropRect, shouldSendAtHour, jstDate, isSubscriptionRateLimited, retryDelayMs } from '../public/js/features2.js';
import { analyzePayloads } from '../public/js/analysisFlow.js';
import { isValidDate, formatDate, todayISO, defaultExpiryISO, daysUntilDate } from '../public/js/dates.js';
import { dataUrlMime, base64FromDataUrl, nextQuality } from '../public/js/imageOptions.js';
import { buildReminderBody } from '../notify-worker/index.js';

test('queued analysis never stores an API key', () => {
  const job = createQueuedAnalysis({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', clientDate: '2026-11-22' });
  assert.equal(job.clientDate, '2026-11-22');
  assert.equal(job.attempts, 0);
  assert.equal('customApiKey' in job, false);
  assert.equal('apiKey' in job, false);
  assert.ok(job.id);
});

test('queued analysis preserves PNG and WebP MIME types and defaults other types to JPEG', () => {
  const imageBase64 = 'aGVsbG8=';
  const webp = createQueuedAnalysis({ imageBase64, mimeType: 'image/webp' });
  assert.equal(webp.mimeType, 'image/webp');

  const png = createQueuedAnalysis({ imageBase64, mimeType: 'image/png' });
  assert.equal(png.mimeType, 'image/png');

  const jpeg = createQueuedAnalysis({ imageBase64, mimeType: 'image/jpeg' });
  assert.equal(jpeg.mimeType, 'image/jpeg');

  const unknown = createQueuedAnalysis({ imageBase64, mimeType: 'image/gif' });
  assert.equal(unknown.mimeType, 'image/jpeg');
});

test('rate-limited payloads carry Retry-After so the queue can wait', async () => {
  const result = await analyzePayloads(
    [{ imageBase64: 'rate-limited' }],
    {
      analyzeReceipt: async () => {
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfter = 60;
        throw error;
      },
    }
  );
  assert.equal(result.errors, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].retryAfter, 60);
});

test('queued jobs wait until nextAttemptAt before a retry', () => {
  const job = createQueuedAnalysis({ imageBase64: 'aGVsbG8=' }, { retryAfter: 60 });
  assert.ok(job.nextAttemptAt > Date.now() + 59_000);
  const attempted = nextAttempt(job);
  assert.equal(attempted.nextAttemptAt, 0);
  assert.equal(attempted.attempts, 1);
});

test('queue retries are bounded', () => {
  let job = createQueuedAnalysis({ imageBase64: 'aGVsbG8=' });
  for (let i = 0; i < MAX_QUEUE_ATTEMPTS; i += 1) job = nextAttempt(job);
  assert.equal(shouldDiscard(job), true);
});

test('consumption entries are validated and summarized for the current month', () => {
  assert.throws(() => createConsumption({ name: '牛乳' }, 'unknown'), /種別が不正/);
  const now = new Date(2026, 10, 15);
  const entries = [
    createConsumption({ name: '牛乳' }, 'eaten'),
    createConsumption({ name: 'パン' }, 'discarded'),
    { ...createConsumption({ name: '古い' }, 'eaten'), consumedAt: new Date(2026, 9, 1).getTime() },
  ];
  assert.deepEqual(summarizeHistory(entries, now), { eaten: 1, discarded: 1, total: 2 });
});

test('expiry hints normalize names and ignore invalid dates', () => {
  assert.equal(normalizeFoodName('  特濃　牛乳 '), '特濃牛乳');
  const hint = createExpiryHint('  特濃　牛乳 ', '2026-12-01');
  assert.equal(hint.name, '特濃牛乳');
  const map = buildHintMap([hint, { name: 'bad', expiryDate: 'not-a-date' }]);
  assert.equal(map.get('特濃牛乳'), '2026-12-01');
  assert.equal(map.has('bad'), false);
});


test('inventory search and sort are applied together', () => {
  const items = [
    { name: '牛乳', quantity: '1本', storage: 'fridge', expiryDate: '2026-12-10', createdAt: 1 },
    { name: '食パン', quantity: '1袋', storage: 'pantry', expiryDate: '2026-11-25', createdAt: 2 },
    { name: '牛乳 低脂肪', quantity: '', storage: 'fridge', expiryDate: '2026-12-01', createdAt: 3 },
  ];
  assert.deepEqual(filterAndSortItems(items, { search: '牛乳' }).map((i) => i.name), ['牛乳 低脂肪', '牛乳']);
  assert.deepEqual(filterAndSortItems(items, { filter: 'fridge', sort: 'createdAt' }).map((i) => i.createdAt), [3, 1]);
  assert.deepEqual(filterAndSortItems(items, { sort: 'name' }).map((i) => i.name), ['牛乳', '牛乳 低脂肪', '食パン']);
});


test('result annotations mark duplicates and learned-expiry differences', () => {
  const rows = annotateResultItems(
    [
      { name: '特濃牛乳', expiryDate: '2026-12-01' },
      { name: '食パン', expiryDate: '2026-11-25' },
      { name: '卵', expiryDate: '2026-12-10' },
    ],
    {
      stockItems: [{ id: 'stock-1', name: '特濃 牛乳', expiryDate: '2026-12-01', quantity: '1本' }],
      hints: new Map([['食パン', '2026-11-28']]),
    }
  );
  assert.equal(rows[0].duplicate, true);
  assert.equal(rows[0].matchedStock.id, 'stock-1');
  assert.equal(rows[0].selected, false);
  assert.equal(rows[1].hint, '2026-11-28');
  assert.equal(rows[1].hintDiffers, true);
  assert.equal(rows[2].duplicate, false);
  assert.equal(rows[2].selected, true);
});

test('image helpers detect format and step down quality', () => {
  assert.equal(dataUrlMime('data:image/webp;base64,AAAA'), 'image/webp');
  assert.equal(dataUrlMime('data:image/png;base64,AAAA'), 'image/png');
  assert.equal(base64FromDataUrl('data:image/webp;base64,QUJD'), 'QUJD');
  assert.equal(nextQuality(0.9), 0.8);
  assert.equal(nextQuality(0.7), null);
});


test('reminder dates and messages are computed locally', () => {
  const now = new Date(2026, 10, 22);
  assert.equal(daysUntilDate('2026-11-22', now), 0);
  assert.equal(daysUntilDate('2026-11-25', now), 3);
  assert.equal(daysUntilDate('bad', now), null);
  assert.match(buildReminderBody(0), /本日が賞味期限/);
  assert.match(buildReminderBody(1), /明日が賞味期限/);
  assert.match(buildReminderBody(4), /あと4日/);
});

test('date helpers validate and format calendar dates', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('0026-01-01'), true);
  assert.equal(formatDate(new Date(2026, 10, 5)), '2026-11-05');
  assert.equal(todayISO(new Date(2026, 10, 5)), '2026-11-05');
  assert.equal(defaultExpiryISO(new Date(2026, 10, 25)), '2026-12-02');
});


test('shopping suggestions exclude current stock and sort by frequency', () => {
  const history = [
    { name: '牛乳', reason: 'eaten', consumedAt: 1 },
    { name: '牛乳', reason: 'eaten', consumedAt: 2 },
    { name: 'パン', reason: 'discarded', consumedAt: 3 },
    { name: '卵', reason: 'eaten', consumedAt: 4 },
  ];
  const suggestions = buildShoppingSuggestions(history, [{ name: '卵' }]);
  assert.deepEqual(suggestions.map((item) => item.name), ['牛乳']);
  assert.equal(suggestions[0].count, 2);
});

test('shopping suggestions carry the usual storage location', () => {
  const history = [
    { name: '牛乳', reason: 'eaten', consumedAt: 1, storage: 'fridge' },
    { name: '牛乳', reason: 'eaten', consumedAt: 2, storage: 'fridge' },
  ];
  const [suggestion] = buildShoppingSuggestions(history, []);
  assert.equal(suggestion.storage, 'fridge');
});

test('calendar groups items by expiry day within the requested month', () => {
  const items = [
    { name: 'A', expiryDate: '2026-11-05' },
    { name: 'B', expiryDate: '2026-11-05' },
    { name: 'C', expiryDate: '2026-12-01' },
  ];
  const days = buildCalendar(items, 2026, 10);
  assert.equal(days.get(5).length, 2);
  assert.equal(days.has(1), false);
});

test('month shift advances exactly one month and wraps the year', () => {
  assert.deepEqual(shiftMonth(2026, 10, 'next'), { year: 2026, month: 11 });
  assert.deepEqual(shiftMonth(2026, 11, 'next'), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, 'prev'), { year: 2025, month: 11 });
});

test('crop rect respects rotation and bounds', () => {
  assert.deepEqual(cropRect(100, 200, { left: 0.1, right: 0.2, top: 0.25, bottom: 0.05 }), {
    x: 10, y: 50, width: 70, height: 140,
  });
  assert.equal(cropRect(100, 200, {}, 90).width >= 199, true);
});

test('notification hour is evaluated in JST and catches up missed runs', () => {
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, now), true);
  assert.equal(shouldSendAtHour({ notifyHour: 7 }, now), false);

  const late = new Date('2026-11-23T22:30:00Z'); // JST 07:30
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, late, null), true);
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, late, '2026-11-24'), false);
  assert.equal(shouldSendAtHour({ notifyHour: 8 }, late, null), false);
  assert.equal(jstDate(late), '2026-11-24');
});


test('reminder advances to the next expiry after notifying', async (t) => {
  const { sendReminders } = await import('../functions/shared/reminder.js');
  const store = new Map();
  const kv = {
    async list() { return { keys: [{ name: 'sub1' }], list_complete: true }; },
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00
  store.set('sub1', JSON.stringify({
    subscription: { endpoint: 'https://example.test/push' },
    nextExpiry: '2026-11-24',
    expiryDates: ['2026-11-24', '2026-11-30', '2026-12-05'],
    notifyHour: 6,
    daysUntil: 0,
  }));
  const sent = [];

  const count = await sendReminders({
    kv,
    sendNotification: async (sub, payload) => sent.push(JSON.parse(payload)),
    vapid: { publicKey: 'pub', privateKey: 'priv' },
    now,
  });

  assert.equal(count, 1);
  assert.match(sent[0].body, /本日が賞味期限/);
  const updated = JSON.parse(store.get('sub1'));
  assert.equal(updated.nextExpiry, '2026-11-30');
  assert.equal(updated.daysUntil, 6);
  assert.ok(updated.notifiedAt);
});

test('subscription writes are rate limited', () => {
  assert.equal(isSubscriptionRateLimited(5, 10), false);
  assert.equal(isSubscriptionRateLimited(11, 10), true);
  assert.equal(isSubscriptionRateLimited(1, 1000), true);
});


test('retry delay respects Retry-After but is capped', () => {
  assert.equal(retryDelayMs(500, 5), 0);
  assert.equal(retryDelayMs(429, 1), 1000);
  assert.equal(retryDelayMs(429, 60), 5000);
});


test('analysis flow does not burn attempts on 429 and still merges other results', async () => {
  const metrics = [];
  const result = await analyzePayloads(
    [{ imageBase64: 'a' }, { imageBase64: 'b' }],
    {
      analyzeReceipt: async ({ imageBase64 }) => {
        if (imageBase64 === 'a') {
          const error = new Error('rate limited');
          error.status = 429;
          error.retryAfter = 60;
          throw error;
        }
        return { purchaseDate: '2026-11-23', items: [{ name: 'item-b' }] };
      },
      onMetric: (kind) => metrics.push(kind),
    }
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.results.map((entry) => entry.ok), [false, true]);
  assert.equal(result.results[0].retryAfter, 60);
  assert.deepEqual(metrics, ['error', 'success']);
});

test('analysis flow reports the exact payload that failed so it can be requeued', async () => {
  const errors = [];
  const result = await analyzePayloads(
    [{ imageBase64: 'ok' }, { imageBase64: 'bad' }],
    {
      analyzeReceipt: async ({ imageBase64 }) => {
        if (imageBase64 === 'bad') throw new Error('解析できません');
        return { purchaseDate: '2026-11-23', items: [{ name: '牛乳' }] };
      },
      onError: (error) => errors.push(error.message),
    }
  );

  assert.equal(result.errors, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(errors, ['解析できません']);
  assert.deepEqual(result.results.map((entry) => entry.ok), [true, false]);
  assert.deepEqual(result.results[1].payload, { imageBase64: 'bad' });
  // result.failed の有無にかかわらず、失敗ペイロードが results に残ることを検証する。
  assert.deepEqual(result.results.filter((entry) => !entry.ok).map((entry) => entry.payload), [{ imageBase64: 'bad' }]);
  if (result.failed !== undefined) {
    assert.deepEqual(result.failed, [{ imageBase64: 'bad' }]);
  }
});

test('service worker excludes /sw.js from network-first handling', () => {
  const swPath = fileURLToPath(new URL('../public/sw.js', import.meta.url));
  const source = fs.readFileSync(swPath, 'utf8');
  // /sw.js は network-first の集合/前方一致に含めず、fetch ハンドラで早期 return する。
  assert.match(source, /url\.pathname === '\/sw\.js'\)\s*return;/);
  const networkFirstLine = source.split('\n').find((line) => line.includes('const NETWORK_FIRST ='));
  assert.ok(networkFirstLine, 'NETWORK_FIRST の定義があること');
  assert.equal(networkFirstLine.includes('/sw.js'), false);
  const prefixesLine = source.split('\n').find((line) => line.includes('const NETWORK_FIRST_PREFIXES ='));
  assert.ok(prefixesLine, 'NETWORK_FIRST_PREFIXES の定義があること');
  assert.equal(prefixesLine.includes('/sw.js'), false);
});
