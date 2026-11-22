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
  await page.click('[data-settings-tab="data"]');

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

  await page.click('[data-settings-tab="data"]');
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

  await page.click('[data-settings-tab="notify"]');
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


test('BYOK key is validated before it is stored', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.route('**/api/validate-key', (route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INVALID_KEY' } }),
  }));
  await page.click('#settings-btn');

  await page.click('[data-settings-tab="data"]');

  expect(await page.locator('[data-settings-panel]:visible').count()).toBe(1);
  await page.fill('#api-key-input', 'bad-key');
  await page.click('#save-api-key');
  await expect(page.locator('#api-key-status')).toContainText('無効です');
  expect(await page.evaluate(() => localStorage.getItem('receipt-expiry-gemini-key'))).toBeNull();

  await page.unroute('**/api/validate-key');
  await page.route('**/api/validate-key', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.fill('#api-key-input', 'valid-key');
  await page.click('#save-api-key');
  await expect(page.locator('#api-key-status')).toContainText('保存しました');
  expect(await page.evaluate(() => localStorage.getItem('receipt-expiry-gemini-key'))).toBe('valid-key');
});

test('dark mode changes the page background', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await resetStorage(page);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe('rgb(243, 246, 245)');
});

test('notification opt-in succeeds with a subscribed push manager', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.subscribe = async () => ({
      endpoint: 'https://example.test/e2e',
      keys: { p256dh: 'AAA', auth: 'BBB' },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
      unsubscribe: async () => true,
    });
    PushManager.prototype.getSubscription = async () => null;
  });
  await page.goto('/');
  await resetStorage(page);
  await page.route('**/api/push/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/push/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      publicKey: 'BBH70Vd1epc-FBv8gqa8ZrwgLMcXqJMq4eTHzloq7NW_9oBkqriptpJ100zUK_7oDv9Pb6_qLE64gxPtIJObuFk',
    }),
  }));
  await page.click('#settings-btn');

  await page.click('[data-settings-tab="notify"]');
  await page.click('#notify-enable-btn');
  await expect(page.locator('#notify-status')).toContainText('通知を有効にしています');
});
