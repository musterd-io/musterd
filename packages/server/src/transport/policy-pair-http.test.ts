import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('policy-pair-http', (_o, kind) => {
  /**
   * ADR 463 §4 through HTTP — ADR 456's takeover residual closed in code: `any_member` connect needs
   * `invite_requires_expiry` and is refused while any sponsored agent is hosted; a hosted agent is
   * never connectable; an invite needs `member_until` when the team says so.
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
    const r = await post('/teams/pp-t/members', { name, kind: 'human' }, nick);
    return r.json.human_credential as string;
  }

  /** dana's agent, enrolled on her host (the admin enrolls here; increment 1 lets dana do it). */
  async function hostedAgent(): Promise<string> {
    const dana = await addHuman('dana');
    await post('/teams/pp-t/members/agents', { name: 'dana-scout' }, dana);
    const en = await post(
      '/teams/pp-t/residency/enroll',
      { seat: 'dana-scout', harness: 'claude-code', host: 'dana-mbp' },
      nick,
    );
    expect(en.status).toBe(201);
    return dana;
  }

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'pp-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('ADR 463 §4 — the residual closed in code', () => {
    it('any_member requires invite_requires_expiry', async () => {
      const r1 = await post('/teams/pp-t/policy', { agent_connect: 'any_member' }, nick);
      expect(r1.status).toBe(422);
      expect(r1.json.error.message).toMatch(/invite_requires_expiry/);
      const r2 = await post(
        '/teams/pp-t/policy',
        { agent_connect: 'any_member', invite_requires_expiry: true },
        nick,
      );
      expect(r2.status).toBe(200);
    });

    it('any_member is refused while a sponsored agent is hosted', async () => {
      await hostedAgent();
      const r = await post(
        '/teams/pp-t/policy',
        { agent_connect: 'any_member', invite_requires_expiry: true },
        nick,
      );
      expect(r.status).toBe(409);
      expect(r.json.error.message).toMatch(/dana-scout.*dana-mbp/);
    });

    it('Review Focus 3: a team already on any_member refuses connect the moment an agent is hosted', async () => {
      await post(
        '/teams/pp-t/policy',
        { agent_connect: 'any_member', invite_requires_expiry: true },
        nick,
      );
      const dana = await hostedAgent();
      const eve = await addHuman('eve');
      for (const who of [dana, eve, nick]) {
        const r = await post('/teams/pp-t/members/agents/dana-scout/connect', {}, who);
        expect(r.status).toBe(409);
      }
    });

    it('a hosted agent is not connectable by its sponsor under the default policy', async () => {
      const dana = await hostedAgent();
      const r = await post('/teams/pp-t/members/agents/dana-scout/connect', {}, dana);
      expect(r.status).toBe(409);
      expect(r.json.error.message).toMatch(/hosted/);
    });

    it('an invite without member_until is refused when invite_requires_expiry', async () => {
      expect((await post('/teams/pp-t/invites', {}, nick)).status).toBe(201);
      await post('/teams/pp-t/policy', { invite_requires_expiry: true }, nick);
      const r = await post('/teams/pp-t/invites', {}, nick);
      expect(r.status).toBe(422);
      const nulled = await post('/teams/pp-t/invites', { member_until: null }, nick);
      expect(nulled.status).toBe(422);
      const ok = await post('/teams/pp-t/invites', { member_until: Date.now() + 3_600_000 }, nick);
      expect(ok.status).toBe(201);
    });

    it('removing the sponsor revokes the hosted agent’s residency (cascade)', async () => {
      await hostedAgent();
      expect((await post('/teams/pp-t/members/dana/remove', {}, nick)).status).toBe(200);
      const row = (await server.store.get(
        "SELECT COUNT(*) AS n FROM residency r JOIN members m ON m.id = r.member_id WHERE m.name = 'dana-scout'",
      )) as { n: number };
      expect(row.n).toBe(0);
    });
  });
});
