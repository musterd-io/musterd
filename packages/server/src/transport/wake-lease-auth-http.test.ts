import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { attach, release } from '../store/presence.js';
import { requireTeam } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * ADR 672: the wake actuator acts for a live wake with the seat credential and the wake lease it
 * was handed — no session lease, no claim. The daemon accepts that exactly while a Presence of the
 * seat attests the lease (ADR 241), and touches no Presence for it.
 */
withDrivers('wake-lease-auth-http', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;
  let adaId: string;

  async function call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  const asWake = (lease: string) => ({
    authorization: `Bearer ${ada.key}`,
    'x-musterd-wake-lease': lease,
    'x-musterd-no-touch': '1',
  });

  const ask = (id: string) => ({
    envelope: makeEnvelope({
      id,
      team: 'wl-t',
      from: 'ada',
      to: { kind: 'member', name: 'nick' },
      act: 'ask',
      body: 'ada lease L1 spent $0.5000, approval $0.5000',
      meta: { species: 'approve', tier: 'blocking' },
    }),
  });

  /** The daemon's own lease row for ada (ADR 672 binds the header to it, not to the Presence alone). */
  async function leaseRow(id: string, status: 'leased' | 'reported' = 'leased'): Promise<void> {
    const team = await requireTeam(server.store, 'wl-t');
    const now = Date.now();
    await server.store.run(
      `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at)
         VALUES (?, ?, ?, NULL, NULL, 'h', 'immediate', ?, ?, ?)`,
      [id, team.id, adaId, status, now, now + 120_000],
    );
  }

  async function presenceRows(): Promise<number> {
    const row = await server.store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM presence WHERE member_id = ?',
      [adaId],
    );
    return Number(row!.n);
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await call(
      'POST',
      '/teams',
      {},
      {
        slug: 'wl-t',
        creator: { name: 'nick', kind: 'human' },
      },
    );
    nick = r.json.human_credential;
    const agentKey = r.json.agent_key as string;
    await call(
      'POST',
      '/teams/wl-t/members',
      { authorization: `Bearer ${nick}` },
      {
        name: 'ada',
        kind: 'agent',
      },
    );
    ada = await claimAgentHttp(base, 'wl-t', agentKey, nick, 'ada');
    const team = await requireTeam(server.store, 'wl-t');
    adaId = (await getMemberByName(server.store, team.id, 'ada'))!.id;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('a seat credential under a wake lease (ADR 672)', () => {
    it('is refused until a Presence of the seat attests that lease', async () => {
      await leaseRow('L1');
      const refused = await call('POST', '/teams/wl-t/messages', asWake('L1'), ask('a1'));
      expect(refused.status).toBe(401);
      expect(refused.json.error.message).toContain('wake lease "L1" is not live on ada');
    });

    it('posts the ask and peeks the inbox once the wake is live, touching no Presence', async () => {
      await leaseRow('L1');
      await attach(server.store, adaId, 'claude-code', 'wake-conn', {
        provenance: 'wake',
        wake_lease: 'L1',
      });
      const before = await presenceRows();
      const sent = await call('POST', '/teams/wl-t/messages', asWake('L1'), ask('a1'));
      expect(sent.status).toBe(201);
      const peek = await call('GET', '/teams/wl-t/messages?peek=1&limit=50', {
        ...asWake('L1'),
        'x-musterd-seat': 'ada',
      });
      expect(peek.status).toBe(200);
      // Presence-neutral: the wake's own session is the occupant; the actuator added no row.
      expect(await presenceRows()).toBe(before);
      // The act is the seat's own, as any seat-sent ask.
      const inbox = await call('GET', '/teams/wl-t/messages?peek=1', {
        authorization: `Bearer ${nick}`,
      });
      expect(inbox.json.messages.some((m: { id: string }) => m.id === 'a1')).toBe(true);
    });

    it('a lease the daemon never minted, another lease id, a reported lease, or a released wake Presence is refused', async () => {
      // A Presence attesting a lease the daemon never minted: the attestation is client-side.
      const forged = await attach(server.store, adaId, 'claude-code', 'forged', {
        provenance: 'wake',
        wake_lease: 'L0',
      });
      expect((await call('POST', '/teams/wl-t/messages', asWake('L0'), ask('a0'))).status).toBe(
        401,
      );
      await release(server.store, forged.id, 60_000);
      await leaseRow('L1');
      const row = await attach(server.store, adaId, 'claude-code', 'wake-conn', {
        provenance: 'wake',
        wake_lease: 'L1',
      });
      expect((await call('POST', '/teams/wl-t/messages', asWake('L2'), ask('a2'))).status).toBe(
        401,
      );
      // The wake has reported: its lease no longer acts, whatever the Presence still says.
      await server.store.run("UPDATE wake_leases SET status = 'reported' WHERE id = 'L1'");
      expect((await call('POST', '/teams/wl-t/messages', asWake('L1'), ask('a2b'))).status).toBe(
        401,
      );
      await server.store.run("UPDATE wake_leases SET status = 'leased' WHERE id = 'L1'");
      await release(server.store, row.id, 60_000);
      expect((await call('POST', '/teams/wl-t/messages', asWake('L1'), ask('a3'))).status).toBe(
        401,
      );
    });

    it('acts only on the hold’s two routes — any other route keeps the lease rule', async () => {
      await leaseRow('L1');
      await attach(server.store, adaId, 'claude-code', 'wake-conn', {
        provenance: 'wake',
        wake_lease: 'L1',
      });
      const report = await call('GET', '/teams/wl-t/report', asWake('L1'));
      expect(report.status).toBe(401);
      expect(report.json.error.message).toContain('session lease');
    });

    it('a session lease still authenticates as before; the header changes nothing for it', async () => {
      const ok = await call(
        'POST',
        '/teams/wl-t/messages',
        {
          authorization: `Bearer ${ada.key}`,
          'x-musterd-session-lease': ada.sessionLease,
          'x-musterd-wake-lease': 'L9',
        },
        ask('a4'),
      );
      expect(ok.status).toBe(201);
    });
  });
});
