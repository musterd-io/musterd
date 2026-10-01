import { describe, expect, it } from 'vitest';
import { LADDER } from '../ladder.js';
import { pgliteDriver } from '../pgliteDriver.js';
import { TRACE_LADDER } from '../traceLadder.js';
import {
  migratePostgres,
  migrateTracePostgres,
  PG_BASELINE_VERSION,
  PG_TRACE_BASELINE_VERSION,
  teamOwnedTables,
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
