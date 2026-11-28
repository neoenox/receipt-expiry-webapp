import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/push/subscribe.js';
import { sendReminders } from '../functions/shared/reminder.js';
import { jstDate, shouldSendAtHour } from '../functions/shared/schedule.js';

const ORIGIN = 'https://receipt-expiry-pwa.pages.dev';

function addDays(date, amount) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return next.toISOString().slice(0, 10);
}

function createKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list() {
      const names = [...store.keys()].filter((key) => !key.startsWith('subrate:')
        && key !== 'subcount:total' && !key.startsWith('metrics:'));
      return { keys: names.map((name) => ({ name })), list_complete: true };
    },
  };
}

function makeSubscribeRequest(body, ip = '203.0.113.40') {
  return new Request(`${ORIGIN}/api/push/subscribe`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(body),
  });
}

function subscription(endpoint = 'https://push.example.test/sub') {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-test', auth: 'auth-test' },
  };
}

test('resubscribe preserves a legacy notified expiry and selects the next date', async () => {
  const today = jstDate(new Date());
  const tomorrow = addDays(today, 1);
  const store = new Map();
  const endpoint = subscription().endpoint;
  const notifiedAt = Date.now() - 60_000;
  store.set('subcount:total', '1');
  store.set(endpoint, JSON.stringify({
    subscription: subscription(),
    nextExpiry: null,
    expiryDates: [today, tomorrow],
    notifyHour: 6,
    notifiedAt,
  }));
  const kv = createKv(store);

  const response = await onRequestPost({
    request: makeSubscribeRequest({
      subscription: subscription(),
      nextExpiry: today,
      expiryDates: [today, tomorrow],
      daysUntil: 0,
      notifyHour: 6,
    }),
    env: { PUBLIC_ORIGIN: ORIGIN, PUSH_KV: kv },
  });

  assert.equal(response.status, 200);
  const updated = JSON.parse(store.get(endpoint));
  assert.equal(updated.nextExpiry, tomorrow);
  assert.deepEqual(updated.notifiedExpiryDates, [today]);
  assert.equal(updated.notifiedAt, notifiedAt);
  assert.equal(updated.daysUntil, 1);
});

test('notification worker processes KV cursor pages', async () => {
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00, 2026-11-24
  const today = jstDate(now);
  const next = addDays(today, 6);
  const store = new Map();
  for (const name of ['sub1', 'sub2']) {
    store.set(name, JSON.stringify({
      subscription: subscription(`https://push.example.test/${name}`),
      nextExpiry: today,
      expiryDates: [today, next],
      notifyHour: 6,
      daysUntil: 0,
    }));
  }
  let pageCalls = 0;
  const kv = {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ cursor }) {
      pageCalls += 1;
      if (!cursor) return { keys: [{ name: 'sub1' }], list_complete: false, cursor: 'page2' };
      return { keys: [{ name: 'sub2' }], list_complete: true };
    },
  };
  const sent = [];

  const count = await sendReminders({
    kv,
    sendNotification: async (sub, payload) => sent.push({ sub, payload: JSON.parse(payload) }),
    vapid: { publicKey: 'public', privateKey: 'private' },
    now,
    listLimit: 1,
  });

  assert.equal(count, 2);
  assert.equal(pageCalls, 2);
  assert.equal(sent.length, 2);
  for (const name of ['sub1', 'sub2']) {
    const updated = JSON.parse(store.get(name));
    assert.equal(updated.nextExpiry, next);
    assert.deepEqual(updated.notifiedExpiryDates, [today]);
    assert.ok(updated.notifiedAt);
  }
});

test('worker advances an expiry already recorded as notified without sending again', async () => {
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00, 2026-11-24
  const today = jstDate(now);
  const next = addDays(today, 6);
  const store = new Map([['sub1', JSON.stringify({
    subscription: subscription(),
    nextExpiry: today,
    expiryDates: [today, next],
    notifiedExpiryDates: [today],
    notifyHour: 6,
    daysUntil: 0,
  })]]);
  const kv = createKv(store);
  let sent = 0;

  const count = await sendReminders({
    kv,
    sendNotification: async () => { sent += 1; },
    vapid: { publicKey: 'public', privateKey: 'private' },
    now,
  });

  assert.equal(count, 0);
  assert.equal(sent, 0);
  const updated = JSON.parse(store.get('sub1'));
  assert.equal(updated.nextExpiry, next);
  assert.deepEqual(updated.notifiedExpiryDates, [today]);
});

test('worker suppresses a scheduled-hour retry when already notified today', async () => {
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00, 2026-11-24
  const today = jstDate(now);
  const store = new Map([['sub1', JSON.stringify({
    subscription: subscription(),
    nextExpiry: today,
    expiryDates: [today],
    notifyHour: 6,
    notifiedAt: now.getTime(),
  })]]);
  let sent = 0;

  const count = await sendReminders({
    kv: createKv(store),
    sendNotification: async () => { sent += 1; },
    vapid: { publicKey: 'public', privateKey: 'private' },
    now,
  });

  assert.equal(count, 0);
  assert.equal(sent, 0);
});

test('scheduled-hour retry is suppressed for an expiry already notified today', () => {
  const now = new Date('2026-11-23T21:00:00Z'); // JST 06:00, 2026-11-24
  const today = jstDate(now);
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, now, today), false);
  assert.equal(shouldSendAtHour({ notifyHour: 6 }, now, null), true);
});
