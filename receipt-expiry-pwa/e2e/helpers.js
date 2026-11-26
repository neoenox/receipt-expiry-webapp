import { expect } from '@playwright/test';

/** 同意済みの空状態にしてテストを開始する。 */
export async function resetStorage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('ReceiptExpiryDB');
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('receipt-expiry-ad-consent', 'granted');
  });
  await page.reload();
  await expect(page.locator('#item-count')).toHaveText('0件');
}
