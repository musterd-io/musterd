import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * A report derivation costs the same number of statements at any team size (lane 01M46RPQ94).
 * Cloud load run 12 (2026-10-05) logged a `/report` derivation at 202 transactions on a 150-member
 * team. Under load each cost ~250 ms, so one background refresh outlasted REPORT_MAX_STALE_MS and
 * every viewer's poll queued on it: `/report` p95 20.5 s while its DB hold stayed at 1.5 s.
 */
withDrivers('report derivation statement count', (_o, kind) => {
  let server: RunningServer | undefined;
  beforeEach(() => {
    vi.stubEnv('MUSTERD_REAPER_INTERVAL_MS', String(60 * 60 * 1000));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllEnvs();
  });

  /** Statements one `/report` read runs on a team of the creator plus `extra` busy members. */
  async function reportStatements(extra: number): Promise<string[]> {
    const db = await openTestDriver(kind);
    server = createServer({ db, port: 0 });
    const { port } = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body: unknown, credential?: string) => {
      const r = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(r.status, await r.clone().text()).toBeLessThan(300);
      return (await r.json()) as Record<string, unknown>;
    };
    const team = await call('POST', '/teams', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    const owner = team['human_credential'] as string;
    for (let i = 0; i < extra; i++) {
      const name = `m${i}`;
      const added = await call(
        'POST',
        '/teams/dawn/members',
        { name, kind: i % 2 ? 'agent' : 'human' },
        owner,
      );
      // Each member leaves the trail a load-run seat does: a status line (humans post their own;
      // agents hold no credential until they claim), a message addressed to them, a lane.
      const cred = added['human_credential'] as string | undefined;
      const sends: Array<[string, string, Record<string, string>, string]> = [
        ['message', 'nick', { kind: 'member', name }, owner],
      ];
      if (cred) sends.push(['status_update', name, { kind: 'team' }, cred]);
      for (const [act, from, to, credential] of sends)
        await call(
          'POST',
          '/teams/dawn/messages',
          {
            envelope: makeEnvelope({
              id: `${act}-${name}`,
              team: 'dawn',
              from,
              to: to as never,
              act: act as never,
              body: `${act} for ${name}`,
              ts: Date.now(),
            }),
          },
          credential,
        );
      await call('POST', '/teams/dawn/lanes', { title: `lane of ${name}` }, owner);
    }

    // The setup writes above kick the sync push loop (200 ms debounce), and its pass reads the team
    // list and node rows. Count from a quiet database, or that pass lands inside the one report read
    // on whichever run happens to be slower and reads as the report growing with the team.
    const counted = db as Driver & { onStatement(l: (sql: string) => void): () => void };
    let lastStatementAt = Date.now();
    const stopWatching = counted.onStatement(() => (lastStatementAt = Date.now()));
    while (Date.now() - lastStatementAt < 600) await new Promise((r) => setTimeout(r, 50));
    stopWatching();

    const seen: string[] = [];
    const stop = counted.onStatement((sql) =>
      seen.push(
        // One IN list is one statement at any length.
        sql
          .replace(/\s+/g, ' ')
          .replace(/IN \(\?(, \?)*\)/g, 'IN (?…)')
          .trim(),
      ),
    );
    await call('GET', '/teams/dawn/report', undefined, owner);
    stop();
    await server.close();
    server = undefined;
    return seen;
  }

  it('a report read runs the same statements on 4 members as on 13', async () => {
    const small = await reportStatements(3);
    const large = await reportStatements(12);
    const tally = (xs: string[]) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
      return m;
    };
    const s = tally(small);
    const grew = [...tally(large)]
      .filter(([sql, n]) => n !== (s.get(sql) ?? 0))
      .map(([sql, n]) => `${s.get(sql) ?? 0} → ${n}  ${sql.slice(0, 160)}`);
    expect(grew).toEqual([]);
    expect(large.length).toBe(small.length);
  });
});
