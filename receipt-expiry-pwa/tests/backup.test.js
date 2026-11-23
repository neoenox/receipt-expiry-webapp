import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBackup, parseBackup, normalizeLastBackup, isBackupStale, formatLastBackupDate } from '../public/js/backup.js';

const ITEM = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: '特濃牛乳',
  storage: 'fridge',
  expiryDate: '2026-11-29',
  purchaseDate: '2026-11-22',
  quantity: '1本',
  createdAt: 1795334400000,
};
const HISTORY = {
  id: 'history-1', name: '特濃牛乳', storage: 'fridge', expiryDate: '2026-11-29',
  quantity: '1本', reason: 'eaten', consumedAt: 1795334500000,
};
const HINT = { name: '特濃牛乳', expiryDate: '2026-12-05', updatedAt: 1795334600000 };

test('backup round-trip preserves items, history, and hints', () => {
  const json = serializeBackup({ items: [ITEM], history: [HISTORY], hints: [HINT] });
  const data = JSON.parse(json);
  assert.equal(data.format, 'receipt-expiry-backup');
  assert.equal(data.version, 3);
  assert.ok(data.exportedAt);
  const parsed = parseBackup(json);
  assert.deepEqual(parsed.items, [ITEM]);
  assert.deepEqual(parsed.history, [HISTORY]);
  assert.deepEqual(parsed.hints, [HINT]);
  assert.deepEqual(parsed.shopping, []);
  assert.deepEqual(parsed.settings, { theme: 'auto', notifyHour: 6, notifyEnabled: false });
});

test('legacy item-only backups still parse', () => {
  const json = serializeBackup([ITEM]);
  assert.deepEqual(parseBackup(json).items, [ITEM]);
});

test('backup strips unknown fields and fills optional fields', () => {
  const json = serializeBackup([{
    ...ITEM,
    purchaseDate: undefined,
    quantity: undefined,
    injected: 'should be dropped',
  }]);
  const { items } = parseBackup(json);
  assert.equal(items[0].purchaseDate, null);
  assert.equal(items[0].quantity, '');
  assert.equal('injected' in items[0], false);
});

test('duplicate IDs keep the last value', () => {
  const json = serializeBackup({ items: [ITEM, { ...ITEM, name: '新しい名前' }] });
  const { items } = parseBackup(json);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '新しい名前');
});

test('backup staleness is based on the recorded export time', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  assert.equal(normalizeLastBackup('2026-11-20T12:00:00Z'), '2026-11-20T12:00:00.000Z');
  assert.equal(normalizeLastBackup('not-a-date'), null);

  assert.equal(isBackupStale('2026-11-22T00:00:00Z', now), false);
  assert.equal(isBackupStale('2026-11-16T00:00:00Z', now), true);
  assert.equal(isBackupStale(null, now), true);
  assert.equal(isBackupStale('bad', now), true);
  assert.equal(formatLastBackupDate('2026-11-20T12:00:00Z'), '2026-11-20');
});

test('malformed files and invalid history are rejected', () => {
  assert.throws(() => parseBackup('not json'), /JSONファイルを読み取れませんでした/);
  assert.throws(() => parseBackup('{}'), /形式が正しくありません/);
  assert.throws(() => parseBackup(JSON.stringify({ items: [] })), /このアプリのバックアップファイルではありません/);
  assert.throws(() => parseBackup(JSON.stringify({
    format: 'receipt-expiry-backup', items: [], history: [{ ...HISTORY, reason: 'bad' }],
  })), /履歴1行目の種別が不正/);

  const invalid = (item) => JSON.stringify({ format: 'receipt-expiry-backup', items: [item] });
  assert.throws(() => parseBackup(invalid({ ...ITEM, storage: 'bogus' })), /保存場所が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, expiryDate: '2026-02-30' })), /賞味期限が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, createdAt: 'yesterday' })), /登録日時が不正/);
  assert.throws(() => parseBackup(invalid({ ...ITEM, id: '' })), /IDがありません/);
});
