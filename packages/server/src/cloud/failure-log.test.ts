import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTestDriver, testCloudPools } from '../db/testing.js';
import { createServer } from '../index.js';
import { log, type LogFields } from '../log.js';
import { addMember, mintCredential } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { hostRequest, stubCloudEnv } from './testing.js';

/**
 * A 500 says why on its own request log line (lane 01M3ZPM3FE). Cloud load run 3 (2026-10-03)
 * answered 261 requests with a 500 and the logs held nothing but `status: 500` — the error that
 * caused each one went to the client and nowhere else. The line now carries the error's class, its
 * Postgres SQLSTATE when there is one, and a bounded message with credential-shaped text redacted.
 */

/** A cloud server whose next statement matching `match` fails with `error`, once `arm()` is called. */
async function bootCloudWithQueryFault(fault: { match: RegExp; error: Error }) {
  stubCloudEnv();
  const seed = await openTestDriver('pglite');
  await openTestDriver('pglite', { store: 'trace' });
  const pools = (await testCloudPools()).factories;
  let armed = false;
  const main = (u: string) => {
    const p = pools.main(u);
    return {
      connect: async () => {
        const c = await p.connect();
        return new Proxy(c, {
          get(target, key) {
            const v: unknown = Reflect.get(target, key, target);
            if (typeof v !== 'function') return v;
            if (key !== 'query') return v.bind(target);
            return (text: unknown, params?: unknown) => {
              if (armed && typeof text === 'string' && fault.match.test(text)) {
                armed = false;
                return Promise.reject(fault.error);
              }
              return v.call(target, text, params);
            };
          },
        });
      },
      end: () => p.end(),
    };
  };
  const s = createServer({ cloudPools: { ...pools, main }, rosterRoots: [], port: 0 });
  await s.listen();
  return { s, seed, url: `http://127.0.0.1:${s.port}`, arm: () => void (armed = true) };
}

describe('a 500 carries its cause on the request log line (lane 01M3ZPM3FE)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('class, SQLSTATE and a bounded message, with a credential in the message redacted', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const leaked = `mscr_${'Q'.repeat(40)}`;
    const deadlock = Object.assign(new Error(`deadlock detected while holding "${leaked}"`), {
      code: '40P01',
    });
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /from members/i,
      error: deadlock,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, team, { name: 'ada', kind: 'human', role: '' });
      const token = (await mintCredential(seed, row.id)).credential;
      arm();
      const r = await hostRequest(url, '/teams/revive/members', 'revive.musterd.test', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status, r.body).toBe(500);
      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find((f: LogFields) => f.msg === 'http_request' && f.status === 500);
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ err_class: 'Error', sqlstate: '40P01' });
      const err = String(line.err);
      expect(err).toContain('deadlock detected');
      expect(err).not.toContain(leaked);
      expect(err).toContain('[redacted]');
      expect(err.length).toBeLessThanOrEqual(300);
    } finally {
      await s.close();
    }
  });
});
