import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVapidDetails, sendNotification } from 'web-push';
import { onRequestPost } from '../functions/api/analyze.js';
import { onRequestPost as onValidateKey } from '../functions/api/validate-key.js';
import { onRequestGet as onConfig } from '../functions/api/config.js';
import { onRequestPost as onMetrics } from '../functions/api/metrics.js';
import { onRequestPost as onPushSubscribe } from '../functions/api/push/subscribe.js';
import { onRequestPost as onPushUnsubscribe } from '../functions/api/push/unsubscribe.js';
import { onRequestGet as onPushConfig } from '../functions/api/push/config.js';
import { createKvAdapter } from './kv-adapter.js';
import { sendReminders } from '../functions/shared/reminder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || '/var/lib/receipt-expiry';
const KV = createKvAdapter(path.join(DATA_DIR, 'store.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function publicOrigin(request) {
  // X-Forwarded-Host はクライアントが偽装でき、Origin チェックの基準を
  // すり替えられるため使わない。Host とプロトのみから組み立てる。
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers.host;
  if (!host) throw new Error('Host header is missing');
  return `${proto}://${host}`;
}

function apiEnv() {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
    RATE_LIMIT_KV: KV,
    PUSH_KV: KV,
    SUPPORT_URL: process.env.SUPPORT_URL,
    ADSENSE_CLIENT_ID: process.env.ADSENSE_CLIENT_ID,
    ADSENSE_SLOT_ID: process.env.ADSENSE_SLOT_ID,
  };
}

/** 共通の API ハンドラ呼び出し。Request/Response を Node の res へ橋渡しする。 */
async function runApi(req, res, url, handler) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendText(res, 413, 'Payload Too Large');
      return;
    }
    chunks.push(chunk);
  }
  const request = new Request(url.href, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await handler({ request, env: apiEnv() });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function cacheControl(filePath) {
  if (filePath.endsWith('sw.js')) return 'no-cache';
  const ext = path.extname(filePath);
  if (['.html', '.js', '.css', '.json'].includes(ext)) return 'no-cache';
  return 'public, max-age=3600';
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const filePath = url.pathname === '/'
    ? path.join(ROOT, 'index.html')
    : path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': cacheControl(filePath),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
    // 拡張子のある静的ファイルはフォールバックせず404にする（SWがHTMLをJSとしてキャッシュするのを防ぐ）。
    if (path.extname(url.pathname)) {
      sendText(res, 404, 'Not Found');
      return;
    }
    try {
      const index = await fs.readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : index);
    } catch {
      sendText(res, 404, 'Not Found');
    }
  }
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, publicOrigin(req));
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const postRoutes = {
    '/api/analyze': onRequestPost,
    '/api/validate-key': onValidateKey,
    '/api/metrics': onMetrics,
    '/api/push/subscribe': onPushSubscribe,
    '/api/push/unsubscribe': onPushUnsubscribe,
  };
  if (postRoutes[url.pathname] && req.method === 'POST') {
    await runApi(req, res, url, postRoutes[url.pathname]);
    return;
  }

  const getRoutes = {
    '/api/config': onConfig,
    '/api/push/config': onPushConfig,
  };
  if (getRoutes[url.pathname] && req.method === 'GET') {
    const response = await getRoutes[url.pathname]({ env: apiEnv() });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }

  try {
    await handleStatic(req, res, url);
  } catch (error) {
    if (error instanceof URIError) {
      sendText(res, 400, 'Bad Request');
      return;
    }
    throw error;
  }
}

/** 同じプロセス・同じ KV インスタンスから通知を送る（マルチプロセス競合を避ける）。 */
async function runReminders() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return;
  setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@localhost', publicKey, privateKey);
  await sendReminders({
    kv: KV,
    sendNotification,
    vapid: { publicKey, privateKey },
    now: new Date(),
    listLimit: 200,
  });
}

function startReminderTimer() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log('[notify] VAPID keys not configured; reminders disabled');
    return;
  }
  // 起動直後にも1回走らせ、その後1分ごとに確認する。
  void runReminders().catch((error) => console.error('[notify]', error.message));
  setInterval(() => {
    void runReminders().catch((error) => console.error('[notify]', error.message));
  }, 60_000).unref();
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[server]', error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'リクエストを処理できませんでした。' } }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Receipt Expiry server listening on http://${HOST}:${PORT}`);
  startReminderTimer();
});
