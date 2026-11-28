import test from 'node:test';
import assert from 'node:assert/strict';
import { errorResponse } from '../functions/shared/http.js';
import { onRequestGet as getConfig } from '../functions/api/config.js';
import { onRequestGet as getPushConfig } from '../functions/api/push/config.js';

test('config endpoints use the shared JSON response contract', async () => {
  const config = await getConfig({
    env: {
      SUPPORT_URL: 'https://example.test/sponsors',
      ADSENSE_CLIENT_ID: 'ca-test',
      ADSENSE_SLOT_ID: 'slot-test',
    },
  });
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(config.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await config.json(), {
    supportUrl: 'https://example.test/sponsors',
    adsenseClient: 'ca-test',
    adsenseSlot: 'slot-test',
  });

  const defaults = await getConfig({ env: {} });
  assert.equal((await defaults.json()).supportUrl, 'https://github.com/sponsors/neoenox');

  const push = await getPushConfig({ env: { VAPID_PUBLIC_KEY: 'public-key' } });
  assert.equal(push.status, 200);
  assert.equal(push.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await push.json(), { publicKey: 'public-key' });
});

test('internal error response keeps the OCI 500 contract', async () => {
  const response = errorResponse(500, 'INTERNAL_ERROR', 'リクエストを処理できませんでした。');
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Retry-After'), null);
  assert.deepEqual(await response.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'リクエストを処理できませんでした。' },
  });
});
