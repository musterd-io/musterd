import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { appendAudit, listAudit } from '../store/audit.js';
import { getCursor, setCursor } from '../store/cursors.js';
import { issueGrant } from '../store/grants.js';
import { insertProvision } from '../store/hostProvisions.js';
import { getLane, listLanes, openLane, updateLane } from '../store/lanes.js';
import { addMember, listMembers, mintCredential } from '../store/members.js';
import { getMemory, saveMemory } from '../store/memory.js';
import { insertMessage, listTeamMessages } from '../store/messages.js';
import { attach, listPresence } from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import { enrollResidency, listResidency } from '../store/residency.js';
import { createTeam } from '../store/teams.js';
import type { Driver } from './driver.js';
import { migratePostgres, teamOwnedTables } from './pg/migrate.js';
import { GLOBAL_TABLES } from './pg/tenancy.js';
import { pgliteDriver } from './pgliteDriver.js';

/**
 * One team, one row in as many team-owned tables as the store's own creators reach: the store paths
 * are what (ii) is about — a leak through a join, a subquery, a cache — not the policy shape, which
 * (i) proves for every table at once. Returns what (ii) reads back by id.
 */
async function seedTeam(op: Driver, slug: string) {
  const team = await createTeam(op, { slug, display: slug });
  const nick = (await addMember(op, team, { name: 'nick', kind: 'human' })).row;
  const agent = (await addMember(op, team, { name: `${slug}-agent`, kind: 'agent' })).row;
  await mintCredential(op, nick.id);
  const lane = await openLane(op, team.id, slug, 'nick', { title: `${slug} lane` });
  const msgId = `01M${slug.toUpperCase().padEnd(23, '0')}`;
  await insertMessage(
    op,
    team.id,
    nick.id,
    null,
    makeEnvelope({
      id: msgId,
      team: slug,
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message',
      body: `${slug} hello`,
      ts: 1000,
      meta: null,
    }),
  );
  await appendAudit(op, team.id, {
    actor: 'nick',
    action: 'presence.attached',
    target: 'nick',
    result: 'allow',
  });
  await enrollResidency(op, team.id, {
    member_id: agent.id,
    harness: 'claude-code',
    host: `${slug}-host`,
    grant_id: null,
    authorized_by: 'nick',
  });
  await saveMemory(op, agent.id, { headline: `${slug} memo`, body: 'b' });
  await setCursor(op, nick.id, msgId);
  await attach(op, agent.id, 'cli', null);
  await issueGrant(
    op,
    team.id,
    { scope: 'seat', target: agent.name, lifetime: 'standing' },
    nick.id,
  );
  await createRequest(op, team.id, {
    kind: 'claim',
    from_session: `${slug}-conn`,
    target: 'seat:x',
  });
  await insertProvision(op, team.id, agent.id, nick.id);
  return { team, nick, agent, lane, msgId };
}

/**
 * Spec §8.2 / §12 — the tenancy leak test, on the PGlite double in CI and on real Postgres in the
 * Neon pass. Parts (i) and (iv) here (1B task 4); (ii) cross-tenant through the store's own paths
 * and (iii) alternating tenants on one connection arrive with the seam (task 10).
 */
describe('tenancy (spec §8.2, §12) — inventory and fail-closed', () => {
  it('(i) every public table is team-owned (RLS forced + tenant policy) or in GLOBAL_TABLES', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const all = (
      await owner.all<{ t: string }>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      )
    ).map((r) => r.t);
    expect(all.length).toBeGreaterThan(40);
    const owned = await teamOwnedTables(owner);
    for (const t of all) {
      const isGlobal = GLOBAL_TABLES.includes(t);
      const isOwned = owned.includes(t);
      expect(isGlobal !== isOwned, `${t} must be exactly one of global/team-owned`).toBe(true);
      if (isOwned) {
        const cols = (
          await owner.all<{ c: string }>(
            'SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?',
            [t],
          )
        ).map((r) => r.c);
        expect(cols.includes('team_id') || t === 'teams', `${t} lacks team_id`).toBe(true);
        const pol = await owner.get<{ rls: boolean; forced: boolean; n: number }>(
          `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                  (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant') AS n
             FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'public' AND c.relname = ?`,
          [t],
        );
        expect(pol, t).toEqual({ rls: true, forced: true, n: 1 });
      }
    }
    await d.close();
  });

  it('(iv) the bare handle reads 0 and writes 0 rows on every team-owned table; the operator sees them', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const op = d.asOperator();
    // Seeding one row per team-owned table through the store is task 10's job; the teams row is
    // enough to prove the mechanism on the table with the most privileged policy.
    await op.run(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('A','a','A',1,1)",
    );
    for (const t of await teamOwnedTables(owner)) {
      expect((await d.all(`SELECT 1 FROM "${t}" LIMIT 1`)).length, t).toBe(0);
      expect((await d.run(`DELETE FROM "${t}"`)).changes, t).toBe(0);
    }
    expect((await op.all('SELECT id FROM teams')).length).toBe(1);
    await d.close();
  });

  it('(ii) through the store: a team handle reads only its rows, writes nothing into another team', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const op = d.asOperator();
    const A = await seedTeam(op, 'alpha');
    const B = await seedTeam(op, 'beta');
    // Coverage: which team-owned tables the seed reached (both teams, ≥ 1 row each) — the list is
    // what (ii) actually proves; a table missing here is proved by (i)/(iv) only.
    const seeded: string[] = [];
    for (const t of await teamOwnedTables(owner)) {
      const col = t === 'teams' ? 'id' : 'team_id';
      const n = await op.all<{ team_id: string; n: number }>(
        `SELECT ${col} AS team_id, COUNT(*)::int AS n FROM "${t}" GROUP BY ${col}`,
      );
      if (n.some((r) => r.team_id === A.team.id) && n.some((r) => r.team_id === B.team.id))
        seeded.push(t);
    }
    expect(seeded).toEqual(
      expect.arrayContaining([
        'teams',
        'members',
        'lanes',
        'messages',
        'audit',
        'residency',
        'seat_memory',
        'inbox_cursors',
        'presence',
        'grants',
        'requests',
        'host_provisions',
      ]),
    );
    const a = d.forTeam(A.team.id);
    // Reads through the store's own paths return A's rows only.
    expect((await listMembers(a, A.team.id)).map((m) => m.name).sort()).toEqual([
      'alpha-agent',
      'nick',
    ]);
    expect((await listMembers(a, B.team.id)).length).toBe(0);
    expect((await listLanes(a, A.team.id, 'alpha')).map((l) => l.title)).toEqual(['alpha lane']);
    expect((await listLanes(a, B.team.id, 'beta')).length).toBe(0);
    expect((await listTeamMessages(a, A.team.id)).map((m) => m.body)).toEqual(['alpha hello']);
    expect((await listTeamMessages(a, B.team.id)).length).toBe(0);
    expect((await listAudit(a, A.team.id)).every((r) => r.team_id === A.team.id)).toBe(true);
    expect((await listAudit(a, B.team.id)).length).toBe(0);
    expect((await listResidency(a, A.team.id)).map((r) => r.host)).toEqual(['alpha-host']);
    expect((await listResidency(a, B.team.id)).length).toBe(0);
    expect((await getMemory(a, A.agent.id))?.headline).toBe('alpha memo');
    expect(await getMemory(a, B.agent.id)).toBeNull();
    expect((await getCursor(a, A.nick.id)).last_read_message_id).toBe(A.msgId);
    expect((await getCursor(a, B.nick.id)).last_read_message_id).toBeNull();
    expect(
      (await listPresence(a, A.team.id, 60_000)).some((p) => p.member.name === 'alpha-agent'),
    ).toBe(true);
    expect((await listPresence(a, B.team.id, 60_000)).length).toBe(0);
    expect(await getLane(a, B.team.id, B.lane.id, 'beta')).toBeNull();
    // Writes aimed at B through A's handle touch nothing — by id, by raw SQL, by the store.
    expect(await updateLane(a, B.team.id, B.lane.id, 'beta', { title: 'x' })).toBeNull();
    expect((await a.run('DELETE FROM lanes WHERE id = ?', [B.lane.id])).changes).toBe(0);
    expect(
      (await a.run('UPDATE members SET name = ? WHERE team_id = ?', ['pwned', B.team.id])).changes,
    ).toBe(0);
    await expect(
      a.run(
        'INSERT INTO lanes (id, team_id, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['L-B', B.team.id, 'smuggled', 'open', 1, 1],
      ),
    ).rejects.toThrow(/row-level security/);
    // B is intact, as the operator sees it.
    expect((await listLanes(op, B.team.id, 'beta')).map((l) => l.title)).toEqual(['beta lane']);
    expect((await listMembers(op, B.team.id)).map((m) => m.name).sort()).toEqual([
      'beta-agent',
      'nick',
    ]);
    await d.close();
  });

  it('(iii) alternating tenants on ONE connection: every statement and every tx body sees exactly its team, throws included', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const op = d.asOperator();
    const A = await seedTeam(op, 'alpha');
    const B = await seedTeam(op, 'beta');
    const teams = [A.team.id, B.team.id];
    const visible = async (h: Driver) =>
      (await h.all<{ id: string }>('SELECT id FROM teams')).map((r) => r.id);
    for (let i = 0; i < 200; i++) {
      const current = teams[i % 2]!;
      const h = d.forTeam(current);
      if (i % 3 === 0) {
        expect(await visible(h), `iteration ${i}`).toEqual([current]);
      } else {
        const body = h.tx(async (t) => {
          expect(await visible(t), `iteration ${i} (tx)`).toEqual([current]);
          await t.run('UPDATE teams SET display = ? WHERE id = ?', [`d${i}`, current]);
          if (i % 7 === 0) throw new Error(`boom ${i}`);
        });
        if (i % 7 === 0) await expect(body).rejects.toThrow(`boom ${i}`);
        else await body;
      }
      // The bare handle still sees nothing: no stamp leaked past a transaction.
      expect(await visible(d), `iteration ${i} (bare)`).toEqual([]);
    }
    // Every write landed on its own team's row only; the rolled-back ones are absent.
    const rows = await op.all<{ id: string; display: string }>(
      'SELECT id, display FROM teams ORDER BY id',
    );
    expect(rows.length).toBe(2);
    for (const r of rows)
      expect(r.display.startsWith('d') || r.display === 'alpha' || r.display === 'beta').toBe(true);
    await d.close();
  });
});
