import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_TYPES,
  STORAGE_LABELS,
  CONSUMPTION_REASONS,
  THEMES,
  DEFAULT_NOTIFY_HOUR,
} from '../public/js/domain.js';

test('browser domain values keep the existing external contract', () => {
  assert.deepEqual([...STORAGE_TYPES], ['fridge', 'freezer', 'pantry']);
  assert.deepEqual(STORAGE_LABELS, { fridge: '冷蔵', freezer: '冷凍', pantry: '常温' });
  assert.deepEqual([...CONSUMPTION_REASONS], ['eaten', 'discarded']);
  assert.deepEqual([...THEMES], ['auto', 'light', 'dark']);
  assert.equal(DEFAULT_NOTIFY_HOUR, 6);
});
