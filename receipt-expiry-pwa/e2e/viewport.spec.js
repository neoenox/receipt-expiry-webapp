import { test, expect } from '@playwright/test';
import { resetStorage } from './helpers.js';

async function shellWidth(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await resetStorage(page);
  return page.evaluate(() => Math.round(document.querySelector('.app-shell').getBoundingClientRect().width));
}

test('app shell stays narrow below 900px and widens at 900px', async ({ page }) => {
  const narrow = await shellWidth(page, 899);
  const wide = await shellWidth(page, 900);

  // 900px 未満は従来どおり 560px の中央配置。900px 以上で PC 用の広いレイアウト。
  expect(narrow).toBeLessThanOrEqual(560);
  expect(wide).toBeGreaterThan(560);
  expect(wide).toBeGreaterThan(narrow);
});

test('consent banner leaves the scan button reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#ad-consent')).toBeVisible();

  const overlap = await page.evaluate(() => {
    const banner = document.querySelector('#ad-consent').getBoundingClientRect();
    const scan = document.querySelector('#scan-btn').getBoundingClientRect();
    return Math.max(0, Math.min(banner.bottom, scan.bottom) - Math.max(banner.top, scan.top));
  });
  expect(overlap).toBe(0);

  await page.click('#scan-btn');
  await expect(page.locator('#source-modal')).not.toHaveClass(/hidden/);
});

test('calendar keeps a long item name within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await resetStorage(page);

  await page.click('#add-btn');
  await page.fill('#edit-name', '特濃牛乳 1000ml（Sep市陽向スーパー）');
  await page.fill('#edit-expiry', '2026-12-02');
  await page.click('#edit-form button[type="submit"]');
  await expect(page.locator('.item-card')).toHaveCount(1);

  await page.click('#select-mode-btn');
  const bulkHeight = await page.locator('#bulk-delete-btn').evaluate((el) => el.getBoundingClientRect().height);
  expect(bulkHeight).toBeLessThanOrEqual(48);
  await page.click('#bulk-cancel-btn');

  await page.click('#view-toggle');
  await expect(page.locator('#calendar-view')).not.toHaveClass(/hidden/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
