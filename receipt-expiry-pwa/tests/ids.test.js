import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../public/js/ids.js';

test('newId uses crypto.randomUUID when available', () => {
  assert.match(newId('job'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('newId keeps a purpose-specific prefix on legacy browsers', () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    assert.match(newId('id'), /^id-\d+-[0-9a-f]+$/);
    assert.match(newId('job'), /^job-\d+-[0-9a-f]+$/);
    assert.match(newId('shop'), /^shop-\d+-[0-9a-f]+$/);
    assert.match(newId('history'), /^history-\d+-[0-9a-f]+$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
  }
});
