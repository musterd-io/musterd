import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDriver } from './db/open.js';
import { openTestDriver, withDrivers } from './db/testing.js';
import { createServer } from './index.js';

withDrivers('index', (_o, kind) => {
  /**
   * `db` on `/health` exists so a client can confirm WHICH database this daemon serves — http.ts:1203
   * says so, and guardian acts on it (`dbPathExpected` → the `wrong_db` alert class). It was reported
   * from `config.dbPath`, the path the daemon INTENDED to open, while `opts.db` bypasses that path
   * entirely. So a daemon running wholly in memory named the operator's real database.
   *
   * In production the two agree — `openDb(path)` opens exactly `path` — which is what kept this
   * invisible: the value was accidentally right, derived from the intention rather than the fact.
   */
  describe('the daemon reports the database it actually opened', () => {
    it('names the injected handle, not the config default it never opened', async () => {
      const server = createServer({ db: await openTestDriver(kind), port: 0 });
      const { port } = await server.listen();
      try {
        expect(server.dbPath).toBe(kind === 'sqlite' ? ':memory:' : 'postgres');
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const body = (await res.json()) as { db: string };
        expect(body.db).toBe(kind === 'sqlite' ? ':memory:' : 'postgres');
      } finally {
        await server.close();
      }
    });
  });

  /**
   * Hard rule 5 at the wire: a token in a request path must reach neither daemon.log (the
   * `http_request` line) nor the 404 body the unmatched-route fallback echoes back. The remote MCP
   * connector URL (`/mcp/<token>`) is the first path that carries a secret; this holds before it lands.
   */
  describe('the request log never carries a token from the path', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('redacts /mcp/<token> and credential-shaped segments in log lines and error bodies', async () => {
      vi.stubEnv('MUSTERD_SILENT', '0');
      const lines: string[] = [];
      const capture = (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      vi.spyOn(process.stderr, 'write').mockImplementation(capture);

      const server = createServer({ db: await openTestDriver(kind, { instance: 'b' }), port: 0 });
      const { port } = await server.listen();
      const secret = 'mscr_' + 'f'.repeat(40);
      const bodies: string[] = [];
      try {
        for (const path of [`/mcp/${secret}`, `/nope/${secret}`, `/mcp/${secret}?q=1`]) {
          const res = await fetch(`http://127.0.0.1:${port}${path}`);
          bodies.push(await res.text());
        }
      } finally {
        await server.close();
      }

      const requestLines = lines.filter((l) => l.includes('"http_request"'));
      expect(requestLines).toHaveLength(3);
      expect(requestLines.join('')).toContain('/mcp/[redacted]');
      expect(lines.join('')).not.toContain(secret);
      expect(bodies.join('')).not.toContain(secret);
    });
  });

  /**
   * Lane 01M4S0ZAG8: the Air's wake-leases poll logged ~5 s every few minutes with every neighbour
   * fast and nothing else in between, which reads as a request held by the connection, not the
   * handler. A slow line now says which: the request's place on its socket, how long that socket
   * sat idle first, and when the body finished arriving.
   */
  describe('a slow request line says where the time went on the connection', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('carries the socket request count, its idle gap and the body time', async () => {
      vi.stubEnv('MUSTERD_SILENT', '0');
      const lines: string[] = [];
      const capture = (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      vi.spyOn(process.stderr, 'write').mockImplementation(capture);

      const server = createServer({ db: await openTestDriver(kind, { instance: 'c' }), port: 0 });
      const { port } = await server.listen();
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      const post = (slowBodyMs: number) =>
        new Promise<void>((done, fail) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              agent,
              method: 'POST',
              path: '/teams/nope/residency/wake-leases',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              res.resume();
              res.on('end', () => done());
            },
          );
          req.on('error', fail);
          req.flushHeaders();
          setTimeout(() => req.end('{"host":"h"}'), slowBodyMs);
        });
      try {
        await post(0);
        await post(1_100);
      } finally {
        agent.destroy();
        await server.close();
      }

      const slow = lines
        .filter((l) => l.includes('"http_request"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => (l.ms as number) >= 1_000);
      expect(slow).toHaveLength(1);
      expect(slow[0]).toMatchObject({ sock_req: 2 });
      expect(slow[0]!.body_ms as number).toBeGreaterThanOrEqual(1_000);
      expect(typeof slow[0]!.sock_idle_ms).toBe('number');
      // The handler read and wrote the store, so the line also says how long it queued for it.
      if (kind === 'sqlite') expect(typeof slow[0]!.db_wait_ms).toBe('number');
    });
  });

  describe('createServer takes a Driver or a raw handle (plan 1A task 4)', () => {
    it('exposes ctx.db as a Driver either way and serves /health', async () => {
      for (const db of [await openTestDriver(kind), openDriver(':memory:')]) {
        const server = createServer({ db, port: 0 });
        const { port } = await server.listen();
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          expect(res.status).toBe(200);
        } finally {
          await server.close();
        }
      }
    });
  });
});
