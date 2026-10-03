import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * The roster read costs the same number of statements at any team size (lane 01M3ZCTQK9). It ran a
 * presence query and a status-update query per member — on Cloud each one its own five-round-trip
 * transaction through a pool of 10, about 300 statements per `GET /teams/:slug` at 151 members — and
 * /live refetches the roster on presence frames for every viewer (Cloud load runs 2–3, 2026-10-03).
 */
withDrivers('roster read statement count', (_o, kind) => {
  let server: RunningServer | undefined;
  beforeEach(() => {
    // Nothing but the request under count may touch the store while it is measured.
    vi.stubEnv('MUSTERD_REAPER_INTERVAL_MS', String(60 * 60 * 1000));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllEnvs();
  });

  /** Statements one roster read runs on a team of the creator plus `extra` members. */
  async function rosterStatements(extra: number): Promise<number> {
    const db = await openTestDriver(kind);
    server = createServer({ db, port: 0 });
    const { port } = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown, credential?: string) => {
      const r = await fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(r.status, await r.clone().text()).toBeLessThan(300);
      return (await r.json()) as { human_credential: string };
    };
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const credential = team.human_credential;
    for (let i = 0; i < extra; i++)
      await post('/teams/dawn/members', { name: `m${i}`, kind: 'human' }, credential);

    const seen: string[] = [];
    const counted = db as Driver & { onStatement(l: (sql: string) => void): () => void };
    const stop = counted.onStatement((sql) => seen.push(sql));
    const r = await fetch(`${base}/teams/dawn`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const body = (await r.json()) as { members: unknown[] };
    stop();
    expect(r.status).toBe(200);
    expect(body.members).toHaveLength(extra + 1);
    await server.close();
    server = undefined;
    return seen.length;
  }

  it('is the same for a team of 3 as for a team of 13', async () => {
    const small = await rosterStatements(2);
    const large = await rosterStatements(12);
    expect(large).toBe(small);
  });
});
