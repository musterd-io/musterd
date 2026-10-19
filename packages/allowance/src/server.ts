import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard } from './board.js';
import { percentCss } from './css.js';
import { renderPage } from './page.js';
import type { Board } from './types.js';

const FONTS = new Set(['recursive-linear.woff2', 'recursive-casual.woff2', 'recursive-mono.woff2']);

export interface StartOpts {
  port: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  fetchSub?: typeof fetch;
  /** Override the assets directory. Defaults to ../assets beside the compiled file. */
  assetsDir?: string;
}

function localHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-security-policy':
      "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Serve the page on 127.0.0.1 only. The provider key is read here and never written
 * into a response.
 */
export function start(opts: StartOpts): Promise<Server> {
  const assets = opts.assetsDir ?? fileURLToPath(new URL('../assets/', import.meta.url));
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetchSub = opts.fetchSub ?? fetch;
  let css: Promise<string> | undefined;
  const stylesheet = (): Promise<string> => {
    css ??= readFile(join(assets, 'allowance.css'), 'utf8').then((file) => file + percentCss());
    return css;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'could not read');
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!localHost(req.headers.host)) {
      send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      return;
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      return;
    }
    if (path === '/allowance.css') {
      const body = await stylesheet();
      send(res, 200, 'text/css; charset=utf-8', req.method === 'HEAD' ? '' : body);
      return;
    }
    if (path.startsWith('/fonts/')) {
      const name = path.slice('/fonts/'.length);
      if (!FONTS.has(name)) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      const bytes = await readFile(join(assets, 'fonts', name));
      res.writeHead(200, {
        'content-type': 'font/woff2',
        'content-length': bytes.length,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }
    if (path !== '/' && path !== '/api/board') {
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const signal = AbortSignal.timeout(5_000);
    let board: Board;
    try {
      board = await readBoard({ env, now: now(), timeZone, fetchSub, signal });
    } catch {
      send(res, 500, 'text/plain; charset=utf-8', 'could not read');
      return;
    }
    if (path === '/api/board') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(board));
      return;
    }
    send(res, 200, 'text/html; charset=utf-8', renderPage(board));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. A published page that bound every interface would hand the key's
    // results to anything that can open the port.
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
