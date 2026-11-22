import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBackup, parseBackup } from '../public/js/backup.js';

const ITEM = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: '特濃牛乳',
  storage: 'fridge',
  expiryDate: '2026-11-29',
  purchaseDate: '2026-11-22',
  quantity: '1本',
  createdAt: 1795334400000,
};

test('backup round-trip preserves items and metadata', () => {
  const json = serializeBackup([ITEM]);
  const data = JSON.parse(json);
  assert.equal(data.format, 'receipt-expiry-backup');
  assert.equal(data.version, 1);
  assert.ok(data.exportedAt);
  assert.deepEqual(parseBackup(json), [ITEM]);
});

test('backup strips unknown fields and fills optional fields', () => {
  const json = serializeBackup([{
    ...ITEM,
    purchaseDate: undefined,
    quantity: undefined,
    injected: 'should be dropped',
  }]);
  const [item] = parseBackup(json);
  assert.equal(item.purchaseDate, null);
  assert.equal(item.quantity, '');
  assert.equal('injected' in item, false);
});

test('duplicate IDs keep the last value', () => {
  const json = serializeBackup([ITEM, { ...ITEM, name: '新しい名前' }]);
  const items = parseBackup(json);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '新しい名前');
});

test('malformed files are rejected with a clear error', () => {
  assert.throws(() => parseBackup('not json'), /JSONファイルを読み取れませんでした/);
  assert.throws(() => parseBackup('{}'), /形式が正しくありません/);
  assert.throws(() => parseBackup(JSON.stringify({ items: [] })), /このアプリのバックアップファイルではありません/);

  const invalid = (item) => JSON.stringify({ format: 'receipt-expiry-backup', version: 1, items: [item] });
  assert.throws(() => parseBackup(invalid({ ...ITEM, storage: 'bogus' })), /保存場所が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, expiryDate: '2026-02-30' })), /賞味期限が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, createdAt: 'yesterday' })), /登録日時が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, id: '' })), /IDがありません/);
});
