import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getMemberByName } from '../store/members.js';
import { requireTeam } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('halt-http', (_o, kind) => {
  /**
   * ADR 501 — halt as revocation. A human stops an agent seat at its next boundary: the seat's
   * leases die, its presences are evicted, it cannot re-claim, the gate refuses it, residency
   * yields it no wake, and a human lifts it. Human-only; sponsor-scoped for non-admins.
   */
  let server: RunningServer;
  let base: string;
  let agentKey: string;
  let nick: string;

  async function call(method: string, path: string, body?: unknown, bearer?: string) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const post = (path: string, body: unknown, bearer?: string) => call('POST', path, body, bearer);
  const get = (path: string, bearer?: string) => call('GET', path, undefined, bearer);

  async function agentCall(auth: AgentHttpAuth, method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.key}`,
        'x-musterd-seat': auth.seat,
        'x-musterd-session-lease': auth.sessionLease,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  async function addHuman(name: string): Promise<string> {
    const r = await post('/teams/h-t/members', { name, kind: 'human' }, nick);
    return r.json.human_credential as string;
  }
  async function memberRow(name: string) {
    const team = await requireTeam(server.store, 'h-t');
    return (await getMemberByName(server.store, team.id, name))!;
  }
  async function audits(action: string) {
    const team = await requireTeam(server.store, 'h-t');
    return (await listAudit(server.store, team.id))
      .filter((r) => r.action === action)
      .map((r) => ({
        ...r,
        detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<
          string,
          unknown
        > | null,
      }));
  }
  const halt = (seat: string, bearer: string, reason = 'looping on the wrong lane') =>
    post(`/teams/h-t/members/${seat}/halt`, { reason }, bearer);
  const resume = (seat: string, bearer: string) =>
    post(`/teams/h-t/members/${seat}/resume`, {}, bearer);

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'h-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
    agentKey = r.json.agent_key;
    await post('/teams/h-t/members', { name: 'Ada', kind: 'agent' }, nick);
  });
  afterEach(async () => {
    await server.close();
  });

  describe('halt (ADR 501 Decision 1–3)', () => {
    it('an admin halts an agent: standing set, leases revoked, the seat refused everywhere, audited', async () => {
      const ada = await claimAgentHttp(base, 'h-t', agentKey, nick, 'Ada');
      expect((await agentCall(ada, 'GET', '/teams/h-t/inbox')).status).toBe(200);

      const r = await halt('Ada', nick);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        member: 'Ada',
        halted: { by: 'nick', reason: 'looping on the wrong lane' },
      });

      // The standing is on the row and on the wire.
      const row = await memberRow('Ada');
      expect(row.halted_at).toEqual(expect.any(Number));
      expect(row.halted_reason).toBe('looping on the wrong lane');
      const roster = await get('/teams/h-t/members', nick);
      const wire = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(wire.halted).toMatchObject({ by: 'nick', reason: 'looping on the wrong lane' });

      // Every authenticated call the seat makes is refused with the halter's sentence.
      const refused = await agentCall(ada, 'GET', '/teams/h-t/inbox');
      expect(refused.status).toBe(403);
      expect(refused.json.error.message).toBe('halted by nick: looping on the wrong lane');

      // Leases are dead, presences gone, and the ledger says why.
      const live = await server.store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM session_leases WHERE member_id = ? AND revoked_at IS NULL',
        [row.id],
      );
      expect(live!.n).toBe(0);
      const halted = await audits('seat.halted');
      expect(halted).toHaveLength(1);
      expect(halted[0]).toMatchObject({ actor: 'nick', target: 'Ada', result: 'allow' });
      expect(halted[0]!.detail).toMatchObject({
        reason: 'looping on the wrong lane',
        sponsor_scoped: false,
        leases_revoked: 1,
      });
      const revoked = await audits('agent_session_lease.revoked');
      expect(revoked.map((a) => a.detail?.['cause'])).toEqual(['halt']);
    });

    it('a halted seat cannot re-claim: the claim handshake refuses with code halted', async () => {
      await halt('Ada', nick);
      const grant = await post(
        '/teams/h-t/grants',
        { scope: 'seat', target: 'Ada', lifetime: 'standing' },
        nick,
      );
      const claim = await post('/teams/h-t/claim', {
        key: agentKey,
        target: { seat: 'Ada' },
        grant: grant.json.token,
        surface: 'cli',
      });
      expect(claim.status).toBe(403);
      expect(claim.json).toMatchObject({
        type: 'refused',
        code: 'halted',
        message: 'halted by nick: looping on the wrong lane',
      });
      const refusals = await audits('claim.refused');
      expect(refusals.at(-1)!.detail).toMatchObject({ code: 'halted' });
    });

    it('the seat gets the halt as a steer from the halter, in its inbox once it is back', async () => {
      await halt('Ada', nick);
      await resume('Ada', nick);
      const ada = await claimAgentHttp(base, 'h-t', agentKey, nick, 'Ada');
      const inbox = await agentCall(ada, 'GET', '/teams/h-t/inbox');
      expect(inbox.status).toBe(200);
      const acts = inbox.json.messages.map((m: any) => [m.from, m.act, m.body]);
      expect(acts).toContainEqual(['nick', 'steer', 'halted: looping on the wrong lane']);
      expect(acts).toContainEqual(['nick', 'steer', 'resumed']);
    });

    it('re-halting a halted seat is a conflict and keeps the first reason', async () => {
      await halt('Ada', nick, 'first');
      const again = await halt('Ada', nick, 'second');
      expect(again.status).toBe(409);
      expect((await memberRow('Ada')).halted_reason).toBe('first');
    });

    it('a human seat is never halted; an agent can never halt', async () => {
      await addHuman('dana');
      expect((await halt('dana', nick)).status).toBe(403);
      const ada = await claimAgentHttp(base, 'h-t', agentKey, nick, 'Ada');
      await post('/teams/h-t/members', { name: 'Bob', kind: 'agent' }, nick);
      const byAgent = await agentCall(ada, 'POST', '/teams/h-t/members/Bob/halt', {
        reason: 'x',
      });
      expect(byAgent.status).toBe(403);
      expect(byAgent.json.error.message).toMatch(/human-only/);
      expect((await memberRow('Bob')).halted_at).toBeNull();
    });

    it('a non-admin human halts only agents they sponsor', async () => {
      const dana = await addHuman('dana');
      const mint = await post('/teams/h-t/members/agents', { name: 'dana-scout' }, dana);
      expect(mint.status).toBe(201);
      // Not hers: Ada was minted by the admin.
      const notHers = await halt('Ada', dana);
      expect(notHers.status).toBe(403);
      expect(notHers.json.error.message).toMatch(/you may halt only agents you sponsor/);
      // Hers: sponsor-scoped, and the audit row says so.
      const hers = await halt('dana-scout', dana);
      expect(hers.status).toBe(200);
      expect((await audits('seat.halted'))[0]!.detail).toMatchObject({ sponsor_scoped: true });
      // And an admin resumes it even though they did not halt it.
      expect((await resume('dana-scout', nick)).status).toBe(200);
    });

    it('a halted enrolled seat yields no wake lease; resume restores it with nothing re-enrolled', async () => {
      const enroll = await post(
        '/teams/h-t/residency/enroll',
        { seat: 'Ada', harness: 'claude-code', host: 'mbp' },
        nick,
      );
      expect(enroll.status).toBe(201);
      // A directed act makes Ada wakeable on the immediate lane.
      await post(
        '/teams/h-t/messages',
        { act: 'request_help', to: 'Ada', body: 'look at this' },
        nick,
      );
      await halt('Ada', nick);
      const none = await post('/teams/h-t/residency/wake-leases', { host: 'mbp' }, agentKey);
      expect(none.status).toBe(200);
      expect(none.json.orders).toEqual([]);
      await resume('Ada', nick);
      const some = await post('/teams/h-t/residency/wake-leases', { host: 'mbp' }, agentKey);
      expect(some.json.orders.map((o: any) => o.seat)).toEqual(['Ada']);
    });
  });

  describe('resume (ADR 501 Decision 2)', () => {
    it('clears the standing, audits seat.resumed with held_ms, and the seat acts again', async () => {
      await halt('Ada', nick);
      const r = await resume('Ada', nick);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ member: 'Ada', halted: null });
      const row = await memberRow('Ada');
      expect(row.halted_at).toBeNull();
      expect(row.halted_by).toBeNull();
      expect(row.halted_reason).toBeNull();
      const resumed = await audits('seat.resumed');
      expect(resumed).toHaveLength(1);
      expect(resumed[0]!.detail).toMatchObject({
        halted_by: 'nick',
        reason: 'looping on the wrong lane',
      });
      expect(resumed[0]!.detail?.['held_ms']).toEqual(expect.any(Number));
      const ada = await claimAgentHttp(base, 'h-t', agentKey, nick, 'Ada');
      expect((await agentCall(ada, 'GET', '/teams/h-t/inbox')).status).toBe(200);
    });

    it('resuming a seat that is not halted is a conflict', async () => {
      expect((await resume('Ada', nick)).status).toBe(409);
    });
  });
});
