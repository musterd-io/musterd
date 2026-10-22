import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { SPONSORED_AGENT_CAP, redeemAgentConnectNonce } from '../store/sponsoredAgents.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('sponsored-agents-http', (_o, kind) => {
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
    server = createServer({ db: await openTestDriver(kind), port: 0 });
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
      expect(r.json.connect_url).toMatch(
        new RegExp(`^${base}/join/sponsor-t#n=[A-Za-z0-9_-]{43}$`),
      );
      expect(r.json.connect_expires_at).toBeGreaterThan(Date.now());
      expect(JSON.stringify(r.json)).not.toMatch(/ms(cr|ac|at|kd)_/);

      const nonce = nonceOf(r.json.connect_url);
      const team = await requireTeam(server.store, 'sponsor-t');
      expect((await redeemAgentConnectNonce(server.store, team.id, nonce))?.agent.name).toBe(
        'dana-scout',
      );
    });

    it('writes the audit row naming sponsor and agent', async () => {
      const dana = await addHuman('dana');
      await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
      const row = (await server.store.get(
        "SELECT actor, target FROM audit WHERE action = 'member.sponsored_agent_created'",
      )) as { actor: string; target: string };
      expect(row).toEqual({ actor: 'dana', target: 'dana-scout' });
    });

    it('refuses without a credential', async () => {
      const r = await post('/teams/sponsor-t/members/agents', { name: 'x' });
      expect(r.status).toBe(401);
    });

    it('refuses past the per-sponsor cap', async () => {
      const dana = await addHuman('dana');
      for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
        expect(
          (await post('/teams/sponsor-t/members/agents', { name: `a${i}` }, dana)).status,
        ).toBe(201);
      const r = await post('/teams/sponsor-t/members/agents', { name: 'extra' }, dana);
      expect(r.status).toBe(403);
      expect(r.json.error.message).toMatch(/cap of/);
    });

    it('removing the sponsor disables the agent (§2 cascade)', async () => {
      const dana = await addHuman('dana');
      await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
      expect((await post('/teams/sponsor-t/members/dana/remove', {}, nick)).status).toBe(200);
      const row = (await server.store.get(
        "SELECT account_status FROM members WHERE name = 'dana-scout'",
      )) as { account_status: string };
      expect(row.account_status).toBe('disabled');
    });

    it('the per-team cap tunes the count (ADR 459 §3)', async () => {
      const dana = await addHuman('dana');
      expect((await post('/teams/sponsor-t/policy', { sponsored_agent_cap: 6 }, nick)).status).toBe(
        200,
      );
      for (let i = 0; i < 6; i++)
        expect(
          (await post('/teams/sponsor-t/members/agents', { name: `a${i}` }, dana)).status,
        ).toBe(201);
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
      const team = await requireTeam(server.store, 'sponsor-t');
      expect(await redeemAgentConnectNonce(server.store, team.id, oldNonce)).toBeNull();
      const newNonce = nonceOf(r.json.connect_url);
      expect((await redeemAgentConnectNonce(server.store, team.id, newNonce))?.agent.name).toBe(
        'dana-scout',
      );
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
});

withDrivers('sponsored-agents-http file-backed mint (ADR 700 decision 5)', (_o, kind) => {
  // The founder and the sponsor exist in the db BEFORE team.toml, so their credentials survive the
  // moment the team becomes file-backed. `mint-t` will not match any roster root on the machine.
  let server: RunningServer;
  let base: string;
  let root: string;
  let dana: string;

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

  function writeSeat(name: string, body: string) {
    writeFileSync(join(root, '.musterd', 'seats', `${name}.toml`), body);
  }

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    root = mkdtempSync(join(tmpdir(), 'mint-file-'));
    mkdirSync(join(root, '.musterd', 'seats'), { recursive: true });
    server = createServer({ db: await openTestDriver(kind), port: 0, rosterRoots: [root] });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const created = await post('/teams', {
      slug: 'mint-t',
      creator: { name: 'nick', kind: 'human' },
    });
    const nick = created.json.human_credential as string;
    dana = (await post('/teams/mint-t/members', { name: 'dana', kind: 'human' }, nick)).json
      .human_credential as string;
    writeFileSync(join(root, '.musterd', 'team.toml'), 'slug = "mint-t"\n');
    writeSeat('nick', 'kind = "human"\n');
    writeSeat('dana', 'kind = "human"\n');
  });

  afterEach(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function scout() {
    const team = await requireTeam(server.store, 'mint-t');
    return getMemberByName(server.store, team.id, 'scout');
  }

  async function createdFact() {
    return server.store.get<{ actor: string; target: string }>(
      "SELECT actor, target FROM audit WHERE action = 'member.sponsored_agent_created'",
    );
  }

  it('refuses a mint with no seat file and leaves no member (eval g)', async () => {
    const r = await post('/teams/mint-t/members/agents', { name: 'scout' }, dana);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/no seat file in the hub's roster root/);
    expect(await scout()).toBeUndefined();
    expect(await createdFact()).toBeFalsy();
  });

  it('refuses a seat file that names another sponsor, and leaves the file (eval g)', async () => {
    writeSeat('scout', 'kind = "agent"\nsponsored_by = "eve"\n');
    const r = await post('/teams/mint-t/members/agents', { name: 'scout' }, dana);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/sponsored by dana/);
    expect(await scout()).toBeUndefined();
    expect(await createdFact()).toBeFalsy();
  });

  it('refuses an agent seat file with no sponsor', async () => {
    writeSeat('scout', 'kind = "agent"\n');
    const r = await post('/teams/mint-t/members/agents', { name: 'scout' }, dana);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/sponsored_by unset/);
    expect(await scout()).toBeUndefined();
  });

  it('mints when the file names the caller, and records the fact', async () => {
    writeSeat('scout', 'kind = "agent"\nsponsored_by = "dana"\n');
    const r = await post('/teams/mint-t/members/agents', { name: 'scout', role: 'research' }, dana);
    expect(r.status).toBe(201);
    expect(r.json.member.name).toBe('scout');
    const team = await requireTeam(server.store, 'mint-t');
    const sponsor = await getMemberByName(server.store, team.id, 'dana');
    expect((await scout())?.sponsored_by).toBe(sponsor?.id);
    expect(await createdFact()).toEqual({ actor: 'dana', target: 'scout' });
  });

  it('still refuses an unknown host before creating anyone, file or not', async () => {
    writeSeat('scout', 'kind = "agent"\nsponsored_by = "dana"\n');
    const r = await post('/teams/mint-t/members/agents', { name: 'scout', host: 'nope' }, dana);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/not a host of yours/);
    expect(await scout()).toBeUndefined();
    expect(await createdFact()).toBeFalsy();
  });
});
