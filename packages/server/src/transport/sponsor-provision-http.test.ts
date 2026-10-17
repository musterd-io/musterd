import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('sponsor-provision-http', (_o, kind) => {
  /**
   * ADR 648: a sponsor host key finishes provisioning for seats its creator sponsors — mint the
   * seat credential, issue the seat grant, enrol residency under its own label, revoke the
   * credential on cleanup — and nothing beyond that reach.
   */
  let server: RunningServer;
  let base: string;
  let nick: string;

  async function req(
    method: string,
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const post = (path: string, body: unknown, bearer?: string) => req('POST', path, body, bearer);

  async function addHuman(name: string): Promise<string> {
    const r = await post('/teams/pv-t/members', { name, kind: 'human' }, nick);
    expect(r.status).toBe(201);
    return r.json.human_credential as string;
  }

  /** dana sponsors dana-scout; her host key is for label `cloud-1`. eve sponsors eve-scout. */
  async function setup() {
    const dana = await addHuman('dana');
    const eve = await addHuman('eve');
    expect((await post('/teams/pv-t/members/agents', { name: 'dana-scout' }, dana)).status).toBe(
      201,
    );
    expect((await post('/teams/pv-t/members/agents', { name: 'eve-scout' }, eve)).status).toBe(201);
    const hk = await post(
      '/teams/pv-t/agent-bootstrap-credentials',
      { use: 'host', target: 'cloud-1' },
      dana,
    );
    expect(hk.status).toBe(201);
    return { dana, eve, hostKey: hk.json.agent_key as string };
  }

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'pv-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('a sponsor host key provisioning its own sponsored seats (ADR 648)', () => {
    it('mints the seat credential, issues the grant, enrols, and revokes on cleanup', async () => {
      const { hostKey } = await setup();
      const mint = await post(
        '/teams/pv-t/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'dana-scout' },
        hostKey,
      );
      expect(mint.status).toBe(201);
      expect(mint.json.agent_key).toBeTruthy();
      const grant = await post(
        '/teams/pv-t/grants',
        { scope: 'seat', target: 'dana-scout', lifetime: 'standing' },
        hostKey,
      );
      expect(grant.status).toBe(201);
      const enroll = await post(
        '/teams/pv-t/residency/enroll',
        { seat: 'dana-scout', harness: 'musterd', host: 'cloud-1' },
        hostKey,
      );
      expect(enroll.status).toBe(201);
      const revoke = await req(
        'DELETE',
        `/teams/pv-t/agent-bootstrap-credentials/${mint.json.credential.id}`,
        undefined,
        hostKey,
      );
      expect(revoke.status).toBe(200);
      // The audit names the sponsor, and the host-key path taken.
      const team = await requireTeam(server.store, 'pv-t');
      const rows = (await server.store.all<{ action: string; detail: string }>(
        "SELECT action, detail FROM audit WHERE team_id = ? AND action IN ('bootstrap_credential.minted','grant.issue','residency.enrolled')",
        [team.id],
      )) as { action: string; detail: string }[];
      const via = rows
        .map((r) => ({ action: r.action, detail: JSON.parse(r.detail) as any }))
        .filter((r) => r.detail.via === 'host_key' || r.detail.host_key);
      // Enroll writes its own grant.issue row beside the explicit one; each carries the marker.
      expect(new Set(via.map((r) => r.action))).toEqual(
        new Set(['bootstrap_credential.minted', 'grant.issue', 'residency.enrolled']),
      );
    });

    it('refuses another sponsor’s seat, a human seat, host-key minting and a foreign label', async () => {
      const { hostKey } = await setup();
      expect(
        (
          await post(
            '/teams/pv-t/agent-bootstrap-credentials',
            { use: 'claim_seat', target: 'eve-scout' },
            hostKey,
          )
        ).status,
      ).not.toBe(201);
      expect(
        (
          await post(
            '/teams/pv-t/agent-bootstrap-credentials',
            { use: 'claim_seat', target: 'dana' },
            hostKey,
          )
        ).status,
      ).not.toBe(201);
      expect(
        (
          await post(
            '/teams/pv-t/agent-bootstrap-credentials',
            { use: 'host', target: 'cloud-2' },
            hostKey,
          )
        ).status,
      ).not.toBe(201);
      expect(
        (
          await post(
            '/teams/pv-t/grants',
            { scope: 'seat', target: 'eve-scout', lifetime: 'standing' },
            hostKey,
          )
        ).status,
      ).not.toBe(201);
      expect(
        (
          await post(
            '/teams/pv-t/residency/enroll',
            { seat: 'dana-scout', harness: 'musterd', host: 'not-cloud-1' },
            hostKey,
          )
        ).status,
      ).toBe(403);
    });
  });
});
