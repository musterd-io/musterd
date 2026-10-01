import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getProvision, PROVISION_PENDING_TTL_MS } from '../store/hostProvisions.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('host-provisions-http', (_o, kind) => {
  /**
   * ADR 463 §2, increment 3 — sponsor-host provisions over the wire: a mint with a live host of the
   * sponsor's queues a provision, that host claims and reports it, a `ready` row yields exactly one
   * `provisioned` wake, and every row that can no longer finish hands the sponsor a connect link.
   */
  let server: RunningServer;
  let base: string;
  let nick: string;
  let teamKey: string;

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
  const post = async (path: string, body: unknown, bearer?: string) =>
    await call('POST', path, body, bearer);

  async function addHuman(name: string): Promise<string> {
    const r = await post('/teams/hp-t/members', { name, kind: 'human' }, nick);
    return r.json.human_credential as string;
  }

  /** dana, with a host key for `dana-mbp` that has polled (the heartbeat a mint looks for). */
  async function danaWithLiveHost(): Promise<{ dana: string; hostKey: string }> {
    const dana = await addHuman('dana');
    const hk = await post(
      '/teams/hp-t/agent-bootstrap-credentials',
      { use: 'host', target: 'dana-mbp' },
      dana,
    );
    expect(hk.status).toBe(201);
    const poll = await post(
      '/teams/hp-t/residency/wake-leases',
      { host: 'dana-mbp' },
      hk.json.agent_key,
    );
    expect(poll.status).toBe(200);
    return { dana, hostKey: hk.json.agent_key as string };
  }

  async function member(name: string) {
    const team = await requireTeam(server.store, 'hp-t');
    return (await getMemberByName(server.store, team.id, name))!;
  }

  async function disable(name: string) {
    await setMemberGovernance(
      server.store,
      (await member(name)).id,
      'disabled',
      JSON.stringify(GENERALIST_CAPABILITIES),
    );
  }

  async function inboxOf(credential: string) {
    return (await call('GET', '/teams/hp-t/inbox', undefined, credential)).json.messages as any[];
  }

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'hp-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
    teamKey = r.json.agent_key;
    const policy = await post(
      '/teams/hp-t/policy',
      { agent_host: { policy: { budget_usd: 2 } } },
      nick,
    );
    expect(policy.status).toBe(200);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('host provisions (ADR 463 §2)', () => {
    it('a mint with a live sponsor host queues a provision and answers hosting: sponsor_host', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      const r = await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      expect(r.status).toBe(201);
      expect(r.json.hosting).toBe('sponsor_host');
      expect(r.json.host).toBe('dana-mbp');
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      expect(claim.status).toBe(200);
      expect(claim.json.provisions).toHaveLength(1);
      expect(claim.json.provisions[0]).toMatchObject({
        agent: 'dana-scout',
        sponsor: 'dana',
        state: 'claimed',
        claimed_by: 'dana-mbp',
      });
      // One claimant: the next poll finds nothing.
      const again = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      expect(again.json.provisions).toEqual([]);
    });

    it('a mint with no live host answers hosting: connect_link and queues nothing', async () => {
      const dana = await addHuman('dana');
      const r = await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      expect(r.json.hosting).toBe('connect_link');
      expect(r.json.host).toBeNull();
      expect(r.json.connect_url).toMatch(/\/join\/hp-t#n=/);
      const count = (await server.store.get('SELECT COUNT(*) AS n FROM host_provisions')) as {
        n: number;
      };
      expect(count.n).toBe(0);
    });

    it('another sponsor’s host key, and the legacy team key, claim none of dana’s provisions', async () => {
      const { dana } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const eve = await addHuman('eve');
      const eveKey = await post(
        '/teams/hp-t/agent-bootstrap-credentials',
        { use: 'host', target: 'dana-mbp' },
        eve,
      );
      expect(
        (await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, eveKey.json.agent_key))
          .json.provisions,
      ).toEqual([]);
      expect(
        (await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, teamKey)).json.provisions,
      ).toEqual([]);
    });

    it('with no agent_host budget a claimed row fails no_budget and the sponsor is told', async () => {
      await post('/teams/hp-t/policy', {}, nick);
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      expect(claim.json.provisions).toEqual([]);
      const row = await server.store.get('SELECT state, failed_reason FROM host_provisions');
      expect(row).toEqual({ state: 'failed', failed_reason: 'no_budget' });
      const told = (await inboxOf(dana)).find((m) => m.meta?.agent_provision_failed);
      expect(told.from).toBe('dana-scout');
      expect(told.body).toMatch(/agent_host\.policy\.budget_usd/);
    });

    it('Review Focus 2: the agent disabled between claim and report — ready is refused and the row fails', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      const id = claim.json.provisions[0].id as string;
      await disable('dana-scout');
      const r = await post(`/teams/hp-t/host/provisions/${id}/report`, { state: 'ready' }, hostKey);
      expect(r.status).toBe(403);
      const team = await requireTeam(server.store, 'hp-t');
      expect(await getProvision(server.store, team.id, id)).toMatchObject({
        state: 'failed',
        failed_reason: 'agent_lost_standing',
      });
    });

    it('Review Focus 2: the sponsor disabled after the claim — the key stops, and the sweep fails the row', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      const id = claim.json.provisions[0].id as string;
      await disable('dana');
      const r = await post(`/teams/hp-t/host/provisions/${id}/report`, { state: 'ready' }, hostKey);
      expect(r.status).toBe(403);
      expect(await server.runProvisionSweep()).toBe(1);
      const team = await requireTeam(server.store, 'hp-t');
      expect(await getProvision(server.store, team.id, id)).toMatchObject({
        state: 'failed',
        failed_reason: 'sponsor_lost_standing',
      });
    });

    it('only the claimant may report, once; a failed report hands the sponsor a connect link', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      const id = claim.json.provisions[0].id as string;
      const otherKey = await post(
        '/teams/hp-t/agent-bootstrap-credentials',
        { use: 'host', target: 'other' },
        dana,
      );
      const wrong = await post(
        `/teams/hp-t/host/provisions/${id}/report`,
        { state: 'ready' },
        otherKey.json.agent_key,
      );
      expect(wrong.status).toBe(401);
      // The host got as far as enrolling the seat before it failed.
      const en = await post(
        '/teams/hp-t/residency/enroll',
        { seat: 'dana-scout', harness: 'claude-code', host: 'dana-mbp' },
        dana,
      );
      expect(en.status).toBe(201);
      const failed = await post(
        `/teams/hp-t/host/provisions/${id}/report`,
        { state: 'failed', reason: 'worktree' },
        hostKey,
      );
      expect(failed.status).toBe(200);
      expect(failed.json.provision).toMatchObject({ state: 'failed', failed_reason: 'worktree' });
      const twice = await post(
        `/teams/hp-t/host/provisions/${id}/report`,
        { state: 'ready' },
        hostKey,
      );
      expect(twice.status).toBe(409);
      const told = (await inboxOf(dana)).find((m) => m.meta?.agent_provision_failed);
      expect(told.body).toMatch(/could not set up dana-scout \(worktree\).*\/join\/hp-t#n=/);
      // …and a failed provision leaves no half-hosted seat, so that link can redeem (ADR 463 §4.1).
      const residency = (await server.store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM residency WHERE member_id = ?',
        [(await member('dana-scout')).id],
      ))!;
      expect(residency.n).toBe(0);
    });

    it('a ready provision yields exactly one provisioned wake, naming the sponsor', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      const id = claim.json.provisions[0].id as string;
      const en = await post(
        '/teams/hp-t/residency/enroll',
        { seat: 'dana-scout', harness: 'claude-code', host: 'dana-mbp' },
        dana,
      );
      expect(en.status).toBe(201);
      const ready = await post(
        `/teams/hp-t/host/provisions/${id}/report`,
        { state: 'ready' },
        hostKey,
      );
      expect(ready.status).toBe(200);
      const first = await post('/teams/hp-t/residency/wake-leases', { host: 'dana-mbp' }, hostKey);
      expect(first.json.orders).toHaveLength(1);
      const order = first.json.orders[0];
      expect(order).toMatchObject({ seat: 'dana-scout', reason: 'provisioned', lane: 'immediate' });
      expect(order.act_id).toBeUndefined();
      expect(order.composed_line).toMatch(/created by "dana".*greet them with team_send/);
      expect(order.bounds.budget_usd).toBe(2);
      await post(
        '/teams/hp-t/residency/wake-report',
        { lease_id: order.lease_id, occupied: true, session: 'fresh' },
        hostKey,
      );
      const second = await post('/teams/hp-t/residency/wake-leases', { host: 'dana-mbp' }, hostKey);
      expect(second.json.orders.filter((o: any) => o.reason === 'provisioned')).toEqual([]);
    });

    it('a pending provision older than 15 minutes cancels and the sponsor gets a fresh connect link', async () => {
      const { dana } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      expect(await server.runProvisionSweep()).toBe(0);
      expect(await server.runProvisionSweep(Date.now() + PROVISION_PENDING_TTL_MS + 1)).toBe(1);
      const row = await server.store.get('SELECT state FROM host_provisions');
      expect(row).toEqual({ state: 'cancelled' });
      const told = (await inboxOf(dana)).find((m) => m.meta?.agent_connect_fallback);
      expect(told.from).toBe('dana-scout');
      expect(told.meta.agent_connect_fallback).toEqual({
        agent: 'dana-scout',
        reason: 'unclaimed',
      });
      expect(told.body).toMatch(/No host of yours picked up dana-scout.*\/join\/hp-t#n=/);
    });

    it('GET /host/provisions lists without claiming, and only the caller’s own sponsored seats', async () => {
      const { dana, hostKey } = await danaWithLiveHost();
      await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      const eve = await addHuman('eve');
      await post('/teams/hp-t/members/agents', { name: 'eve-scout' }, eve);
      const listed = await call(
        'GET',
        '/teams/hp-t/host/provisions?host=dana-mbp',
        undefined,
        hostKey,
      );
      expect(listed.status).toBe(200);
      expect(listed.json.provisions.map((p: any) => [p.agent, p.state])).toEqual([
        ['dana-scout', 'pending'],
      ]);
      // Reading claimed nothing: the same row is still claimable.
      const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hostKey);
      expect(claim.json.provisions).toHaveLength(1);
      const after = await call(
        'GET',
        '/teams/hp-t/host/provisions?host=dana-mbp',
        undefined,
        hostKey,
      );
      expect(after.json.provisions[0].state).toBe('claimed');
      const noHost = await call('GET', '/teams/hp-t/host/provisions', undefined, hostKey);
      expect(noHost.status).toBe(422);
    });

    it('the claim poll is a sponsor heartbeat, too', async () => {
      const dana = await addHuman('dana');
      const hk = await post(
        '/teams/hp-t/agent-bootstrap-credentials',
        { use: 'host', target: 'dana-mbp' },
        dana,
      );
      await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hk.json.agent_key);
      const r = await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
      expect(r.json.hosting).toBe('sponsor_host');
    });
  });
});
