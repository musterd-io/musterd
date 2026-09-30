import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteDriver } from '../db/sqliteDriver.js';
import { openTestDb } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { SPONSORED_AGENT_CAP, redeemAgentConnectNonce } from '../store/sponsoredAgents.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

/**
 * ADR 449 §3–4 through HTTP: `POST /teams/:slug/members/agents` (a human member mints an agent they
 * sponsor, getting a connect link and no secret) and `POST …/members/agents/:name/connect` (the
 * sponsor re-issues that link). Removing the sponsor takes the agent with it (§2's cascade, already
 * on the remove route) — asserted here end to end because this is the first route that makes one.
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

/** The nonce from a connect link's `#n=` fragment. */
function nonceOf(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('n')!;
}

async function addHuman(name: string): Promise<string> {
  const r = await post('/teams/sponsor-t/members', { name, kind: 'human' }, nick);
  return r.json.human_credential as string;
}

beforeEach(async () => {
  // The mint bucket is per-IP and module-level: every test server here shares loopback, so a
  // previous test's mints would spend this test's budget without the reset (ADR 459 §2).
  __resetOAuthBucketsForTest();
  server = createServer({ db: openTestDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const r = await post('/teams', { slug: 'sponsor-t', creator: { name: 'nick', kind: 'human' } });
  nick = r.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('POST /teams/:slug/members/agents', () => {
  it('a human member mints a sponsored agent and gets a fragment connect link — no secret', async () => {
    const dana = await addHuman('dana');
    const r = await post(
      '/teams/sponsor-t/members/agents',
      { name: 'dana-scout', role: 'research' },
      dana,
    );
    expect(r.status).toBe(201);
    expect(r.json.member.name).toBe('dana-scout');
    expect(r.json.member.kind).toBe('agent');
    expect(r.json.connect_url).toMatch(new RegExp(`^${base}/join/sponsor-t#n=[A-Za-z0-9_-]{43}$`));
    expect(r.json.connect_expires_at).toBeGreaterThan(Date.now());
    expect(JSON.stringify(r.json)).not.toMatch(/ms(cr|ac|at|kd)_/);

    const nonce = nonceOf(r.json.connect_url);
    const team = await requireTeam(sqliteDriver(server.db), 'sponsor-t');
    expect(
      (await redeemAgentConnectNonce(sqliteDriver(server.db), team.id, nonce))?.agent.name,
    ).toBe('dana-scout');
  });

  it('writes the audit row naming sponsor and agent', async () => {
    const dana = await addHuman('dana');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const row = server.db
      .prepare("SELECT actor, target FROM audit WHERE action = 'member.sponsored_agent_created'")
      .get() as { actor: string; target: string };
    expect(row).toEqual({ actor: 'dana', target: 'dana-scout' });
  });

  it('refuses without a credential', async () => {
    const r = await post('/teams/sponsor-t/members/agents', { name: 'x' });
    expect(r.status).toBe(401);
  });

  it('refuses past the per-sponsor cap', async () => {
    const dana = await addHuman('dana');
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      expect((await post('/teams/sponsor-t/members/agents', { name: `a${i}` }, dana)).status).toBe(
        201,
      );
    const r = await post('/teams/sponsor-t/members/agents', { name: 'extra' }, dana);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/cap of/);
  });

  it('removing the sponsor disables the agent (§2 cascade)', async () => {
    const dana = await addHuman('dana');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    expect((await post('/teams/sponsor-t/members/dana/remove', {}, nick)).status).toBe(200);
    const row = server.db
      .prepare("SELECT account_status FROM members WHERE name = 'dana-scout'")
      .get() as { account_status: string };
    expect(row.account_status).toBe('disabled');
  });

  it('the per-team cap tunes the count (ADR 459 §3)', async () => {
    const dana = await addHuman('dana');
    expect((await post('/teams/sponsor-t/policy', { sponsored_agent_cap: 6 }, nick)).status).toBe(
      200,
    );
    for (let i = 0; i < 6; i++)
      expect((await post('/teams/sponsor-t/members/agents', { name: `a${i}` }, dana)).status).toBe(
        201,
      );
    const r = await post('/teams/sponsor-t/members/agents', { name: 'extra' }, dana);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/cap of 6/);
  });

  it('the 11th mint in a minute from one IP is rate_limited (ADR 459 §2)', async () => {
    // Four sponsors × three agents: the per-sponsor cap never fires, so only the IP bucket can.
    const creds = [];
    for (const name of ['s0', 's1', 's2', 's3']) creds.push(await addHuman(name));
    for (let i = 0; i < 10; i++) {
      const r = await post(
        '/teams/sponsor-t/members/agents',
        { name: `r${i}` },
        creds[Math.floor(i / 3)]!,
      );
      expect(r.status).toBe(201);
    }
    const over = await post('/teams/sponsor-t/members/agents', { name: 'r10' }, creds[3]!);
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('rate_limited');
  });
});

describe('POST /teams/:slug/members/agents/:name/connect', () => {
  it('the sponsor re-issues the link, and the old one dies', async () => {
    const dana = await addHuman('dana');
    const made = await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const oldNonce = nonceOf(made.json.connect_url);
    const r = await post('/teams/sponsor-t/members/agents/dana-scout/connect', {}, dana);
    expect(r.status).toBe(200);
    const team = await requireTeam(sqliteDriver(server.db), 'sponsor-t');
    expect(await redeemAgentConnectNonce(sqliteDriver(server.db), team.id, oldNonce)).toBeNull();
    const newNonce = nonceOf(r.json.connect_url);
    expect(
      (await redeemAgentConnectNonce(sqliteDriver(server.db), team.id, newNonce))?.agent.name,
    ).toBe('dana-scout');
  });

  it("under the default 'sponsor' policy another member cannot mint a link to dana's agent (ADR 456 §2)", async () => {
    const dana = await addHuman('dana');
    const eve = await addHuman('eve');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const r = await post('/teams/sponsor-t/members/agents/dana-scout/connect', {}, eve);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/sponsor or an admin/);
  });
});
