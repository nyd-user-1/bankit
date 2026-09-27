// Local dev server: static files + the api/*.js handlers, no Vercel needed.
//   node scripts/dev-server.mjs          (PORT env overrides 3000)
// Handlers are Vercel-style (req, res) functions; this adds the bits they rely on —
// req.query, a parsed req.body, res.status(), res.json().
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { attachRelay } from './singit-relay.mjs';
import { attachChat } from './chat-server.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

async function handleApi(req, res, url) {
  const name = url.pathname.slice('/api/'.length).replace(/\/$/, '');
  const file = path.join(ROOT, 'api', name + '.js');
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  req.query = Object.fromEntries(url.searchParams);
  req.body = await readBody(req);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (b) => { res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)); return res; };
  // fresh api/ modules on every request, so handler edits apply without a restart
  const apiDir = path.join(ROOT, 'api') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(apiDir)) delete require.cache[k];
  try {
    await require(file)(req, res);
  } catch (e) {
    console.error(`api/${name} crashed:`, e);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
}

function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  const blocked = rel.split('/').some((p) => p.startsWith('.')) || rel.startsWith('/api/') || rel.startsWith('/node_modules/');
  if (!file.startsWith(ROOT) || blocked || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const t = Date.now();
  res.on('finish', () => {
    if (url.pathname.startsWith('/api/')) console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} ${Date.now() - t}ms`);
  });
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else handleStatic(req, res, url);
});
attachRelay(server);   // game rooms on ws://…/ws
attachChat(server);    // the platform chat on ws://…/chat
server.listen(PORT, () => console.log(`Bank It dev server → http://localhost:${PORT}`));
