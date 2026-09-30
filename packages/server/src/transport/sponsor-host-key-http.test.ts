import { GENERALIST_CAPABILITIES, makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteDriver } from '../db/sqliteDriver.js';
import { openTestDb } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { insertRing } from '../store/doorbell.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

/**
 * ADR 463 §1, Review Focus 1: a host key minted by a sponsor sees only that sponsor's seats — wake
 * leases, lease reports, and doorbell rings — even on a host label other seats share.
 */
let server: RunningServer;
let base: string;
let nick: string;
let teamKey: string;

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
  const r = await post('/teams/hk-t/members', { name, kind: 'human' }, nick);
  return r.json.human_credential as string;
}

async function directedTo(seat: string, id: string): Promise<void> {
  const r = await post(
    '/teams/hk-t/messages',
    {
      envelope: makeEnvelope({
        id,
        team: 'hk-t',
        from: 'nick',
        to: { kind: 'member', name: seat },
        act: 'message',
        body: 'hi',
        meta: { urgent: true, urgent_reason: 'wake me' },
      }),
    },
    nick,
  );
  expect(r.status).toBe(201);
}

async function ringFor(name: string, host: string): void {
  const team = await requireTeam(sqliteDriver(server.db), 'hk-t');
  await insertRing(sqliteDriver(server.db), {
    team_id: team.id,
    member_id: (await getMemberByName(sqliteDriver(server.db), team.id, name))!.id,
    act_id: `ring-${name}`,
    record: {
      team: 'hk-t',
      from: 'nick',
      act: 'ask',
      act_id: `ring-${name}`,
      answer_path: '/live',
    },
    sinks: ['os'],
    state: 'queued',
    host,
  });
}

/** dana and eve each sponsor an agent, both enrolled on the SAME host label, both due. */
async function sharedHost(): Promise<{ dana: string; eve: string }> {
  const dana = await addHuman('dana');
  const eve = await addHuman('eve');
  await post('/teams/hk-t/members/agents', { name: 'dana-scout' }, dana);
  await post('/teams/hk-t/members/agents', { name: 'eve-scout' }, eve);
  for (const [seat, who] of [
    ['dana-scout', dana],
    ['eve-scout', eve],
  ] as const) {
    const en = await post(
      '/teams/hk-t/residency/enroll',
      { seat, harness: 'claude-code', host: 'shared' },
      who,
    );
    expect(en.status).toBe(201);
  }
  await directedTo('dana-scout', 'd1');
  await directedTo('eve-scout', 'e1');
  return { dana, eve };
}

beforeEach(async () => {
  __resetOAuthBucketsForTest();
  server = createServer({ db: openTestDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const r = await post('/teams', { slug: 'hk-t', creator: { name: 'nick', kind: 'human' } });
  nick = r.json.human_credential;
  teamKey = r.json.agent_key;
});

afterEach(async () => {
  await server.close();
});

describe('sponsor host key (ADR 463 §1, Review Focus 1)', () => {
  it('a sponsor mints a host key; a member with creation withdrawn cannot', async () => {
    const eve = await addHuman('eve');
    const team = await requireTeam(sqliteDriver(server.db), 'hk-t');
    await setMemberGovernance(
      sqliteDriver(server.db),
      (await getMemberByName(sqliteDriver(server.db), team.id, 'eve'))!.id,
      null,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, can_create_agents: false }),
    );
    const refused = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'eve-mbp' },
      eve,
    );
    expect(refused.status).toBe(403);
    const dana = await addHuman('dana');
    const hk = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'dana-mbp' },
      dana,
    );
    expect(hk.status).toBe(201);
    const row = server.db
      .prepare("SELECT detail FROM audit WHERE action = 'bootstrap_credential.minted'")
      .get() as { detail: string };
    expect(JSON.parse(row.detail).sponsor_scoped).toBe(true);
  });

  it('polls wake-leases and sees only the sponsor’s seats on a shared label', async () => {
    const { dana } = await sharedHost();
    const hk = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'shared' },
      dana,
    );
    const leases = await post(
      '/teams/hk-t/residency/wake-leases',
      { host: 'shared' },
      hk.json.agent_key,
    );
    expect(leases.status).toBe(200);
    expect(leases.json.orders.map((o: any) => o.seat)).toEqual(['dana-scout']);
  });

  it.each([
    ['can_create_agents withdrawn', { account: null, caps: { can_create_agents: false } }, 403],
    ['sponsor disabled', { account: 'disabled', caps: {} }, 403],
    ['sponsor banned', { account: 'banned', caps: {} }, 403],
  ] as const)(
    'big-body REQUIRED: a key minted while hosting was allowed stops serving once %s',
    async (_label, change, status) => {
      const { dana } = await sharedHost();
      const hk = await post(
        '/teams/hk-t/agent-bootstrap-credentials',
        { use: 'host', target: 'shared' },
        dana,
      );
      expect(hk.status).toBe(201);
      const ok = await post(
        '/teams/hk-t/residency/wake-leases',
        { host: 'shared' },
        hk.json.agent_key,
      );
      expect(ok.status).toBe(200);
      const team = await requireTeam(sqliteDriver(server.db), 'hk-t');
      await setMemberGovernance(
        sqliteDriver(server.db),
        (await getMemberByName(sqliteDriver(server.db), team.id, 'dana'))!.id,
        change.account,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, ...change.caps }),
      );
      const leases = await post(
        '/teams/hk-t/residency/wake-leases',
        { host: 'shared' },
        hk.json.agent_key,
      );
      expect(leases.status).toBe(status);
      const rings = await post('/teams/hk-t/doorbell/rings', { host: 'shared' }, hk.json.agent_key);
      expect(rings.status).toBe(status);
    },
  );

  it('big-body REQUIRED: an admin host key on the same label wakes no sponsored seat — only unsponsored ones', async () => {
    await sharedHost();
    await post('/teams/hk-t/members', { name: 'ops-bot', kind: 'agent' }, nick);
    await post(
      '/teams/hk-t/residency/enroll',
      { seat: 'ops-bot', harness: 'claude-code', host: 'shared' },
      nick,
    );
    await directedTo('ops-bot', 'o1');
    const hk = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'shared' },
      nick,
    );
    const leases = await post(
      '/teams/hk-t/residency/wake-leases',
      { host: 'shared' },
      hk.json.agent_key,
    );
    expect(leases.json.orders.map((o: any) => o.seat)).toEqual(['ops-bot']);
  });

  it('big-body REQUIRED: the legacy team key never wakes a sponsored seat either', async () => {
    await sharedHost();
    expect(teamKey).toMatch(/^mskey_/);
    const leases = await post('/teams/hk-t/residency/wake-leases', { host: 'shared' }, teamKey);
    expect(leases.status).toBe(200);
    expect(leases.json.orders).toEqual([]);
  });

  it('an admin who sponsors an agent wakes it from their own host key', async () => {
    await post('/teams/hk-t/members/agents', { name: 'nick-scout' }, nick);
    await post(
      '/teams/hk-t/residency/enroll',
      { seat: 'nick-scout', harness: 'claude-code', host: 'nick-mbp' },
      nick,
    );
    await directedTo('nick-scout', 'n1');
    const hk = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'nick-mbp' },
      nick,
    );
    const leases = await post(
      '/teams/hk-t/residency/wake-leases',
      { host: 'nick-mbp' },
      hk.json.agent_key,
    );
    expect(leases.json.orders.map((o: any) => o.seat)).toEqual(['nick-scout']);
  });

  it('cannot report on a lease of a seat it does not sponsor', async () => {
    const { dana, eve } = await sharedHost();
    const danaKey = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'shared' },
      dana,
    );
    const leases = await post(
      '/teams/hk-t/residency/wake-leases',
      { host: 'shared' },
      danaKey.json.agent_key,
    );
    const danaLease = leases.json.orders.find((o: any) => o.seat === 'dana-scout').lease_id;
    const eveKey = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'shared' },
      eve,
    );
    const progress = await post(
      '/teams/hk-t/residency/wake-progress',
      { lease_id: danaLease },
      eveKey.json.agent_key,
    );
    expect(progress.status).toBe(404);
  });

  it('claims only the sponsor’s own doorbell rings on its label', async () => {
    const dana = await addHuman('dana');
    await addHuman('eve');
    await ringFor('dana', 'shared');
    await ringFor('eve', 'shared');
    const hk = await post(
      '/teams/hk-t/agent-bootstrap-credentials',
      { use: 'host', target: 'shared' },
      dana,
    );
    const r = await post('/teams/hk-t/doorbell/rings', { host: 'shared' }, hk.json.agent_key);
    expect(r.status).toBe(200);
    expect(r.json.rings.map((x: any) => x.member)).toEqual(['dana']);
  });

  it('/residency/revoke parses before it authenticates: a bad body unauthenticated is a 400', async () => {
    const r = await post('/teams/hk-t/residency/revoke', { nope: 1 });
    expect(r.status).toBe(400);
  });
});
