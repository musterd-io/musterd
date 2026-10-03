import { describe, expect, it } from 'vitest';
import { LADDER } from '../ladder.js';
import { pgliteDriver } from '../pgliteDriver.js';
import { TRACE_LADDER } from '../traceLadder.js';
import {
  assertSchemaCurrent,
  migratePostgres,
  migrateTracePostgres,
  PG_BASELINE_VERSION,
  PG_TRACE_BASELINE_VERSION,
  teamOwnedTables,
  verifyPostgresSchema,
} from './migrate.js';
import { GLOBAL_TABLES } from './tenancy.js';

describe('migratePostgres (spec §12.2)', () => {
  it('loads the baseline then the ladder on an empty database, records the version, and is idempotent', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    const latest = LADDER[LADDER.length - 1]!.version;
    expect(latest).toBeGreaterThan(PG_BASELINE_VERSION);
    expect(await migratePostgres(owner)).toBe(latest);
    expect(await migratePostgres(owner)).toBe(latest);
    const v = await owner.get<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    );
    expect(v?.value).toBe(String(latest));
    const tables = await owner.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(['teams', 'members', 'messages', 'audit', 'lanes', 'insights_fts']),
    );
    await d.close();
  });

  it('every team-owned table has RLS enabled, forced, and a tenant policy; globals have none', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const rows = await owner.all<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    expect(rows.length).toBeGreaterThan(40);
    const owned = await teamOwnedTables(owner);
    for (const r of rows) {
      if (GLOBAL_TABLES.includes(r.relname)) {
        expect(r.policies, r.relname).toBe(0);
        expect(owned, r.relname).not.toContain(r.relname);
      } else {
        expect(owned, r.relname).toContain(r.relname);
        expect(r.relrowsecurity && r.relforcerowsecurity, r.relname).toBe(true);
        expect(r.policies, r.relname).toBe(1);
      }
    }
    await d.close();
  });

  it('the roles exist with the spec §12.1 shape: app has no BYPASSRLS, operator does, none log in', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    const roles = await owner.all<{ rolname: string; rolbypassrls: boolean; rolcanlogin: boolean }>(
      "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'musterd\\_%' ORDER BY rolname",
    );
    expect(roles).toEqual([
      { rolname: 'musterd_app', rolbypassrls: false, rolcanlogin: false },
      { rolname: 'musterd_operator', rolbypassrls: true, rolcanlogin: false },
      { rolname: 'musterd_owner', rolbypassrls: false, rolcanlogin: false },
    ]);
    await d.close();
  });

  it('the trace store (ADR 445 §3) has its own baseline: trace_events under RLS, its own schema_meta', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    const latest = TRACE_LADDER.length
      ? TRACE_LADDER[TRACE_LADDER.length - 1]!.version
      : PG_TRACE_BASELINE_VERSION;
    expect(await migrateTracePostgres(owner)).toBe(latest);
    expect(await migrateTracePostgres(owner)).toBe(latest);
    const tables = (
      await owner.all<{ t: string }>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      )
    ).map((r) => r.t);
    expect(tables).toEqual(['schema_meta', 'trace_events']);
    expect(await teamOwnedTables(owner)).toEqual(['trace_events']);
    await d
      .asOperator()
      .run(
        "INSERT INTO trace_events (id, team_id, seat, session_digest, seq, ts, received_at, harness, kind) VALUES ('e','A','s','d',1,1,1,'h','Stop')",
      );
    expect((await d.all('SELECT id FROM trace_events')).length).toBe(0);
    expect((await d.forTeam('A').all('SELECT id FROM trace_events')).length).toBe(1);
    await d.close();
  });
});

/**
 * ADR 496: the version row is a claim, not evidence. musterd-1b sat at v84 with a `lanes` table that
 * never got v81's columns (migrated from a branch before the ladder's numbers were final), and
 * every lane UPDATE failed while `migratePostgres` reported it current. After the ladder, the live
 * catalog is compared with what baseline + ladder land on.
 */
describe('the landed schema is verified against the catalog (ADR 496)', () => {
  async function driftedMain() {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    const latest = await migratePostgres(owner);
    // The 2026-10-02 shape exactly: the row says v84, the table lacks v81.
    await owner.exec('ALTER TABLE lanes DROP COLUMN follows_up_json, DROP COLUMN abandon_reason');
    return { d, owner, latest };
  }
  const version = async (owner: Awaited<ReturnType<typeof driftedMain>>['owner']) =>
    (
      await owner.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'schema_version'",
      )
    )?.value;

  it('a database whose version row claims a step it never got refuses with `schema drift`, naming the columns', async () => {
    const { d, owner, latest } = await driftedMain();
    await expect(migratePostgres(owner)).rejects.toThrow(
      'schema drift: missing lanes.abandon_reason, lanes.follows_up_json',
    );
    expect(await version(owner)).toBe(String(latest));
    await d.close();
  });

  it('repair replays the ladder, restores the columns, reports what it repaired, and leaves the version row alone', async () => {
    const { d, owner, latest } = await driftedMain();
    const reported: string[] = [];
    expect(await migratePostgres(owner, { repair: true, report: (m) => reported.push(m) })).toBe(
      latest,
    );
    expect(reported).toEqual([
      'schema drift repaired: lanes.abandon_reason, lanes.follows_up_json',
    ]);
    expect(await verifyPostgresSchema(owner, 'main')).toEqual({ missing: [], extra: [] });
    expect(await version(owner)).toBe(String(latest));
    // Clean afterwards: nothing to repair, nothing reported.
    const again: string[] = [];
    await migratePostgres(owner, { repair: true, report: (m) => again.push(m) });
    expect(again).toEqual([]);
    await d.close();
  });

  it('an extra table or column is reported, never drift — and a table the ladder does not know gets no policy, not a crash', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    const latest = await migratePostgres(owner);
    // The lanes.test fixture's shape: a scratch table with no team_id at all. Before ADR 496 the
    // policy loop applied `team_id = current_setting(...)` to it and the migrate step died.
    await owner.exec(
      'ALTER TABLE lanes ADD COLUMN scratch TEXT; CREATE TABLE title_writes (at BIGINT)',
    );
    const reported: string[] = [];
    expect(await migratePostgres(owner, { report: (m) => reported.push(m) })).toBe(latest);
    expect(reported).toEqual([
      "schema extras (not the ladder's, left alone): lanes.scratch, title_writes",
    ]);
    expect(await verifyPostgresSchema(owner, 'main')).toEqual({
      missing: [],
      extra: ['lanes.scratch', 'title_writes'],
    });
    const policies = await owner.all<{ tablename: string }>(
      "SELECT tablename FROM pg_policies WHERE tablename = 'title_writes'",
    );
    expect(policies).toEqual([]);
    await d.close();
  });

  it('boot refuses a drifted schema as it refuses an older or newer one', async () => {
    const { d, owner } = await driftedMain();
    await expect(assertSchemaCurrent(owner, 'main')).rejects.toThrow('schema drift');
    await d.close();
  });

  it('the trace store is verified against its own ladder', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migrateTracePostgres(owner);
    await owner.exec('ALTER TABLE trace_events DROP COLUMN tool_use_id');
    await expect(migrateTracePostgres(owner)).rejects.toThrow(
      'schema drift: missing trace_events.tool_use_id',
    );
    await d.close();
  });
});
