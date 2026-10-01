import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('sponsor-authority-http', (_o, kind) => {
  /**
   * ADR 463 §1: a member's authority over the agents they sponsor — mint a `claim_seat` credential,
   * issue a seat grant, enroll and revoke residency — and nothing else. Admin keeps every power.
   */
  let server: RunningServer;
  let base: string;
  let nick: string;

  async function post(path: string, body: unknown, bearer?: string) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  async function addHuman(name: string): Promise<string> {
    const r = await post('/teams/auth-t/members', { name, kind: 'human' }, nick);
    return r.json.human_credential as string;
  }

  /** Governance is reconcile-written (seat files), never an HTTP route — tests set it on the store. */
  async function govern(
    name: string,
    status: string | null,
    caps: Record<string, unknown> = {},
  ): void {
    const team = await requireTeam(server.store, 'auth-t');
    const m = (await getMemberByName(server.store, team.id, name))!;
    await setMemberGovernance(
      server.store,
      m.id,
      status,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, ...caps }),
    );
  }

  async function auditRows(
    action: string,
  ): { actor: string | null; target: string; detail: any }[] {
    return (
      (await server.store.all(
        'SELECT actor, target, detail FROM audit WHERE action = ? ORDER BY id',
        [action],
      )) as { actor: string | null; target: string; detail: string | null }[]
    ).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'auth-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('sponsor-scoped authority (ADR 463 §1)', () => {
    it('a sponsor mints a claim_seat credential for their own agent; not for another member’s', async () => {
      const dana = await addHuman('dana');
      const eve = await addHuman('eve');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      const ok = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      expect(ok.status).toBe(201);
      expect(ok.json.agent_key).toMatch(/^mskey_/);
      const no = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        eve,
      );
      expect(no.status).toBe(403);
    });

    it('a sponsor may not mint for a non-agent seat, nor a claim_role credential', async () => {
      const dana = await addHuman('dana');
      await addHuman('eve');
      const human = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'eve' },
        dana,
      );
      expect(human.status).toBe(404);
      const role = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_role', target: 'research' },
        dana,
      );
      expect(role.status).toBe(403);
    });

    it('an admin-created agent (no sponsor) is not a member’s to mint for', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members', { name: 'ops-bot', kind: 'agent' }, nick);
      const r = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'ops-bot' },
        dana,
      );
      expect(r.status).toBe(403);
    });

    it('an agent may not act as a sponsor, even for its own sponsored descendants', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      const agentMint = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      // A seat bootstrap credential is not a member credential: refused before any sponsor check.
      const r = await post(
        '/teams/auth-t/grants',
        { scope: 'seat', target: 'dana-scout', lifetime: 'standing' },
        agentMint.json.agent_key,
      );
      expect([401, 403]).toContain(r.status);
    });

    it('a sponsor with can_create_agents withdrawn is refused', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      await govern('dana', null, { can_create_agents: false });
      const r = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      expect(r.status).toBe(403);
    });

    it('a sponsor issues a seat grant for their own agent only', async () => {
      const dana = await addHuman('dana');
      await addHuman('eve');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      const ok = await post(
        '/teams/auth-t/grants',
        { scope: 'seat', target: 'dana-scout', lifetime: 'standing' },
        dana,
      );
      expect(ok.status).toBe(201);
      const other = await post(
        '/teams/auth-t/grants',
        { scope: 'seat', target: 'eve', lifetime: 'standing' },
        dana,
      );
      expect(other.status).toBe(404);
      const wrongScope = await post(
        '/teams/auth-t/grants',
        { scope: 'role', target: 'research', lifetime: 'standing' },
        dana,
      );
      expect(wrongScope.status).toBe(403);
      expect((await auditRows('grant.issue')).at(0)?.detail.sponsor_scoped).toBe(true);
    });

    it('a sponsor enrolls and revokes residency for their own agent; not another’s', async () => {
      const dana = await addHuman('dana');
      const eve = await addHuman('eve');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      const en = await post(
        '/teams/auth-t/residency/enroll',
        { seat: 'dana-scout', harness: 'claude-code', host: 'dana-mbp' },
        dana,
      );
      expect(en.status).toBe(201);
      expect(en.json.grant).toMatch(/^msgr_/);
      expect((await auditRows('residency.enrolled')).at(0)?.detail.sponsor_scoped).toBe(true);
      const eveRevoke = await post('/teams/auth-t/residency/revoke', { seat: 'dana-scout' }, eve);
      expect(eveRevoke.status).toBe(403);
      const eveEnroll = await post(
        '/teams/auth-t/residency/enroll',
        { seat: 'dana-scout', harness: 'claude-code', host: 'eve-mbp' },
        eve,
      );
      expect(eveEnroll.status).toBe(403);
      const rv = await post('/teams/auth-t/residency/revoke', { seat: 'dana-scout' }, dana);
      expect(rv.status).toBe(200);
    });

    it('Review Focus 4: a removed agent of the sponsor’s is not mintable', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      expect((await post('/teams/auth-t/members/dana-scout/remove', {}, nick)).status).toBe(200);
      const r = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      expect(r.status).toBe(404);
    });

    it('a disabled agent of the sponsor’s is not mintable', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      await govern('dana-scout', 'disabled');
      const r = await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      expect(r.status).toBe(404);
    });

    it('audit rows for sponsor-scoped mints carry sponsor_scoped: true; admin mints false', async () => {
      const dana = await addHuman('dana');
      await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
      await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        dana,
      );
      await post(
        '/teams/auth-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        nick,
      );
      const rows = await auditRows('bootstrap_credential.minted');
      expect(rows.map((r) => [r.actor, r.detail.sponsor_scoped])).toEqual([
        ['dana', true],
        ['nick', false],
      ]);
    });
  });
});
