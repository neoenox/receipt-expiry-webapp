import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: 'node oci/server.js',
    url: 'http://127.0.0.1:4173',
    env: { PORT: '4173' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
