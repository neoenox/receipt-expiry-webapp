import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // CI にシステム Chrome は入っていないため、Playwright 同梱 Chromium を使う。
    headless: true,
  },
  webServer: {
    command: 'node oci/server.js',
    url: 'http://127.0.0.1:4173',
    env: {
      PORT: '4173',
      // 実 API の push フローを検証するため、テスト用の VAPID 公開鍵を渡す。
      VAPID_PUBLIC_KEY: 'BBH70Vd1epc-FBv8gqa8ZrwgLMcXqJMq4eTHzloq7NW_9oBkqriptpJ100zUK_7oDv9Pb6_qLE64gxPtIJObuFk',
      DATA_DIR: process.env.TMPDIR || '/tmp',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
