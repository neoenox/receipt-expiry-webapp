import { test, expect } from '@playwright/test';

async function shellWidth(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('receipt-expiry-ad-consent', 'granted'));
  await page.reload();
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
