import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import WebSocket from 'ws';
import { openTestDriver } from '../db/testing.js';
import { log } from '../log.js';
import {
  addMember,
  EXPIRED_SWEEP_FIRST_DELAY_MS,
  mintAgentSeatCredential,
  mintCredential,
  startExpiredMemberSweep,
} from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { bootCloudWithOutage, hostRequest } from './testing.js';

/**
 * A database outage never takes the process down (lane 01M3ZC3EXN). On SQLite a store call does
 * not reject; on Postgres a pool timeout or an outage does, and a background path that leaves the
 * rejection unhandled exits the server. The 2026-10-02 load test lost every team on the staging
 * machine to one WebSocket closing while the pool was exhausted. Each path here meets the outage,
 * logs one stable msg, and carries on — the request paths already answer 503 (spec §7).
 */

type WarnSpy = MockInstance<typeof log.warn>;
const warned = (spy: WarnSpy, msg: string) =>
  spy.mock.calls.filter(([fields]) => fields.msg === msg).length;

/** Open a socket on the team's host and claim; resolves once the server says `occupied`. */
async function claim(
  url: string,
  frame: { key: string; seat: string; surface: string; workspace_key?: string },
): Promise<WebSocket> {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', {
    headers: { host: 'revive.musterd.test' },
  });
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  const occupied = new Promise<void>((resolve, reject) =>
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { type: string };
      if (f.type === 'occupied') resolve();
      else if (f.type === 'refused' || f.type === 'error') reject(new Error(String(data)));
    }),
  );
  ws.send(
    JSON.stringify({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'revive',
      key: frame.key,
      target: { seat: frame.seat },
      surface: frame.surface,
      ...(frame.workspace_key ? { workspace_key: frame.workspace_key } : {}),
    }),
  );
  await occupied;
  return ws;
}

describe('cloud mode — a database outage never takes the process down (lane 01M3ZC3EXN)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a WebSocket that closes mid-outage is logged, and the server answers once the database is back', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { s, seed, url, setDown } = await bootCloudWithOutage();
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, revive, { name: 'ada', kind: 'human', role: '' });
      const key = (await mintCredential(seed, row.id)).credential;
      const ws = await claim(url, { key, seat: 'ada', surface: 'web' });
      setDown(true);
      ws.close();
      await vi.waitFor(() => expect(warned(warn, 'ws_cleanup_failed')).toBe(1));
      setDown(false);
      expect((await hostRequest(url, '/health', 'revive.musterd.test')).status).toBe(200);
    } finally {
      setDown(false);
      await s.close();
    }
  });

  it('a same-workspace eviction that meets the outage is logged, not an unhandled rejection', async () => {
    vi.stubEnv('MUSTERD_SUPERSEDE_GRACE_MS', '300');
    const warn = vi.spyOn(log, 'warn');
    const { s, seed, url, setDown } = await bootCloudWithOutage();
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, revive, { name: 'bot', kind: 'agent', role: '' });
      // The seat's own credential self-authorizes (the shared team key would wait for an admin).
      const key = (await mintAgentSeatCredential(seed, row.id)).seat_credential;
      // The same seat from the same work tree twice: the second is a reload of the first, so the
      // first is reaped once the second has held the seat for the grace window (ADR 092).
      const first = await claim(url, {
        key,
        seat: 'bot',
        surface: 'claude-code',
        workspace_key: '/w',
      });
      const second = await claim(url, {
        key,
        seat: 'bot',
        surface: 'claude-code',
        workspace_key: '/w',
      });
      setDown(true);
      await vi.waitFor(() => expect(warned(warn, 'ws_supersede_failed')).toBe(1), {
        timeout: 3000,
      });
      setDown(false);
      expect((await hostRequest(url, '/health', 'revive.musterd.test')).status).toBe(200);
      first.terminate();
      second.terminate();
    } finally {
      setDown(false);
      await s.close();
    }
  });

  it('a reaper tick that meets the outage is logged, and the loop keeps ticking', async () => {
    vi.stubEnv('MUSTERD_REAPER_INTERVAL_MS', '20');
    const warn = vi.spyOn(log, 'warn');
    const { s, url, setDown } = await bootCloudWithOutage();
    try {
      setDown(true);
      // Two failures, not one: the loop's one-tick-at-a-time flag must clear after a failed tick.
      await vi.waitFor(() => expect(warned(warn, 'reaper_tick_failed')).toBeGreaterThanOrEqual(2), {
        timeout: 3000,
      });
      setDown(false);
      expect((await hostRequest(url, '/health', 'revive.musterd.test')).status).toBe(200);
    } finally {
      setDown(false);
      await s.close();
    }
  });

  it('an expired-member sweep whose follow-up rejects hands the error to onError', async () => {
    const db = await openTestDriver('sqlite');
    vi.useFakeTimers();
    const onError = vi.fn();
    const stop = startExpiredMemberSweep(
      db,
      async () => {
        throw new Error('revoke failed: database unreachable');
      },
      onError,
    );
    try {
      await vi.advanceTimersByTimeAsync(EXPIRED_SWEEP_FIRST_DELAY_MS);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]![0])).toContain('revoke failed');
    } finally {
      stop();
    }
  });
});
