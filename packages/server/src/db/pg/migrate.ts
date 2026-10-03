import { readFileSync } from 'node:fs';
import type { Driver } from '../driver.js';
import { assertSchemaNotNewer, assertSchemaNotOlder, SCHEMA_DRIFT_SENTENCE } from '../guard.js';
import { LADDER, type PortableMigration } from '../ladder.js';
import { TRACE_LADDER } from '../traceLadder.js';
import { expectedSchema, type StoreName } from './expectedSchema.js';
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
  name: StoreName;
  baseline: URL;
  baselineVersion: number;
  ladder: PortableMigration[];
}
const MAIN: StoreSpec = {
  name: 'main',
  baseline: new URL('./0080-baseline.sql', import.meta.url),
  baselineVersion: PG_BASELINE_VERSION,
  ladder: LADDER,
};
const TRACE: StoreSpec = {
  name: 'trace',
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
export async function migratePostgres(owner: Driver, opts: MigrateOptions = {}): Promise<number> {
  return migrateStore(owner, MAIN, opts);
}

/** The trace store's twin: run against the trace database (a separate database in Cloud). */
export async function migrateTracePostgres(
  owner: Driver,
  opts: MigrateOptions = {},
): Promise<number> {
  return migrateStore(owner, TRACE, opts);
}

export interface MigrateOptions {
  /**
   * When the catalog lacks something the ladder lands, replay every ladder step (idempotent by
   * contract — `db.test.ts` runs the ladder twice) and verify again. Never the default: a repair
   * is a decision the operator makes with the drift in front of them (ADR 496).
   */
  repair?: boolean;
  /** Where a repair is reported, one line naming what came back (the migrate scripts print it). */
  report?: (line: string) => void;
}

/** What a live database lacks or carries beyond the ladder: `table` or `table.column`, sorted. */
export interface SchemaDrift {
  missing: string[];
  extra: string[];
}

/**
 * ADR 496: the live `public` base tables and their columns against what baseline + ladder land on
 * (`expectedSchema`). Read from `pg_catalog`, which every role sees whole — `information_schema`
 * hides what the current role holds no privilege on, and a boot-time check as the operator must
 * not mistake a missing GRANT for a missing column. `missing` is drift; `extra` is reported only
 * (operators and fixtures add things, and a contract step removes what the ladder decided).
 */
export async function verifyPostgresSchema(d: Driver, store: StoreName): Promise<SchemaDrift> {
  const expected = expectedSchema(store);
  const rows = await d.all<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const live = new Map<string, Set<string>>();
  for (const r of rows) {
    let cols = live.get(r.t);
    if (!cols) live.set(r.t, (cols = new Set()));
    cols.add(r.c);
  }
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [t, cols] of expected) {
    const have = live.get(t);
    if (!have) {
      missing.push(t);
      continue;
    }
    for (const c of cols) if (!have.has(c)) missing.push(`${t}.${c}`);
  }
  for (const [t, cols] of live) {
    const want = expected.get(t);
    if (!want) {
      extra.push(t);
      continue;
    }
    for (const c of cols) if (!want.has(c)) extra.push(`${t}.${c}`);
  }
  return { missing: missing.sort(), extra: extra.sort() };
}

const driftError = (drift: SchemaDrift) =>
  new Error(`${SCHEMA_DRIFT_SENTENCE}: missing ${drift.missing.join(', ')}`);

const maxVersion = (spec: StoreSpec): number =>
  spec.ladder.length ? spec.ladder[spec.ladder.length - 1]!.version : spec.baselineVersion;

/**
 * Cloud boot (spec §6): the database must be at exactly this build's version — newer means a later
 * build migrated (and may have contracted) it; older means the migrate step did not run. Either way
 * the server refuses to start, with the stable sentence. Read-only; any scoped handle that can see
 * `schema_meta` (a global table) will do — the server passes its operator handle.
 */
export async function assertSchemaCurrent(d: Driver, store: 'main' | 'trace'): Promise<void> {
  const spec = store === 'main' ? MAIN : TRACE;
  const have = await schemaVersion(d);
  assertSchemaNotNewer(have, maxVersion(spec));
  assertSchemaNotOlder(have, maxVersion(spec));
  const drift = await verifyPostgresSchema(d, spec.name);
  if (drift.missing.length) throw driftError(drift);
}

async function migrateStore(
  owner: Driver,
  spec: StoreSpec,
  opts: MigrateOptions = {},
): Promise<number> {
  let have = await schemaVersion(owner);
  const max = maxVersion(spec);
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
  // ADR 496: the version row above is a claim; the catalog is the evidence. A repair replays the
  // whole ladder — every entry is idempotent by contract — and is reported, never silent.
  let drift = await verifyPostgresSchema(owner, spec.name);
  if (drift.missing.length && opts.repair) {
    for (const m of spec.ladder)
      await owner.tx(async (t) => {
        if (m.sql !== undefined) await t.exec(m.sql);
        else await m.postgres!(t);
      });
    const after = await verifyPostgresSchema(owner, spec.name);
    const repaired = drift.missing.filter((x) => !after.missing.includes(x));
    if (repaired.length) opts.report?.(`${SCHEMA_DRIFT_SENTENCE} repaired: ${repaired.join(', ')}`);
    drift = after;
  }
  if (drift.missing.length) throw driftError(drift);
  if (drift.extra.length)
    opts.report?.(`schema extras (not the ladder's, left alone): ${drift.extra.join(', ')}`);
  // Policies are derived, so they are (re)applied on every run: a table added by a migration is
  // covered the moment it exists. Only the ladder's tables, though (ADR 496): a table the ladder
  // does not know — a fixture's scratch table, an operator's — is reported above and left alone,
  // where applying `team_id = …` to one without the column used to kill the whole step.
  const known = expectedSchema(spec.name);
  for (const t of await teamOwnedTables(owner))
    if (known.has(t)) await owner.exec(tenantPolicySql(t));
  return have;
}
