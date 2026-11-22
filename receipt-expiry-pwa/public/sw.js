const CACHE_PREFIX = 'receipt-expiry-';
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/settings.js',
  '/js/queueUI.js',
  '/js/db.js',
  '/js/backup.js',
  '/js/queue.js',
  '/js/inventory.js',
  '/js/history.js',
  '/js/learning.js',
  '/js/imageOptions.js',
  '/js/dates.js',
  '/js/imageProcessor.js',
  '/js/apiClient.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// HTML/JS/CSS は Network First にして、デプロイ後に古い版が固定されないようにする。
const NETWORK_FIRST = new Set(['/', '/index.html', '/manifest.json', '/sw.js', '/css/style.css']);
const NETWORK_FIRST_PREFIXES = ['/js/', '/css/'];

function isNetworkFirst(url) {
  return NETWORK_FIRST.has(url.pathname)
    || NETWORK_FIRST_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function putInCache(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(request, response);
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const index = await caches.match('/index.html');
      if (index) return index;
    }
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    await putInCache(request, response);
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 1つの取得失敗でインストール全体が失敗しないように個別に例外を吸収する。
      .then((cache) => Promise.all(STATIC_ASSETS.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // APIは常にネットワーク経由。オフライン時はアプリ側でエラー表示する。
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(isNetworkFirst(url) ? networkFirst(request) : cacheFirst(request));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // ペイロードがJSONでない場合は既定の文言を使う。
  }
  event.waitUntil(self.registration.showNotification(payload.title || 'レシート賞味期限', {
    body: payload.body || '賞味期限を確認してください。',
    icon: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
