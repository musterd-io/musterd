import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * A team-addressed send costs the same number of statements at any team size (lane 01M4563RDY).
 * Cloud load run 9 (2026-10-05) logged agent `POST /messages` at 165 transactions on a 150-member
 * team — a per-recipient loop, each statement its own pooled transaction — and run 11 put the
 * remaining write latency there once the pool queue was gone.
 */
withDrivers('team send statement count', (_o, kind) => {
  let server: RunningServer | undefined;
  beforeEach(() => {
    vi.stubEnv('MUSTERD_REAPER_INTERVAL_MS', String(60 * 60 * 1000));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllEnvs();
  });

  /** Statements one team-addressed send runs on a team of the creator plus `extra` members. */
  async function sendStatements(extra: number): Promise<string[]> {
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
      await post(
        '/teams/dawn/members',
        { name: `m${i}`, kind: i % 2 ? 'agent' : 'human' },
        credential,
      );

    const seen: string[] = [];
    const counted = db as Driver & { onStatement(l: (sql: string) => void): () => void };
    const stop = counted.onStatement((sql) => seen.push(sql.replace(/\s+/g, ' ').trim()));
    await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id: `send-${extra}`,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: 'hello team',
          ts: Date.now(),
        }),
      },
      credential,
    );
    // Let the send's deferred work (notifications, wakes) run before the count closes.
    await new Promise((r) => setTimeout(r, 200));
    stop();
    await server.close();
    server = undefined;
    return seen;
  }

  it('a team-addressed send runs the same statements on 4 members as on 13, humans and agents', async () => {
    const small = await sendStatements(3);
    const large = await sendStatements(12);
    expect(large.length).toBe(small.length);
  });
});
