import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../functions/api/analyze.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 3 * 1024 * 1024;

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
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  return `${proto}://${host}`;
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

async function handleAnalyze(req, res, url) {
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
    method: 'POST',
    headers: req.headers,
    body: Buffer.concat(chunks),
  });
  const response = await onRequestPost({
    request,
    env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY || '' },
  });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
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

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    await handleAnalyze(req, res, url);
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
});
