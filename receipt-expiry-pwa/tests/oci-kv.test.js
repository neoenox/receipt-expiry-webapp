import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKvAdapter } from '../oci/kv-adapter.js';

test('KV adapter persists values across instances and supports prefix listing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-kv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');

  const first = createKvAdapter(file);
  await first.put('https://example.test/sub', JSON.stringify({ nextExpiry: '2026-12-01' }));
  await first.put('metrics:success:2026-11-23', '3');

  const second = createKvAdapter(file);
  assert.deepEqual(JSON.parse(await second.get('https://example.test/sub')), { nextExpiry: '2026-12-01' });
  const listed = await second.list({ prefix: 'https://' });
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].name, 'https://example.test/sub');
  assert.equal(listed.list_complete, true);
});

test('TTL survives a restart and is cleared by a later put without TTL', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-kv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');

  const first = createKvAdapter(file);
  await first.put('short', 'expired', { expirationTtl: -1 });
  await first.put('keep', 'alive', { expirationTtl: 3600 });

  // 新しいインスタンス = プロセス再起動を模す。
  const second = createKvAdapter(file);
  assert.equal(await second.get('short'), null);
  assert.equal(await second.get('keep'), 'alive');

  await second.put('keep', 'no-ttl');
  const third = createKvAdapter(file);
  assert.equal(await third.get('keep'), 'no-ttl');
});

test('list excludes expired entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-kv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const kv = createKvAdapter(path.join(dir, 'store.json'));

  await kv.put('expired', 'x', { expirationTtl: -1 });
  await kv.put('alive', 'y', { expirationTtl: 3600 });
  const listed = await kv.list();
  assert.deepEqual(listed.keys.map((entry) => entry.name), ['alive']);
});

test('KV adapter serializes concurrent writes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-kv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const kv = createKvAdapter(path.join(dir, 'store.json'));

  await Promise.all(Array.from({ length: 20 }, (_, i) => kv.put(`key-${i}`, String(i))));
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await kv.get(`key-${i}`), String(i));
  }
});
