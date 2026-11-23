import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueuedAnalysis, nextAttempt, shouldDiscard, MAX_QUEUE_ATTEMPTS } from '../public/js/queue.js';
import { createConsumption, summarizeHistory } from '../public/js/history.js';
import { normalizeFoodName, createExpiryHint, buildHintMap } from '../public/js/learning.js';
import { filterAndSortItems } from '../public/js/inventory.js';
import { buildShoppingSuggestions, buildCalendar, cropRect, shouldSendAtHour } from '../public/js/features2.js';
import { dataUrlMime, base64FromDataUrl, nextQuality } from '../public/js/imageOptions.js';
import { daysUntilDate } from '../public/js/dates.js';
import { buildReminderBody } from '../notify-worker/index.js';

test('queued analysis never stores an API key', () => {
  const job = createQueuedAnalysis({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', clientDate: '2026-11-22' });
  assert.equal(job.clientDate, '2026-11-22');
  assert.equal(job.attempts, 0);
  assert.equal('customApiKey' in job, false);
  assert.equal('apiKey' in job, false);
  assert.ok(job.id);
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

test('crop rect respects rotation and bounds', () => {
  assert.deepEqual(cropRect(100, 200, { left: 0.1, right: 0.2, top: 0.25, bottom: 0.05 }), {
    x: 10, y: 50, width: 70, height: 140,
  });
  assert.equal(cropRect(100, 200, {}, 90).width >= 199, true);
});

test('notification hour is evaluated in JST', () => {
  const now = new Date('2026-11-23T21:00:00Z');
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, now), true);
  assert.equal(shouldSendAtHour({ notifyHour: 7 }, now), false);
});
