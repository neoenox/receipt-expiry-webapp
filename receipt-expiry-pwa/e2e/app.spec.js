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
    sessionStorage.clear();
    localStorage.setItem('receipt-expiry-ad-consent', 'granted');
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
  await expect(page.locator('#backup-reminder')).toBeHidden();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk.toString();
  const backup = JSON.parse(text);
  expect(backup.version).toBe(3);
  expect(backup.items).toHaveLength(1);
  expect(backup.history).toHaveLength(1);

  await page.keyboard.press('Escape');
  await resetStorage(page);
  await addItem(page, '一時', '2026-12-01');
  await page.click('#settings-btn');

  await page.click('[data-settings-tab="data"]');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.setInputFiles('#backup-input', {
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('#backup-status')).toContainText('在庫1件・履歴1件');
  expect(backup.shopping).toEqual([]);
  expect(backup.settings.theme).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page.locator('#item-count')).toHaveText('2件');
  await expect(page.locator('.item-name', { hasText: 'テスト牛乳' })).toBeVisible();
});


test('stale backup reminder appears and clears after exporting', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.evaluate(() => localStorage.setItem('receipt-expiry-last-backup', '2026-01-01T00:00:00Z'));
  await page.reload();

  await page.click('#settings-btn');
  await page.click('[data-settings-tab="data"]');
  await expect(page.locator('#backup-reminder')).toContainText('2026-01-01');

  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-backup-btn');
  await downloadPromise;
  await expect(page.locator('#backup-reminder')).toBeHidden();
});

test('multiple items can be selected and deleted at once', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', '2026-12-20');
  await addItem(page, '食パン', '2026-11-25');
  await addItem(page, '卵', '2026-12-01');

  await page.click('#select-mode-btn');
  await expect(page.locator('#bulk-actions')).toBeVisible();
  await expect(page.locator('.item-select')).toHaveCount(3);

  await page.locator('.item-card').nth(0).click();
  await page.locator('.item-card').nth(2).click();
  await expect(page.locator('.item-select input:checked')).toHaveCount(2);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.click('#bulk-delete-btn');
  await expect(page.locator('#item-count')).toHaveText('1件');
  await expect(page.locator('.item-name')).toHaveText('卵');
  await expect(page.locator('#bulk-actions')).toBeHidden();
});

test('offline analysis is queued and retried after reconnection', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);

  // ネットワーク切断を明示的に注入し、ローカルサーバーが生きていても
  // 解析リクエストが確実に失敗するようにする。
  await page.route('**/api/analyze', (route) => route.abort('internetdisconnected'));
  await page.context().setOffline(true);
  await page.setInputFiles('#gallery-input', ICON_PATH);

  await expect(page.locator('#preview-modal')).toBeVisible();
  await page.click('#preview-confirm');
  await expect(page.locator('#toast')).toContainText('接続が戻ったら読み取ります');

  await page.click('#settings-btn');

  await page.click('[data-settings-tab="notify"]');
  await expect(page.locator('#queue-status')).toContainText('まだ読み取っていないレシート: 1件');
  await expect(page.locator('.queue-row')).toHaveCount(1);

  await page.unroute('**/api/analyze');
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

  await expect(page.locator('#queue-status')).toContainText('読み取っていないレシートはありません');
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
  await expect(page.locator('#api-key-status')).toContainText('このセッションでのみ使用');
  expect(await page.evaluate(() => localStorage.getItem('receipt-expiry-gemini-key'))).toBeNull();
  await page.reload();
  await page.click('#settings-btn');
  await page.click('[data-settings-tab="data"]');
  await expect(page.locator('#api-key-status')).toContainText('共通キーで読み取ります');
});

test('BYOK key can be kept for the tab when requested', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.route('**/api/validate-key', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.click('#settings-btn');
  await page.click('[data-settings-tab="data"]');
  await page.check('#save-api-key-session');
  await page.fill('#api-key-input', 'kept-key');
  await page.click('#save-api-key');
  await expect(page.locator('#api-key-status')).toContainText('このタブを閉じるまで保持');

  await page.reload();
  await page.click('#settings-btn');
  await page.click('[data-settings-tab="data"]');
  await expect(page.locator('#api-key-status')).toContainText('このタブを閉じるまで保持');
  expect(await page.evaluate(() => localStorage.getItem('receipt-expiry-gemini-key'))).toBeNull();
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
    const subscription = {
      endpoint: 'https://example.test/e2e',
      keys: { p256dh: 'AAA', auth: 'BBB' },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
      unsubscribe: async () => true,
    };
    PushManager.prototype.subscribe = async () => subscription;
    // 実際のブラウザと同じく、subscribe 後は getSubscription が購読を返す。
    PushManager.prototype.getSubscription = async () => subscription;
  });
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', '2026-12-20');

  // 実 API（OCI サーバー）の push ルートを使い、購読が保存されることを確認する。
  const subscribeRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/push/subscribe') && request.method() === 'POST') {
      subscribeRequests.push(JSON.parse(request.postData() || '{}'));
    }
  });

  await page.click('#settings-btn');
  await page.click('[data-settings-tab="notify"]');
  await page.click('#notify-enable-btn');
  await expect(page.locator('#notify-status')).toContainText('通知を有効にしています');
  await expect.poll(() => subscribeRequests.length).toBeGreaterThan(0);
  expect(subscribeRequests[0].subscription.endpoint).toBe('https://example.test/e2e');
  expect(subscribeRequests[0].expiryDates).toContain('2026-12-20');

  await page.selectOption('#notify-hour', '8');
  await expect(page.locator('#notify-status')).toContainText('08:00');
  await expect.poll(() => subscribeRequests.at(-1)?.notifyHour).toBe(8);
});


test('multiple receipts are previewed and merged into one result', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.route('**/api/analyze', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      purchaseDate: '2026-11-23',
      items: [{ name: '牛乳', storage: 'fridge', expiryDate: '2026-12-01', quantity: '' }],
    }),
  }));

  await page.setInputFiles('#gallery-input', [ICON_PATH, ICON_PATH]);
  await expect(page.locator('#preview-progress')).toHaveText('1/2');
  await page.click('#preview-confirm');
  await expect(page.locator('#preview-progress')).toHaveText('2/2');
  await page.click('#preview-confirm');
  await expect(page.locator('#result-items .result-row')).toHaveCount(2);
});

test('preview rotation and crop sliders update the canvas', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.setInputFiles('#gallery-input', ICON_PATH);
  await expect(page.locator('#preview-modal')).toBeVisible();

  const before = await page.evaluate(() => document.querySelector('#preview-image').toDataURL());
  await page.click('#preview-rotate');
  await expect.poll(() => page.evaluate(() => document.querySelector('#preview-image').toDataURL()))
    .not.toBe(before);

  const rotated = await page.evaluate(() => document.querySelector('#preview-image').toDataURL());
  await page.locator('#crop-left').fill('20');
  await expect.poll(() => page.evaluate(() => document.querySelector('#preview-image').toDataURL()))
    .not.toBe(rotated);
});

test('duplicate results are unselected and only selected rows are saved', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', '2026-12-01');

  await page.route('**/api/analyze', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      purchaseDate: '2026-11-23',
      items: [
        { name: '牛乳', storage: 'fridge', expiryDate: '2026-12-01', quantity: '' },
        { name: 'パン', storage: 'pantry', expiryDate: '2026-11-30', quantity: '' },
      ],
    }),
  }));

  await page.setInputFiles('#gallery-input', ICON_PATH);
  await page.click('#preview-confirm');

  const rows = page.locator('#result-items .result-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.row-notice')).toContainText('在庫に同じ食材');
  await expect(rows.nth(0).locator('.field-selected')).not.toBeChecked();
  await expect(rows.nth(1).locator('.field-selected')).toBeChecked();
  await expect(page.locator('#result-summary')).toContainText('2件中 1件を登録します');

  await page.click('#result-save');
  await expect(page.locator('#item-count')).toHaveText('2件');
  await expect(page.locator('.item-name', { hasText: 'パン' })).toBeVisible();
});

test('selecting a duplicate result adds to the existing quantity', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', '2026-12-01');
  await page.click('.item-card-main');
  await page.fill('#edit-quantity', '2本');
  await page.click('#edit-form button[type="submit"]');

  await page.route('**/api/analyze', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      purchaseDate: '2026-11-23',
      items: [{ name: '牛乳', storage: 'fridge', expiryDate: '2026-12-01', quantity: '1本' }],
    }),
  }));

  await page.setInputFiles('#gallery-input', ICON_PATH);
  await page.click('#preview-confirm');
  const row = page.locator('#result-items .result-row');
  await expect(row.locator('.field-selected')).not.toBeChecked();
  await row.locator('.field-selected').check();
  await page.click('#result-save');

  await expect(page.locator('#item-count')).toHaveText('1件');
  await expect(page.locator('.item-quantity')).toHaveText('2本 + 1本');
});

test('shopping list suggestions come from consumed items', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', '2026-12-20');
  await page.click('.item-card-main');
  await page.click('#edit-delete');
  await page.click('#consume-eaten');
  await expect(page.locator('#item-count')).toHaveText('0件');

  await page.click('#shopping-btn');
  await expect(page.locator('#shopping-suggestions')).toContainText('牛乳');
  await page.click('#shopping-suggestions button');
  await expect(page.locator('#shopping-items')).toContainText('牛乳');
  await page.click('#shopping-items button[data-add]');
  await page.click('#shopping-close');
  await expect(page.locator('.item-name')).toHaveText('牛乳');
  await expect(page.locator('.item-card')).toContainText('冷蔵');
});

test('calendar view groups items by expiry date and advances one month per click', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await addItem(page, '牛乳', `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-05`);
  await page.click('#view-toggle');
  await expect(page.locator('#calendar-view')).toBeVisible();
  await expect(page.locator('#calendar-view')).toContainText('牛乳');

  const label = page.locator('#calendar-view .calendar-header strong');
  const before = await label.textContent();
  await page.locator('[data-calendar="next"]').click();
  const after = await label.textContent();
  const [year, month] = before.match(/(\d+)年 (\d+)月/).slice(1).map(Number);
  const expectedMonth = month === 12 ? 1 : month + 1;
  const expectedYear = month === 12 ? year + 1 : year;
  expect(after).toBe(`${expectedYear}年 ${expectedMonth}月`);

  await page.click('#view-toggle');
  await expect(page.locator('#item-list')).toBeVisible();
});


test('support tab exposes sponsor link and ad status', async ({ page }) => {
  await page.goto('/');
  await resetStorage(page);
  await page.click('#settings-btn');
  await page.click('[data-settings-tab="support"]');
  await expect(page.locator('#support-link')).toHaveAttribute('href', 'https://github.com/sponsors/neoenox');
  await expect(page.locator('#ad-status')).toContainText('広告');
});


test('ad consent is required before ads load', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('receipt-expiry-ad-consent'));
  await page.reload();
  await expect(page.locator('#ad-consent')).toBeVisible();
  await page.click('#ad-consent-decline');
  await expect(page.locator('#ad-consent')).toBeHidden();
  await expect(page.locator('#ad-status')).toContainText('無効');
});
