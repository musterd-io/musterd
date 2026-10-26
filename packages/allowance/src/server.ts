import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cursorAccountKey,
  elevenAccountKey,
  museAccountKey,
  openaiAccountKey,
} from './accountKey.js';
import { readBoard, type ReadDeps } from './board.js';
import { claudeSignInFromKeychain, resolveClaudeSignIn } from './claude.js';
import { codexSession } from './codex.js';
import { loadSelection, saveSelection, selectionFromForm } from './config.js';
import { percentCss } from './css.js';
import { cursorTokenFromKeychain, resolveCursorToken } from './cursor.js';
import { renderPage } from './page.js';
import { publishAllowance } from './post.js';
import { allowanceSnapshot, type AccountMaterial } from './snapshot.js';
import type { Board } from './types.js';

const FONTS = new Set(['dm-sans-latin.woff2', 'jetbrains-mono-latin.woff2']);
const BODY_LIMIT = 4096;

export interface StartOpts {
  port: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  fetchSub?: typeof fetch;
  /** Override the assets directory. Defaults to ../assets beside the compiled file. */
  assetsDir?: string;
  /** Selection file. Defaults to ~/.allowance/config.json. */
  configPath?: string;
  /**
   * Codex auth file. Defaults to ~/.codex/auth.json.
   * Null skips the file, so a test never reads a home directory.
   */
  codexAuthPath?: string | null;
  /** Claude Code credentials. Defaults to ~/.claude/.credentials.json. Null skips the file. */
  claudeCredentialPath?: string | null;
  /**
   * Claude access token. Undefined reads the env, the credentials file, then the macOS keychain.
   * Null skips all of those, so a test never reads a sign-in. The plan comes from the same body.
   */
  claudeToken?: string | null;
  /** Cursor auth.json. Defaults to ~/.cursor/auth.json. Null skips the file. */
  cursorAuthPath?: string | null;
  /**
   * Cursor access token. Undefined reads the file, then the macOS keychain.
   * Null skips both, so a test never reads a sign-in.
   */
  cursorToken?: string | null;
  /**
   * Muse auth.json. Defaults to `MUSE_AUTH_PATH` or `~/.config/muse/auth.json`.
   * Null skips the file, so a test never reads a home directory.
   */
  museAuthPath?: string | null;
  /** Override the Muse CLI read. Tests pass this so they do not spawn `muse`. */
  readMuse?: ReadDeps['readMuse'];
}

const SAVE_REFUSED = 'That save did not come from this page.';

function localHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  if (value === undefined) return undefined;
  return '';
}

function loopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * The page sets Referrer-Policy: no-referrer, so a browser's own form sends
 * Origin: null and Sec-Fetch-Site: same-origin. A foreign origin, or a
 * cross-site fetch, is refused.
 */
function saveFromThisPage(req: IncomingMessage): boolean {
  const origin = oneHeader(req.headers.origin);
  const site = oneHeader(req.headers['sec-fetch-site']);
  if (origin === '' || site === '') return false;
  if (site === 'cross-site') return false;
  if (origin === 'null') return site === 'same-origin' || site === 'none';
  if (origin !== undefined && !loopbackOrigin(origin)) return false;
  return site === undefined || site === 'same-origin' || site === 'none' || site === 'same-site';
}

const SECURITY = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  referrer: 'no-referrer',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY, 'content-type': type });
  res.end(body);
}

function redirectHome(res: ServerResponse): void {
  res.writeHead(303, { ...SECURITY, location: '/', 'content-type': 'text/plain; charset=utf-8' });
  res.end('');
}

async function readJson(path: string | null): Promise<unknown> {
  if (path === null) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serve the page on 127.0.0.1 only. A sign-in is read here and never written
 * into a response.
 */
export function start(opts: StartOpts): Promise<Server> {
  const assets = opts.assetsDir ?? fileURLToPath(new URL('../assets/', import.meta.url));
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetchSub = opts.fetchSub ?? fetch;
  const home = homedir();
  const configPath = opts.configPath ?? join(home, '.allowance', 'config.json');
  const codexAuthPath =
    opts.codexAuthPath === undefined ? join(home, '.codex', 'auth.json') : opts.codexAuthPath;
  const claudeCredentialPath =
    opts.claudeCredentialPath === undefined
      ? join(home, '.claude', '.credentials.json')
      : opts.claudeCredentialPath;
  const cursorAuthPath =
    opts.cursorAuthPath === undefined ? join(home, '.cursor', 'auth.json') : opts.cursorAuthPath;
  const museAuthPath =
    opts.museAuthPath === undefined
      ? env['MUSE_AUTH_PATH']?.trim() || join(home, '.config', 'muse', 'auth.json')
      : opts.museAuthPath;
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
    if (req.method === 'POST' && path === '/accounts') {
      await saveAccounts(req, res);
      return;
    }
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
    const board = await loadBoard();
    if (board === null) {
      send(res, 500, 'text/plain; charset=utf-8', 'could not read');
      return;
    }
    if (path === '/api/board') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(board));
      return;
    }
    send(res, 200, 'text/html; charset=utf-8', renderPage(board));
  }

  async function loadBoard(): Promise<Board | null> {
    const signal = AbortSignal.timeout(5_000);
    try {
      const chosen = await loadSelection(configPath);
      const on = new Set(chosen);
      const [codexAuth, claudeCredential, cursorFile, museFile] = await Promise.all([
        on.has('openai') ? readJson(codexAuthPath) : undefined,
        on.has('claude') ? readJson(claudeCredentialPath) : undefined,
        on.has('cursor') ? readJson(cursorAuthPath) : undefined,
        on.has('muse') ? readJson(museAuthPath) : undefined,
      ]);
      const cursor = on.has('cursor')
        ? await resolveCursorToken(opts.cursorToken, cursorFile, cursorTokenFromKeychain)
        : null;
      const claude = on.has('claude')
        ? await resolveClaudeSignIn(
            opts.claudeToken,
            env,
            claudeCredential,
            claudeSignInFromKeychain,
          )
        : null;
      const readAt = now();
      const board = await readBoard({
        env,
        now: readAt,
        timeZone,
        fetchSub,
        signal,
        chosen,
        codexAuth,
        claudeToken: claude?.token ?? null,
        claudePlan: claude?.plan ?? null,
        cursorToken: cursor,
        ...(opts.readMuse ? { readMuse: opts.readMuse } : {}),
      });
      await publishReading(board, {
        env,
        fetchSub,
        codexAuth,
        claudeKey: claude?.accountKey ?? null,
        cursorToken: cursor,
        cursorFile,
        museFile,
      });
      return board;
    } catch {
      return null;
    }
  }

  async function publishReading(
    board: Board,
    read: {
      env: NodeJS.ProcessEnv;
      fetchSub: typeof fetch;
      codexAuth: unknown;
      claudeKey: string | null;
      cursorToken: string | null;
      cursorFile: unknown;
      museFile: unknown;
    },
  ): Promise<void> {
    try {
      const keys: AccountMaterial[] = [];
      const session = codexSession(read.codexAuth);
      if (session) keys.push({ provider: 'openai', accountKey: openaiAccountKey(session.account) });
      if (read.claudeKey) keys.push({ provider: 'claude', accountKey: read.claudeKey });
      if (read.cursorToken) {
        keys.push({ provider: 'cursor', accountKey: cursorAccountKey(read.cursorFile) });
      }
      const eleven = read.env['ELEVENLABS_API_KEY']?.trim() ?? '';
      if (eleven !== '')
        keys.push({ provider: 'elevenlabs', accountKey: elevenAccountKey(eleven) });
      if (board.chosen.includes('muse')) {
        keys.push({ provider: 'muse', accountKey: museAccountKey(read.museFile) });
      }
      const snapshot = allowanceSnapshot(board, keys);
      if (snapshot === null) return;
      const musterdConfig =
        read.env['MUSTERD_CONFIG']?.trim() || join(homedir(), '.musterd', 'config.json');
      await publishAllowance({
        env: read.env,
        cwd: process.cwd(),
        configPath: musterdConfig,
        body: snapshot,
        fetchSub: read.fetchSub,
      });
    } catch {
      // A failed post leaves the page as it was.
    }
  }

  async function saveAccounts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!saveFromThisPage(req)) {
      send(res, 403, 'text/plain; charset=utf-8', SAVE_REFUSED);
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      send(res, 413, 'text/plain; charset=utf-8', 'too large');
      return;
    }
    await saveSelection(configPath, selectionFromForm(body));
    redirectHome(res);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. A published page that bound every interface would hand the
    // sign-in's results to anything that can open the port.
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
