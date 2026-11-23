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

test('KV adapter serializes concurrent writes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-kv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const kv = createKvAdapter(path.join(dir, 'store.json'));

  await Promise.all(Array.from({ length: 20 }, (_, i) => kv.put(`key-${i}`, String(i))));
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await kv.get(`key-${i}`), String(i));
  }
});
