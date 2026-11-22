import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueuedAnalysis, nextAttempt, shouldDiscard, MAX_QUEUE_ATTEMPTS } from '../public/js/queue.js';
import { createConsumption, summarizeHistory } from '../public/js/history.js';
import { normalizeFoodName, createExpiryHint, buildHintMap } from '../public/js/learning.js';
import { filterAndSortItems } from '../public/js/inventory.js';

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
