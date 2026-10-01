import { request } from 'node:http';
import { vi } from 'vitest';
import { openTestDriver, testCloudPools } from '../db/testing.js';
import { createServer } from '../index.js';

/**
 * Cloud-mode test support (1C): the env, a booted server over the pooled PGlite stores, and an
 * HTTP request with an explicit Host (team hosts are `<slug>.musterd.test`). Tests only — like
 * `db/testing.ts`, nothing at runtime imports this.
 */

/** The cloud env, pointed at nothing real: the pools come from `testCloudPools()`. */
export function stubCloudEnv(over: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    MUSTERD_MODE: 'cloud',
    MUSTERD_DATABASE_APP_URL: 'postgres://app@db.test/musterd',
    MUSTERD_DATABASE_OPERATOR_URL: 'postgres://operator@db.test/musterd',
    MUSTERD_TRACE_DATABASE_APP_URL: 'postgres://app@db.test/musterd_trace',
    MUSTERD_TRACE_DATABASE_OPERATOR_URL: 'postgres://operator@db.test/musterd_trace',
    MUSTERD_CONSOLE_JWKS_URL: 'http://127.0.0.1:9/jwks',
    MUSTERD_CONSOLE_AUDIENCE: 'https://cloud.test',
    MUSTERD_CLOUD_HOST_SUFFIX: 'musterd.test',
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

/** A listening cloud server over fresh PGlite stores, plus its operator-scoped seed handle.
 *  `fresh: false` joins the stores as they are (a second server on the same database). */
export async function bootCloud(over: Record<string, string> = {}, opts: { fresh?: boolean } = {}) {
  stubCloudEnv(over);
  const seed = opts.fresh === false ? null : await openTestDriver('pglite');
  if (opts.fresh !== false) await openTestDriver('pglite', { store: 'trace' });
  const s = createServer({
    cloudPools: (await testCloudPools()).factories,
    rosterRoots: [],
    port: 0,
  });
  await s.listen();
  return { s, seed, url: `http://127.0.0.1:${s.port}` };
}

/** An HTTP request with an explicit Host header (fetch will not send one it did not derive). */
export function hostRequest(
  url: string,
  path: string,
  host: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: opts.method ?? 'GET',
        headers: { host, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on('error', reject);
    r.end(opts.body);
  });
}
