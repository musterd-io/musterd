/**
 * Hosted `/live` sign-in, end to end in a real browser (lane 01M6S7DKXH; ADR 722, ADR 818).
 *
 * What only a browser can prove: the `__Host-musterd_signin` cookie (SameSite=None) rides the
 * console's CROSS-SITE form POST back to the team, and `/live` then holds its access token in
 * memory only. The team (`acme.musterd.test`) and the console (`app.console.test`) are different
 * sites, both on https through `tlsProxy.ts`; Chrome reaches them through host-resolver rules.
 *
 * Opt-in: it needs Chrome and a built web client (`pnpm --filter @musterd/web build`), so it runs
 * only with `MUSTERD_E2E=1` (and `CHROME_BIN` where Chrome is not at the macOS default).
 */
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConsoleConfig } from '../../packages/console/src/config.js';
import { createConsoleServer } from '../../packages/console/src/http.js';
import { makeLog } from '../../packages/console/src/log.js';
import { migrate } from '../../packages/console/src/schema.js';
import { createSession } from '../../packages/console/src/sessions.js';
import { pglite } from '../../packages/console/src/testing.js';
import { localSigner } from '../../packages/console/src/tokens.js';
import { bootCloud } from '../../packages/server/src/cloud/testing.js';
import { addMember, bindMemberAccount } from '../../packages/server/src/store/members.js';
import { createTeam } from '../../packages/server/src/store/teams.js';
import { openChromePage as openChromePageJs } from '../a11y/chrome.mjs';
import { startTlsProxy, throwawayCert } from './tlsProxy.js';

const SUFFIX = 'musterd.test';
const TEAM_HOST = `acme.${SUFFIX}`;
const CONSOLE_HOST = 'app.console.test';
const CONSOLE_ORIGIN = `https://${CONSOLE_HOST}`;
const AUD = 'https://cloud.e2e.test';
/** ADR 820's connector run: a third site plays the MCP client and receives its redirect. */
const CLIENT_HOST = 'client.e2e.test';
const CLIENT_REDIRECT = `https://${CLIENT_HOST}/cb`;
const WEB_ROOT = resolve(import.meta.dirname, '../../packages/web/dist/client');

/** chrome.mjs is untyped JS; this is the slice of it the test uses. */
interface Page {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}
const openChromePage = openChromePageJs as unknown as (o: {
  tool: string;
  verdictNoun?: string;
  extraArgs?: string[];
}) => Promise<Page>;

describe.skipIf(!process.env['MUSTERD_E2E'])('hosted /live sign-in in a real browser', () => {
  const closers: (() => Promise<unknown>)[] = [];
  let page: Page;
  let seed: NonNullable<Awaited<ReturnType<typeof bootCloud>>['seed']>;
  let teamPort = 0;
  /** What the client's redirect endpoint received, newest last. */
  const clientHits: URLSearchParams[] = [];

  /** Evaluate in the page and return the value. */
  const js = async <T>(expression: string): Promise<T> => {
    const r = (await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value: T }; exceptionDetails?: unknown };
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };
  /** Poll `expression` until it is truthy, or fail naming what never happened. */
  const until = async (what: string, expression: string, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    for (;;) {
      if (await js<boolean>(expression).catch(() => false)) return;
      if (Date.now() > end) {
        const where = await js<string>('location.href').catch(() => '?');
        const says = await js<string>('document.body.innerText.slice(0, 300)').catch(() => '?');
        const refused = await seed
          .all<{ detail: string }>(
            "SELECT detail FROM audit WHERE action = 'session.refused' ORDER BY ts",
          )
          .then((r) => r.map((x) => x.detail).join(' | '))
          .catch(() => '?');
        throw new Error(
          `timed out waiting for ${what} (page at ${where}; it says ${JSON.stringify(says)}; refused: ${refused || 'none'})`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    // The console, signed in as a GitHub account — which has no email (ADR 818's case).
    const db = await pglite();
    await db.db.exec('CREATE ROLE console_app NOLOGIN');
    await migrate(db.q, 'console_app');
    const t = Date.now();
    await db.q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acct_ada', t]);
    await db.q.query(
      'INSERT INTO identities (provider, subject, account_id, email, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['github', '4242', 'acct_ada', null, t],
    );
    const sid = await createSession(
      db.q,
      {
        accountId: 'acct_ada',
        method: 'github',
        identityProvider: 'github',
        identitySubject: '4242',
      },
      t,
    );
    const config: ConsoleConfig = {
      databaseUrl: 'postgres://x@db.test/console',
      issuer: CONSOLE_ORIGIN,
      // 127.0.0.1 too: the team server's JWKS fetch reaches the console directly (below).
      allowedHosts: [CONSOLE_HOST, '127.0.0.1'],
      host: '127.0.0.1',
      port: 0,
      build: null,
      providers: {},
      email: null,
      kms: null,
      teams: { suffix: SUFFIX, audience: AUD },
    };
    const consoleServer = createConsoleServer({
      config,
      db: db.q,
      log: makeLog(() => undefined),
      signer: localSigner(),
    });
    await new Promise<void>((r) => consoleServer.listen(0, '127.0.0.1', r));
    const consolePort = (consoleServer.address() as { port: number }).port;
    closers.push(() => new Promise((r) => consoleServer.close(r)));

    // The team server's JWKS fetch goes to the console's own listener, not through DNS.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith(CONSOLE_ORIGIN)
        ? realFetch(url.replace(CONSOLE_ORIGIN, `http://127.0.0.1:${consolePort}`), init)
        : realFetch(input, init);
    });

    // The team server, Cloud mode, serving the built /live from its own origin.
    const booted = await bootCloud({
      MUSTERD_CONSOLE_JWKS_URL: `${CONSOLE_ORIGIN}/.well-known/jwks.json`,
      MUSTERD_CONSOLE_AUDIENCE: AUD,
      MUSTERD_CLOUD_HOST_SUFFIX: SUFFIX,
      MUSTERD_WEB_ROOT: WEB_ROOT,
    });
    seed = booted.seed!;
    teamPort = booted.s.port;
    closers.push(() => booted.s.close());

    // The MCP client's redirect endpoint: records what it was handed, answers a plain page.
    const clientServer = createHttpServer((req, res) => {
      const u = new URL(req.url ?? '/', CLIENT_REDIRECT);
      // Only the redirect counts: the browser also asks this host for /favicon.ico.
      if (u.pathname === '/cb') clientHits.push(u.searchParams);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('client got it');
    });
    await new Promise<void>((r) => clientServer.listen(0, '127.0.0.1', r));
    const clientPort = (clientServer.address() as { port: number }).port;
    closers.push(() => new Promise((r) => clientServer.close(r)));
    const team = await createTeam(seed, { slug: 'acme' });
    const ada = (await addMember(seed, team, { name: 'ada', kind: 'human', role: '' })).row;
    await bindMemberAccount(seed, ada.id, 'acct_ada');

    // https for both, one listener, routed by Host.
    const proxy = await startTlsProxy({
      port: 0,
      routes: {
        [TEAM_HOST]: booted.s.port,
        [CONSOLE_HOST]: consolePort,
        [CLIENT_HOST]: clientPort,
      },
      tls: throwawayCert([TEAM_HOST, CONSOLE_HOST, CLIENT_HOST]),
    });
    closers.push(proxy.close);

    page = await openChromePage({
      tool: 'hosted-signin-e2e',
      verdictNoun: 'sign-in',
      extraArgs: [
        `--host-resolver-rules=MAP ${TEAM_HOST}:443 127.0.0.1:${proxy.port}, MAP ${CONSOLE_HOST}:443 127.0.0.1:${proxy.port}, MAP ${CLIENT_HOST}:443 127.0.0.1:${proxy.port}`,
        '--ignore-certificate-errors',
      ],
    });
    closers.push(() => page.close());
    await page.send('Network.enable');
    await page.send('Network.setCookie', {
      url: `${CONSOLE_ORIGIN}/`,
      name: '__Host-session',
      value: sid,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  }, 120_000);

  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('signs in through the console with one click and holds no credential in storage', async () => {
    await page.send('Page.navigate', { url: `https://${TEAM_HOST}/live` });
    await until(
      'the Sign in with musterd button',
      `!!document.querySelector('a[href="/live/signin/start"]')`,
    );
    // No paste field on a hosted team (unified sign-in §5).
    expect(await js<boolean>(`!!document.querySelector('input[type="password"]')`)).toBe(false);

    await js(`document.querySelector('a[href="/live/signin/start"]').click(), true`);

    // start → console /handback → auto-submitted cross-site POST → callback → /live.
    await until(
      'a browser session on the team',
      `fetch('/live/session/token', { method: 'POST', credentials: 'same-origin' }).then((r) => r.status === 200)`,
      30_000,
    );
    expect(await js<string>('location.origin + location.pathname')).toBe(
      `https://${TEAM_HOST}/live`,
    );
    const rows = await seed.all<{ id: string }>('SELECT id FROM browser_sessions');
    expect(rows).toHaveLength(1);

    // /live is connected as ada: the sign-in card is gone.
    await until(
      'the sign-in card to leave',
      `!document.querySelector('a[href="/live/signin/start"]')`,
    );

    // The token lives in memory: nothing credential-shaped in either storage.
    const stored = await js<string>('JSON.stringify([localStorage, sessionStorage])');
    expect(stored).not.toMatch(/msat_|mscr_|mbs_/);
  }, 90_000);
  /**
   * A request to the team server as the client would make it, straight to its port. `node:http`,
   * not `fetch`: fetch drops a custom Host header, and the team is chosen by Host.
   */
  const teamFetch = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; json: () => Promise<unknown> }>((resolveReq, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: teamPort,
          path,
          method: init.method ?? 'GET',
          headers: { host: TEAM_HOST, 'x-forwarded-proto': 'https', ...(init.headers ?? {}) },
        },
        (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () =>
            resolveReq({ status: res.statusCode ?? 0, json: async () => JSON.parse(text) }),
          );
        },
      );
      r.on('error', reject);
      r.end(init.body);
    });

  async function registerClient(): Promise<string> {
    const r = await teamFetch('/oauth/acme/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: 'Claude' }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { client_id: string }).client_id;
  }

  /** Open the consent page, choose Sign in with musterd, land on the confirm page, click `decision`. */
  async function connect(
    client_id: string,
    challenge: string,
    state: string,
    decision: 'allow' | 'deny',
  ) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: CLIENT_REDIRECT,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const before = clientHits.length;
    await page.send('Page.navigate', { url: `https://${TEAM_HOST}/oauth/acme/authorize?${q}` });
    await until(
      'the consent page',
      `!!document.querySelector('input[name="via"][value="musterd"]')`,
    );
    // No credential box on a hosted team (ADR 820 §5).
    expect(await js<boolean>(`!!document.querySelector('input[name="credential"]')`)).toBe(false);
    await js(`document.querySelector('input[name="via"][value="musterd"]').form.submit(), true`);
    // Console hand-back (auto-submitted, cross-site), then the team's confirm page naming ada.
    await until(
      'the confirm page',
      `!!document.querySelector('button[value="${decision}"]')`,
      30_000,
    );
    expect(await js<string>('document.body.innerText')).toContain('ada');
    await js(`document.querySelector('button[value="${decision}"]').click(), true`);
    const deadline = Date.now() + 20_000;
    while (clientHits.length === before) {
      if (Date.now() > deadline) throw new Error('the client never received its redirect');
      await new Promise((r) => setTimeout(r, 200));
    }
    return clientHits[clientHits.length - 1]!;
  }

  it('connects an MCP client: consent, console, confirm, Allow, and a code only its verifier redeems (ADR 820)', async () => {
    const client_id = await registerClient();
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const back = await connect(client_id, challenge, 'st-allow', 'allow');
    expect(back.get('state')).toBe('st-allow');
    const code = back.get('code')!;
    expect(code).toBeTruthy();
    const token = await teamFetch('/oauth/acme/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const access = ((await token.json()) as { access_token: string }).access_token;
    expect(access).toMatch(/^msat_/);
    // It acts as ada: her own signed-in apps list answers to it, and names this client.
    const mine = await teamFetch('/teams/acme/members/ada/clients', {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).toContain('Claude');
  }, 90_000);

  it('Cancel on the confirm page sends the client access_denied and no code', async () => {
    const client_id = await registerClient();
    const back = await connect(client_id, 'c'.repeat(43), 'st-deny', 'deny');
    expect(back.get('error')).toBe('access_denied');
    expect(back.get('state')).toBe('st-deny');
    expect(back.get('code')).toBeNull();
  }, 90_000);
});
