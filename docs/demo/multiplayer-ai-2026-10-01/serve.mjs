#!/usr/bin/env node
// Serve the deck and cheat sheet so editor.js can save straight back to the file (no file picker).
//
//   node docs/demo/multiplayer-ai-2026-10-01/serve.mjs      → http://localhost:4860/
//
// Serves the repo read-only (the deck's fonts and logos live under packages/), listens on
// 127.0.0.1 only, and accepts one write: POST /__save?path=<an existing .html in THIS folder>.
// The write needs the X-Page-Editor header, which a page on any other origin cannot send without
// a CORS preflight this server never answers. Node built-ins only.
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const port = Number(process.env.PORT) || 4860;
const rel = path.relative(root, here).split(path.sep).join('/');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

// a URL path → a file under root, or null if it escapes
function resolve(urlPath) {
  const p = path.resolve(root, '.' + decodeURIComponent(urlPath));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 4 * 1024 * 1024) throw new Error('too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/__save') {
      if (req.method !== 'POST' || req.headers['x-page-editor'] !== '1') return void res.writeHead(403).end();
      const origin = req.headers.origin;
      if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`)
        return void res.writeHead(403).end();
      const file = resolve(url.searchParams.get('path') || '');
      if (!file || path.dirname(file) !== here || path.extname(file) !== '.html') return void res.writeHead(403).end();
      await stat(file); // only an existing page; never creates one
      const text = await body(req);
      await writeFile(file, text, 'utf8');
      console.log(`saved ${path.relative(root, file)} (${text.length} chars)`);
      return void res.writeHead(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    if (url.pathname === '/') {
      res.writeHead(302, { location: `/${rel}/deck.html` });
      return void res.end();
    }
    const file = resolve(url.pathname);
    if (!file || !(await stat(file)).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (err) {
    if (!res.headersSent) res.writeHead(err && err.code === 'ENOENT' ? 404 : 500);
    res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`deck:        http://localhost:${port}/${rel}/deck.html`);
  console.log(`cheat sheet: http://localhost:${port}/${rel}/cheatsheet.html`);
  console.log('E to edit, ⌘S saves straight to the file. Ctrl-C to stop.');
});
