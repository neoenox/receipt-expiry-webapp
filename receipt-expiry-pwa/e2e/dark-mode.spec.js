import { test, expect } from '@playwright/test';

function parseRgb(value) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]) {
  const channels = [r, g, b].map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const fg = parseRgb(foreground);
  const bg = parseRgb(background);
  if (!fg || !bg) return 0;
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

async function addItem(page) {
  await page.click('#add-btn');
  await page.fill('#edit-name', 'テスト牛乳');
  await page.fill('#edit-expiry', '2026-12-20');
  await page.click('#edit-form button[type="submit"]');
  await expect(page.locator('.item-card')).toHaveCount(1);
}

async function styles(page, selector, pseudo = null) {
  return page.evaluate(({ selector, pseudo }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const computed = getComputedStyle(el, pseudo);
    return { color: computed.color, background: computed.backgroundColor };
  }, { selector, pseudo });
}

test('dark theme keeps key text readable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  // 広告同意のオーバーレイが操作を遮らないように先に同意を設定する。
  await page.evaluate(() => localStorage.setItem('receipt-expiry-ad-consent', 'granted'));
  await page.reload();
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('ReceiptExpiryDB');
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
  });
  await page.reload();
  await addItem(page);

  const name = await styles(page, '.item-name');
  const card = await styles(page, '.item-card');
  expect(contrast(name.color, card.background)).toBeGreaterThanOrEqual(4.5);

  const badge = await styles(page, '.badge');
  expect(contrast(badge.color, badge.background)).toBeGreaterThanOrEqual(4.5);

  const primary = await styles(page, '.btn.is-primary');
  expect(contrast(primary.color, primary.background)).toBeGreaterThanOrEqual(4.5);

  const placeholder = await styles(page, '.search-input', '::placeholder');
  const input = await styles(page, '.search-input');
  expect(contrast(placeholder.color, input.background)).toBeGreaterThanOrEqual(4.5);

  await page.click('#settings-btn');
  const tabBar = await styles(page, '.settings-tabs');
  const inactiveTab = await styles(page, '.settings-tab:not(.is-active)');
  expect(contrast(inactiveTab.color, tabBar.background)).toBeGreaterThanOrEqual(4.5);
});

test('theme can be switched and persists across reloads', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('receipt-expiry-ad-consent', 'granted'));
  await page.reload();
  await page.click('#settings-btn');

  await page.selectOption('#theme-select', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.click('#settings-btn');
  await page.selectOption('#theme-select', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.selectOption('#theme-select', 'auto');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});
