import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../functions/api/analyze.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, publicOrigin(req));

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(url.href, {
      method: 'POST',
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    try {
      const response = await onRequestPost({
        request,
        env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY || '' },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('[analyze]', error);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '解析処理でエラーが発生しました。' } }));
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let filePath = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
  if (url.pathname === '/') filePath = path.join(ROOT, 'index.html');
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    // SPAのクライアントルートはindex.htmlにフォールバックする。
    try {
      const index = await fs.readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(req.method === 'HEAD' ? undefined : index);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Receipt Expiry server listening on http://${HOST}:${PORT}`);
});
