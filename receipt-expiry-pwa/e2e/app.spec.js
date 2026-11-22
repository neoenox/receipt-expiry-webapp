import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const ICON_PATH = fileURLToPath(new URL('../public/icons/icon-192.png', import.meta.url));

async function resetStorage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('ReceiptExpiryDB');
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });
    localStorage.clear();
  });
  await page.reload();
  await expect(page.locator('#item-count')).toHaveText('0件');
}

async function addItem(page, name, expiry) {
  await page.click('#add-btn');
  await page.fill('#edit-name', name);
  await page.fill('#edit-expiry', expiry);
  await page.click('#edit-form button[type="submit"]');
  await expect(page.locator('.item-name', { hasText: name })).toBeVisible();
}

test('inventory add, search, sort, consume, and backup round-trip', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);

  await addItem(page, 'テスト牛乳', '2026-12-20');
  await addItem(page, '食パン', '2026-11-25');
  await expect(page.locator('#item-count')).toHaveText('2件');

  await page.fill('#search-input', '牛乳');
  await expect(page.locator('.item-card')).toHaveCount(1);
  await expect(page.locator('.item-name')).toHaveText('テスト牛乳');
  await page.fill('#search-input', '');

  await page.selectOption('#sort-select', 'name');
  await expect(page.locator('.item-name').first()).toHaveText('テスト牛乳');

  await page.click('.item-card:has-text("食パン") .item-card-main');
  await page.click('#edit-delete');
  await expect(page.locator('#consume-item')).toContainText('食パン');
  await page.click('#consume-eaten');
  await expect(page.locator('#item-count')).toHaveText('1件');

  await page.click('#settings-btn');
  await expect(page.locator('#history-summary')).toContainText('食べた 1件');

  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-backup-btn');
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk.toString();
  const backup = JSON.parse(text);
  expect(backup.version).toBe(2);
  expect(backup.items).toHaveLength(1);
  expect(backup.history).toHaveLength(1);

  await page.keyboard.press('Escape');
  await resetStorage(page);
  await addItem(page, '一時', '2026-12-01');
  await page.click('#settings-btn');
  await page.setInputFiles('#backup-input', {
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('#backup-status')).toContainText('在庫1件・履歴1件');
  await page.keyboard.press('Escape');
  await expect(page.locator('#item-count')).toHaveText('2件');
  await expect(page.locator('.item-name', { hasText: 'テスト牛乳' })).toBeVisible();
});


test('offline analysis is queued and retried after reconnection', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);

  await page.context().setOffline(true);
  await page.setInputFiles('#gallery-input', ICON_PATH);
  await expect(page.locator('#toast')).toContainText('オフラインです');

  await page.click('#settings-btn');
  await expect(page.locator('#queue-status')).toContainText('未送信の解析: 1件');
  await expect(page.locator('.queue-row')).toHaveCount(1);

  await page.route('**/api/analyze', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      purchaseDate: '2026-11-23',
      items: [{ name: 'キュー牛乳', storage: 'fridge', expiryDate: '2026-12-01', quantity: '' }],
    }),
  }));
  await page.context().setOffline(false);
  await expect(page.locator('#result-modal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#result-items .field-name')).toHaveValue('キュー牛乳');

  await page.keyboard.press('Escape');

  await expect(page.locator('#queue-status')).toContainText('未送信の解析はありません');
});
