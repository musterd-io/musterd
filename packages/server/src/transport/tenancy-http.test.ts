import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { operatorCtx, type Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { openTestDriver } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { reaperTick } from '../presence/reaper.js';
import { insertProvision } from '../store/hostProvisions.js';
import { getMemberByName } from '../store/members.js';
import { createRequest } from '../store/requests.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from './hub.js';

/**
 * Spec §8.2 (ii) over the wire, on the PGlite double: two teams on one server, and the seam
 * (http.ts: `/teams/:slug` → `teamCtx`) is what keeps them apart — row-level security, not a code
 * check. Plus Review Focus 2: the loops the daemon runs on its own behalf see EVERY team.
 */
let server: RunningServer;
let base: string;
let op: Driver;
type Made = { slug: string; key: string; cred: string };
let a: Made;
let b: Made;

const mk = async (slug: string): Promise<Made> => {
  const r = await fetch(`${base}/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, creator: { name: 'nick', kind: 'human' } }),
  });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { agent_key: string; human_credential: string };
  return { slug, key: j.agent_key, cred: j.human_credential };
};
const get = (path: string, bearer: string) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

beforeAll(async () => {
  op = await openTestDriver('pglite');
  const traceDb = await openTestDriver('pglite');
  server = createServer({ db: op, traceDb, port: 0, rosterRoots: [] });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  a = await mk('alpha');
  b = await mk('beta');
});
afterAll(async () => {
  await server.close();
});

describe('tenancy over HTTP on Postgres (spec §8.2 ii)', () => {
  it("team A's credential reaches A's roster, is refused at B's, and B never appears in A's responses", async () => {
    expect((await get(`/teams/alpha/inbox`, a.cred)).status).toBe(200);
    expect((await get(`/teams/beta/inbox`, b.cred)).status).toBe(200);
    // The credential lookup runs inside beta's scope and cannot see alpha's row: RLS, not code.
    expect((await get(`/teams/beta/inbox`, a.cred)).status).toBe(401);
    expect((await get(`/teams/alpha/inbox`, b.cred)).status).toBe(401);
    const body = JSON.stringify(await (await get(`/teams/alpha/members`, a.cred)).json());
    expect(body).toContain('nick');
    expect(body).not.toContain('beta');
    // The public team summary resolves the slug as the operator, then scopes: both teams answer.
    expect((await fetch(`${base}/teams/beta`)).status).toBe(200);
    expect((await fetch(`${base}/teams/gamma`)).status).toBe(404);
  });

  it('the RunningServer raw handle is refused on a Postgres store', () => {
    expect(() => server.db).toThrow(/SQLite handle/);
  });

  it('/health sees the whole store (operator scope)', async () => {
    const h = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; schema: number };
    expect(h.ok).toBe(true);
    expect(h.schema).toBeGreaterThanOrEqual(81);
  });
});

describe('the loops run as the operator and touch every team (Review Focus 2)', () => {
  it('one reaper tick expires a pending claim request in BOTH teams', async () => {
    const config = resolveConfig({ port: 0 });
    const ctx: Ctx = operatorCtx({ db: op, traceDb: op, hub: new Hub(), config, rosterRoots: [] });
    for (const slug of ['alpha', 'beta']) {
      const team = (await getTeamBySlug(op, slug))!;
      const r = await createRequest(op, team.id, {
        kind: 'claim',
        from_session: `conn-${slug}`,
        target: 'seat:x',
      });
      await op.run('UPDATE requests SET expires_at = ? WHERE id = ?', [Date.now() - 1, r.id]);
    }
    await reaperTick(ctx)();
    const rows = await op.all<{ team_id: string; status: string }>(
      "SELECT team_id, status FROM requests WHERE from_session LIKE 'conn-%' ORDER BY team_id",
    );
    expect(rows.map((r) => r.status)).toEqual(['expired', 'expired']);
    expect(new Set(rows.map((r) => r.team_id)).size).toBe(2);
  });

  it('one provision sweep (server.runProvisionSweep) sweeps a stale provision in BOTH teams', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    for (const slug of ['alpha', 'beta']) {
      const team = (await getTeamBySlug(op, slug))!;
      const nick = (await getMemberByName(op, team.id, 'nick'))!;
      await insertProvision(op, team.id, nick.id, nick.id, old);
    }
    const swept = await server.runProvisionSweep(Date.now());
    expect(swept).toBe(2);
    const states = await op.all<{ team_id: string; state: string }>(
      'SELECT team_id, state FROM host_provisions ORDER BY team_id',
    );
    expect(states.map((s) => s.state)).toEqual(['cancelled', 'cancelled']);
    expect(new Set(states.map((s) => s.team_id)).size).toBe(2);
  });
});
