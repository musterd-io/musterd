#!/usr/bin/env node
// Serve the Demo Day deck so editor.js can save straight back to deck.html, and so the page can
// export BP_musterd.pdf with one key.
//
//   node docs/demo/demo-day-2026-10-09/serve.mjs      → http://localhost:4861/
//
// Serves the repo read-only, listens on 127.0.0.1 only, and accepts two writes, both needing the
// X-Page-Editor header that a page on another origin cannot send without a CORS preflight this
// server never answers:
//   POST /__save?path=<an existing .html in THIS folder>   edits from the editor
//   POST /__pdf?path=<an existing .html in THIS folder>    prints that page with headless Chrome
// The PDF goes to $PDF_OUT (default ~/Downloads/musterd_DemoDay) as BP_musterd.pdf. Node built-ins only.
import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const port = Number(process.env.PORT) || 4861;
const rel = path.relative(root, here).split(path.sep).join('/');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pdfDir = process.env.PDF_OUT || path.join(homedir(), 'Downloads', 'musterd_DemoDay');
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

// a write request from this origin only, for an existing .html in this folder
function guarded(req, url) {
  if (req.method !== 'POST' || req.headers['x-page-editor'] !== '1') return null;
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return null;
  const file = resolve(url.searchParams.get('path') || '');
  if (!file || path.dirname(file) !== here || path.extname(file) !== '.html') return null;
  return file;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/__save') {
      const file = guarded(req, url);
      if (!file) return void res.writeHead(403).end();
      await stat(file); // only an existing page; never creates one
      const text = await body(req);
      await writeFile(file, text, 'utf8');
      console.log(`saved ${path.relative(root, file)} (${text.length} chars)`);
      return void res.writeHead(204).end();
    }
    if (url.pathname === '/__pdf') {
      const file = guarded(req, url);
      if (!file) return void res.writeHead(403).end();
      await stat(file);
      await mkdir(pdfDir, { recursive: true });
      const out = path.join(pdfDir, 'BP_musterd.pdf');
      await new Promise((ok, fail) =>
        execFile(
          chrome,
          ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, '--virtual-time-budget=2000', `file://${file}`],
          { timeout: 60000 },
          (err) => (err ? fail(err) : ok()),
        ),
      );
      console.log(`pdf ${out}`);
      return void json(res, 200, { file: out });
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
    if (res.headersSent) return void res.end();
    if (url.pathname === '/__pdf') return void json(res, 500, { error: String((err && err.message) || err).slice(0, 200) });
    res.writeHead(err && err.code === 'ENOENT' ? 404 : 500);
    res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`deck: http://localhost:${port}/${rel}/deck.html`);
  console.log('E edit · M move · ⌘S save to the file · D export BP_musterd.pdf · ←/→ slides. Ctrl-C to stop.');
});
