import { readFileSync } from 'node:fs';
import type { Driver } from '../driver.js';
import { assertSchemaNotNewer } from '../guard.js';
import { LADDER, type PortableMigration } from '../ladder.js';
import { TRACE_LADDER } from '../traceLadder.js';
import { GLOBAL_TABLES, tenantPolicySql } from './tenancy.js';

/**
 * Spec §12.2: the Postgres schema is a frozen, hand-checked baseline at SQLite ladder v80
 * (`0080-baseline.sql`) followed by the portable `LADDER` from v81. The baseline was generated
 * once from the SQLite DDL (the spike's Q1 rules) and is owned by hand from then on; `drift.test.ts`
 * keeps the two engines' table/column sets equal.
 */
export const PG_BASELINE_VERSION = 80;
/** The trace store (ADR 445 §3) has its own baseline and ladder: `trace-0003-baseline.sql`. */
export const PG_TRACE_BASELINE_VERSION = 3;

interface StoreSpec {
  baseline: URL;
  baselineVersion: number;
  ladder: PortableMigration[];
}
const MAIN: StoreSpec = {
  baseline: new URL('./0080-baseline.sql', import.meta.url),
  baselineVersion: PG_BASELINE_VERSION,
  ladder: LADDER,
};
const TRACE: StoreSpec = {
  baseline: new URL('./trace-0003-baseline.sql', import.meta.url),
  baselineVersion: PG_TRACE_BASELINE_VERSION,
  ladder: TRACE_LADDER,
};

const SET_VERSION =
  "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";

async function schemaVersion(d: Driver): Promise<number> {
  const t = await d.get<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_meta'",
  );
  if (!t || t.n === 0) return 0;
  const row = await d.get<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'schema_version'",
  );
  return row ? Number(row.value) : 0;
}

/** Every base table in `public` that is not global — the set the tenant policies cover. */
export async function teamOwnedTables(d: Driver): Promise<string[]> {
  const rows = await d.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name).filter((t) => !GLOBAL_TABLES.includes(t));
}

/**
 * Runs as the OWNER (spec §6: migration is a separate step, before the rollout, never the app
 * role). `owner` is an owner-scoped handle — `pgliteDriver().asOwner()` in tests, the owner URL's
 * driver in a deployment. Idempotent: a second run applies nothing and re-derives the policies.
 * Returns the schema version the database is at afterwards.
 */
export async function migratePostgres(owner: Driver): Promise<number> {
  return migrateStore(owner, MAIN);
}

/** The trace store's twin: run against the trace database (a separate database in Cloud). */
export async function migrateTracePostgres(owner: Driver): Promise<number> {
  return migrateStore(owner, TRACE);
}

async function migrateStore(owner: Driver, spec: StoreSpec): Promise<number> {
  let have = await schemaVersion(owner);
  const max = spec.ladder.length
    ? spec.ladder[spec.ladder.length - 1]!.version
    : spec.baselineVersion;
  assertSchemaNotNewer(have, max);
  if (have === 0) {
    await owner.exec(readFileSync(spec.baseline, 'utf8'));
    await owner.run(SET_VERSION, [String(spec.baselineVersion)]);
    have = spec.baselineVersion;
  }
  for (const m of spec.ladder) {
    if (m.version <= have) continue;
    await owner.tx(async (t) => {
      if (m.sql !== undefined) await t.exec(m.sql);
      else await m.postgres!(t);
      await t.run(SET_VERSION, [String(m.version)]);
    });
    have = m.version;
  }
  // Policies are derived, so they are (re)applied on every run: a table added by a migration is
  // covered the moment it exists, and a hand edit cannot leave one table without its policy.
  for (const t of await teamOwnedTables(owner)) await owner.exec(tenantPolicySql(t));
  return have;
}
