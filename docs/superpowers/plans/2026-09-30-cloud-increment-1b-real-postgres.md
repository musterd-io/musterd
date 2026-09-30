# Cloud increment 1B — real Postgres behind the Driver: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd seats: execute inline in your own lane — AGENTS.md hard rule 8.)

**Goal:** Postgres becomes a real backend of the async `Driver` — a `pg` driver with driver-scoped tenant context and fail-closed row-level security, a frozen Postgres baseline plus one portable migration ladder with the §6 version guard, the §8.2 tenancy leak test green on PGlite in CI, every server store test on both drivers, and one dated pass against a real Neon project.

**Architecture:** `Driver` gains `forTeam(teamId)` and `asOperator()`; on SQLite both return the handle, on Postgres/PGlite they return handles that stamp every transaction with `SET LOCAL ROLE` + `SET LOCAL app.team_id`. The row-level policy on every team-owned table is `team_id = current_setting('app.team_id', true)`, so the bare connection handle sees nothing (fail-closed) and only `asOperator()` (role `musterd_operator`, `BYPASSRLS`) crosses tenants. The schema is a hand-checked Postgres baseline at v80 (`db/pg/0080-baseline.sql`) followed by one ladder (`db/ladder.ts`) whose entries are portable SQL, or explicit per-engine functions when unavoidable; v81 is the first portable migration and adds `team_id` to the four member-owned tables so one policy shape covers every table. The auth helpers are the seam where a request's `ctx.db` becomes team-scoped; background loops and `/health` take `asOperator()` explicitly.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Node ≥ 22, better-sqlite3 (self-hosted), `pg` + `@types/pg` (Cloud — new runtime dependency, its own ADR), `@electric-sql/pglite` 0.5.8 (test double), vitest (`pool: forks`), zod.

**Spec:** `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §12 (design), §6 (expand/contract + guard), §8.2 (tenancy leak test), §3.1; `docs/decisions/479-two-store-backends.md`. Increment 1A landed in PR #1871 (`docs/superpowers/plans/2026-09-30-cloud-increment-1a-async-store-layer.md`); this plan starts from its end state.

## Global Constraints

- `@musterd/protocol` schemas do not change (hard rule 1). No wire or MCP change in 1B.
- No new runtime dependency without an ADR (hard rule 6): `pg` gets one (Task 1). `@types/pg` is dev. PGlite stays dev-only; `noPgliteInDist.test.ts` keeps passing.
- Never log secrets (hard rule 5): a `DATABASE_URL` is never logged, never written to the repo, never echoed by a script; the Neon pass reads it from `~/.musterd/cloud/neon.env` (chmod 600).
- Docs change in the same commit as the behaviour (hard rule 3): `docs/architecture/01-data-model.md`, `03-server.md` (file-tree lines are drift-checked by `format:check`), ADR 479 dated Consequences notes.
- `db/dialect.ts` stays under 300 lines (ADR 479 §4; `dialect.test.ts` pins it).
- Tenant context is set only by the seam (auth helpers, WS claim) and never by store code; `asOperator(` is the complete, greppable list of cross-tenant reads (spec §12.1).
- The app role (`musterd_app`) has no `BYPASSRLS` and owns no table; every team-owned table has `ENABLE` and `FORCE ROW LEVEL SECURITY` (spec §12.1).
- Git: branch from `origin/main`, squash PR, `Co-authored-by: fifty <fifty@revive.musterd>`, fast gates before push (`pnpm typecheck && pnpm lint && pnpm format:check`, after `pnpm -r build`).
- Test driver default is `both`; CI pins `MUSTERD_TEST_DRIVER=both` (already true after 1A).

## Review Focus

1. **A store write that omits `team_id` on one of the four newly team-stamped tables** (`presence`, `inbox_cursors`, `seat_memory`, `seed_thread_entries`): on Postgres the RLS `WITH CHECK` refuses it and a person's heartbeat/cursor/memory silently stops persisting. Pinned in Task 5 (the store's own insert paths on PGlite as `musterd_app`, plus the NOT NULL constraint).
2. **A cross-team path that forgot `asOperator()`** (reaper, retention, census, seeds ingest, sync loops, `/health`, team creation) reads zero rows on Postgres and "succeeds": nothing reaped, nothing pruned. Pinned in Task 9 — each named loop runs once on PGlite with two teams seeded and asserts it touched both.
3. **A pooled connection returned mid-failure** (body throws after `SET LOCAL`, or the client errors): the next tenant must not inherit anything. Pinned in Task 10 (iii) with a throwing body and a pool of size 1, and in Task 8's choreography test (ROLLBACK on error, client released).
4. **A future schema** (a newer server migrated the database; this binary is older): boot must refuse with the stable sentence, not serve. Pinned in Task 6 on both engines, including the SQLite daemon path (`openDb`).
5. **A statement the translator cannot shape for Postgres** hidden in one of the 96 unconverted test files' modules — the reason those files exist. Pinned by Tasks 11–13: every server store test on both drivers, no `MUSTERD_TEST_DRIVER=sqlite` escape hatch in CI.

---

## File structure

**Created**

- `docs/decisions/NNN-pg-driver-dependency.md` — the `pg` dependency ADR (`pnpm adr:next` gives NNN; push the draft PR before writing it — ADR 223).
- `packages/server/src/db/pg/0080-baseline.sql` — the frozen Postgres schema at SQLite ladder v80: tables, indexes, the FTS5 replacement (tsvector table + triggers), roles, RLS.
- `packages/server/src/db/pg/tenancy.ts` — `GLOBAL_TABLES` allowlist, `TEAM_TABLE_POLICY_SQL(table)`, `TENANT_SETTING`, role names.
- `packages/server/src/db/pg/migrate.ts` — `migratePostgres(owner: Driver)`: baseline if empty, then `LADDER` from v81, with the §6 guard.
- `packages/server/src/db/ladder.ts` — `LADDER: PortableMigration[]` (v81+), shared by both engines.
- `packages/server/src/db/guard.ts` — `assertSchemaNotNewer(version, max)`, `SCHEMA_NEWER_SENTENCE`.
- `packages/server/src/db/pgDriver.ts` — node-postgres behind the Driver: pools per role, tenant stamping, errors.
- `packages/server/src/db/tenancy.test.ts` — the §8.2 test (inventory, cross-tenant through store paths, alternating tenants, fail-closed).
- `packages/server/src/db/ladder.test.ts`, `guard.test.ts`, `pgDriver.test.ts`, `pg/migrate.test.ts`, `pg/drift.test.ts`.
- `scripts/cloud/neon-pass.mjs` — the by-hand real-Postgres pass; `docs/perf/neon-pass.md` — its result page.

**Modified**

- `packages/server/src/db/driver.ts` — `forTeam`, `asOperator`, `DriverErrorCode` gains `'unavailable' | 'no_tenant_scope'`.
- `packages/server/src/db/sqliteDriver.ts` — the two methods return the handle.
- `packages/server/src/db/pgliteDriver.ts` — tenant/role stamping per transaction; `forTeam`/`asOperator`.
- `packages/server/src/db/testing.ts` — pooled PGlite loads the baseline + ladder via `migratePostgres`; `openTestDriver('pglite')` returns an **operator-scoped** handle by default (tests seed across teams), with `openTestDriver('pglite', { team })` for tenant-scoped; the hybrid `openTestDb` is deleted in Task 13.
- `packages/server/src/db/migrations.ts` — v81 appended from `LADDER` through an adapter; `runMigrations` applies the §6 guard.
- `packages/server/src/db/open.ts`, `db/traceDb.ts` — guard wired; `openTraceDb` unchanged otherwise.
- `packages/server/src/store/presence.ts`, `store/cursors.ts`, `store/memory.ts`, `store/seeds.ts` — write `team_id` on insert (v81).
- `packages/server/src/transport/http.ts` — `authTouch`/`authClaimedAgent`/`authAgentKeyOnly`/`authAdmin*`/`authGovernance*` return `{ …, ctx }` with `db: ctx.db.forTeam(team.id)`; `/health`, team create, `/store/*` use `asOperator()`.
- `packages/server/src/transport/ws.ts` — after `requireTeam`, the connection's ctx becomes team-scoped.
- `packages/server/src/index.ts` — loop starters get `{ …ctx, db: ctx.db.asOperator(), traceDb: ctx.traceDb.asOperator() }`; `RunningServer.db` becomes `Database | null` (null on Postgres).
- `packages/server/src/presence/reaper.ts`, `footprint/sampler.ts`, `seeds/ingest.ts`, `sync/push.ts`, `sync/pull.ts`, `sync/tracePush.ts`, `store/retention.ts` callers — receive the operator ctx (no code change inside beyond types).
- 96 test files (list in Task 11's step 1) → `withDrivers`.
- `docs/architecture/01-data-model.md` §Two dialects, `03-server.md` tree lines, ADR 479 Consequences, `docs/wiki/running-the-gates.md`.

**Deleted:** `packages/server/src/db/pgSchema.ts` (Task 4), the hybrid `openTestDb`/`openTestTraceDb`/`TestDb` in `testing.ts` (Task 13).

---

### Task 1: The `pg` dependency ADR and the packages

**Files:**
- Create: `docs/decisions/NNN-pg-driver-dependency.md`
- Modify: `packages/server/package.json` (`dependencies.pg`, `devDependencies.@types/pg`), `pnpm-lock.yaml`

**Interfaces:**
- Produces: `import pg from 'pg'` resolvable from `packages/server/src`.

- [ ] **Step 1: Take the number and publish it first (ADR 220/223)**

```bash
git fetch origin main && git checkout -b feat/store-pg-1b origin/main
pnpm adr:next          # prints NNN
git commit --allow-empty -m "chore(lane): open 1B branch (ADR NNN reserved)" && git push -u origin feat/store-pg-1b
gh pr create --draft --title "Cloud increment 1B — real Postgres behind the Driver" --body "Plan docs/superpowers/plans/2026-09-30-cloud-increment-1b-real-postgres.md. Refs ADR-479, ADR-NNN."
```

- [ ] **Step 2: Write the ADR** (`docs/decisions/NNN-pg-driver-dependency.md`, skeleton per `07-conventions.md`)

```markdown
# ADR NNN: `pg` is the Cloud Postgres driver

- Status: accepted
- Date: 2026-09-30
- Refs: ADR 479 (two backends), cloud design §12.4

## Context
ADR 479 named `pg` for Cloud without weighing alternatives; hard rule 6 wants the why on record.

## Problem
Three Node Postgres clients fit the async Driver. Which one, and what does it cost to change later?

## Decision
`pg` (node-postgres) with its `Pool`, one pool per database role. Weighed:
- `postgres` (porsager): nicer tagged-template API we would not use (the Driver takes SQL text +
  positional params), its own protocol implementation with known quirks behind PgBouncer-style
  poolers, and prepared-statement caching we would have to disable per statement.
- `@neondatabase/serverless`: HTTP/WebSocket transport, `pg`-compatible API, but it ties the app to
  one vendor's edge; Neon's pooled endpoint already speaks plain Postgres.
`pg` is the reference client, works against Neon, Fly Postgres, RDS and a laptop Postgres alike,
and the Driver hides its API behind `pgDriver.ts`, so swapping it later is one file.

## Consequences
- `pg` + `@types/pg` in `@musterd/server`; PGlite stays dev-only (ADR 479 §1).
- The pool is sized per role in `pgDriver.ts`; a bounded checkout wait maps to
  `DriverError('unavailable')` with the stable sentence "database unreachable".

## Observability & Evaluation
- **Traces:** the OTel spans the server already emits wrap the request; the driver adds none in 1B.
- **Metrics:** none new in 1B. 1C's `/health` 503 carries the stable sentence.
- **Falsifier:** a `pg` release note or a Neon incident showing the reference client misbehaving
  behind Neon's pooler in a way `postgres`/`@neondatabase/serverless` would not — then reopen.
```

- [ ] **Step 3: Add the packages**

```bash
pnpm --filter @musterd/server add pg@^8.13 && pnpm --filter @musterd/server add -D @types/pg@^8.11
pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check
```
Expected: all green; `pnpm change-adr:check` passes with the new ADR present.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/NNN-pg-driver-dependency.md packages/server/package.json pnpm-lock.yaml
git commit -m "chore(deps): pg is the Cloud Postgres driver (ADR NNN)

Refs ADR-NNN, ADR-479
Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 2: `forTeam` / `asOperator` on the Driver interface; SQLite returns itself

**Files:**
- Modify: `packages/server/src/db/driver.ts`, `packages/server/src/db/sqliteDriver.ts`
- Test: `packages/server/src/db/sqliteDriver.test.ts`

**Interfaces:**
- Produces: `Driver.forTeam(teamId: string): Driver`, `Driver.asOperator(): Driver`, `DriverErrorCode` ∪ `'unavailable' | 'no_tenant_scope'`.

- [ ] **Step 1: Failing test** (append to `sqliteDriver.test.ts`)

```ts
it('forTeam and asOperator are the handle itself on SQLite (one tenant per file)', async () => {
  const d = fresh();
  expect(d.forTeam('t1')).toBe(d);
  expect(d.asOperator()).toBe(d);
  await d.tx(async (t) => {
    expect(t.forTeam('t1')).toBe(t);
    expect(t.asOperator()).toBe(t);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/server/src/db/sqliteDriver.test.ts` — Expected: FAIL, `d.forTeam is not a function`.

- [ ] **Step 3: Implement.** In `driver.ts`, after `connection(): Driver;`:

```ts
  /**
   * A handle scoped to one team (spec §12.1). On Postgres every transaction it opens runs
   * `SET LOCAL app.team_id = <teamId>` as the app role, so row-level security admits only that
   * team's rows; the unscoped connection handle admits none. On SQLite — one team per file —
   * it is the handle itself.
   */
  forTeam(teamId: string): Driver;
  /**
   * The cross-tenant handle for work that is legitimately about every team: the presence reaper,
   * retention, the census, `/health`, team creation, the sync loops. On Postgres it runs as
   * `musterd_operator` (BYPASSRLS). `asOperator(` is the audit list of every cross-tenant read.
   */
  asOperator(): Driver;
```
and `export type DriverErrorCode = 'outer_handle_in_tx' | 'tx_closed' | 'not_sqlite' | 'closed' | 'unavailable' | 'no_tenant_scope';`.
In `sqliteDriver.ts`, inside the object literal `make(...)` returns (next to `connection()`):

```ts
      forTeam() {
        return this;
      },
      asOperator() {
        return this;
      },
```
(`this` is the handle object; both the connection handle and each tx handle return themselves.)

- [ ] **Step 4: Run** the file — Expected: PASS. Then `npx tsc -p packages/server/tsconfig.json --noEmit` — Expected: errors only in `pgliteDriver.ts` and `testing.ts` (the spread `{ ...d, close }` still structurally satisfies; PGlite lacks the two methods) — fixed in Task 3.

- [ ] **Step 5: Commit** `feat(db): Driver.forTeam / asOperator — the tenant seam (1B task 2)`.

---

### Task 3: The Postgres baseline, roles and RLS; `pgSchema.ts` retired

**Files:**
- Create: `packages/server/src/db/pg/0080-baseline.sql`, `packages/server/src/db/pg/tenancy.ts`, `packages/server/src/db/pg/migrate.ts`
- Modify: `packages/server/src/db/testing.ts` (pooled PGlite uses `migratePostgres`), `packages/server/src/db/pgliteDriver.ts` (stamping — Step 6)
- Delete: `packages/server/src/db/pgSchema.ts`
- Test: `packages/server/src/db/pg/migrate.test.ts`, `packages/server/src/db/pgliteDriver.test.ts`

**Interfaces:**
- Produces: `GLOBAL_TABLES: readonly string[]`, `ROLE = { owner: 'musterd_owner', app: 'musterd_app', operator: 'musterd_operator' }`, `TENANT_SETTING = 'app.team_id'`, `tenantPolicySql(table: string): string`, `migratePostgres(owner: Driver): Promise<number>` (returns the applied version), `PG_BASELINE_VERSION = 80`.

- [ ] **Step 1: Generate the baseline once, then own it by hand.** Run (a one-off, not committed):

```bash
node --input-type=module -e "
import { pgSchemaStatements } from './packages/server/dist/db/pgSchema.js';
process.stdout.write(pgSchemaStatements().join(';\n\n') + ';\n');
" > packages/server/src/db/pg/0080-baseline.sql
```
(If `pgSchema.ts` exports the statements under another name, export them first — it is being deleted this task.) Then edit the file by hand:
  - Prepend the roles (idempotent — Postgres has no `CREATE ROLE IF NOT EXISTS`):
    ```sql
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_owner') THEN CREATE ROLE musterd_owner NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_app') THEN CREATE ROLE musterd_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_operator') THEN CREATE ROLE musterd_operator NOLOGIN BYPASSRLS; END IF;
    END $$;
    ```
    (Login is granted per deployment — the Neon pass script creates login users and `GRANT`s them these roles; the schema never carries a password.)
  - Append, after every table: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO musterd_app, musterd_operator; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO musterd_app, musterd_operator; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO musterd_app, musterd_operator;`
  - Append the RLS block generated by `tenancy.ts` (Step 2) — **do not hand-write 37 policies**; the loader appends `tenantPolicySql(t)` for every team-owned table at load time, so the baseline file holds only what is not derivable.
  - Keep the `insights_fts` tsvector table + `insights_fts_ins/upd/del` trigger functions from the generated output; drop the four `insights_fts_*` shadow tables (SQLite-only).
  - `teams` gets its own policy: `USING (id = current_setting('app.team_id', true))`.

- [ ] **Step 2: `tenancy.ts`**

```ts
/** Spec §12: the tenancy vocabulary every Postgres piece shares. */
export const TENANT_SETTING = 'app.team_id';
export const ROLE = { owner: 'musterd_owner', app: 'musterd_app', operator: 'musterd_operator' } as const;

/**
 * Tables that are NOT team-owned. Everything else must carry `team_id` and a tenant policy; the
 * inventory test (tenancy.test.ts) fails on a table in neither set, so a new table cannot ship
 * unclassified. `teams` is team-owned by its own id (policy on `id`).
 */
export const GLOBAL_TABLES: readonly string[] = ['schema_meta', 'footprint_machine', 'footprint_stacks'];

/** The one policy shape. `current_setting(..., true)` is NULL with no setting → matches no row. */
export function tenantPolicySql(table: string): string {
  const col = table === 'teams' ? 'id' : 'team_id';
  return `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON "${table}";
CREATE POLICY tenant ON "${table}"
  USING (${col} = current_setting('${TENANT_SETTING}', true))
  WITH CHECK (${col} = current_setting('${TENANT_SETTING}', true));`;
}
```

- [ ] **Step 3: `pg/migrate.ts`** (the ladder from v81 arrives in Task 5; write the shape now)

```ts
import { readFileSync } from 'node:fs';
import type { Driver } from '../driver.js';
import { assertSchemaNotNewer } from '../guard.js';          // Task 6 — stub returns void until then
import { LADDER } from '../ladder.js';                       // Task 5 — export [] until then
import { GLOBAL_TABLES, tenantPolicySql } from './tenancy.js';

export const PG_BASELINE_VERSION = 80;
const BASELINE = new URL('./0080-baseline.sql', import.meta.url);

async function schemaVersion(d: Driver): Promise<number> {
  const t = await d.get<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'schema_meta'",
  );
  if (!t || t.n === 0) return 0;
  const row = await d.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : 0;
}

/** Every base table in `public` that is not global — the set the policies cover. */
export async function teamOwnedTables(d: Driver): Promise<string[]> {
  const rows = await d.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name).filter((t) => !GLOBAL_TABLES.includes(t));
}

/** Runs as the OWNER role (spec §6: a separate step before the rollout). Idempotent. */
export async function migratePostgres(owner: Driver): Promise<number> {
  let have = await schemaVersion(owner);
  const max = LADDER.length ? LADDER[LADDER.length - 1]!.version : PG_BASELINE_VERSION;
  assertSchemaNotNewer(have, max);
  if (have === 0) {
    await owner.exec(readFileSync(BASELINE, 'utf8'));
    await owner.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [String(PG_BASELINE_VERSION)]);
    have = PG_BASELINE_VERSION;
  }
  for (const m of LADDER) {
    if (m.version <= have) continue;
    await owner.tx(async (t) => {
      if (m.sql) await t.exec(m.sql);
      else await m.postgres!(t);
      await t.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [String(m.version)]);
    });
    have = m.version;
  }
  // Policies are derived, so they are (re)applied on every run: a table added by a migration is
  // covered the moment it exists, and a hand edit cannot leave one table without its policy.
  for (const t of await teamOwnedTables(owner)) await owner.exec(tenantPolicySql(t));
  return have;
}
```
Create `db/ladder.ts` with `export const LADDER: PortableMigration[] = [];` and the type (Task 5 fills it), and `db/guard.ts` with the real guard now (it is four lines — Task 6 only wires and tests the SQLite side):

```ts
export const SCHEMA_NEWER_SENTENCE = 'schema newer than this build';
export function assertSchemaNotNewer(have: number, max: number): void {
  if (have > max) throw new Error(`${SCHEMA_NEWER_SENTENCE}: database is at schema ${have}, this build knows ${max}`);
}
```

- [ ] **Step 4: Failing test** `pg/migrate.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pgliteDriver.js';
import { migratePostgres, teamOwnedTables, PG_BASELINE_VERSION } from './migrate.js';
import { GLOBAL_TABLES } from './tenancy.js';

describe('migratePostgres (spec §12.2)', () => {
  it('loads the baseline on an empty database, records v80, and is idempotent', async () => {
    const d = await pgliteDriver();
    expect(await migratePostgres(d)).toBe(PG_BASELINE_VERSION);
    expect(await migratePostgres(d)).toBe(PG_BASELINE_VERSION);
    const v = await d.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    expect(v?.value).toBe('80');
    await d.close();
  });
  it('every team-owned table has RLS enabled, forced, and a tenant policy; globals have none', async () => {
    const d = await pgliteDriver();
    await migratePostgres(d);
    const rows = await d.all<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    const owned = await teamOwnedTables(d);
    for (const r of rows) {
      if (GLOBAL_TABLES.includes(r.relname)) expect(r.policies, r.relname).toBe(0);
      else { expect(owned, r.relname).toContain(r.relname); expect(r.relrowsecurity && r.relforcerowsecurity, r.relname).toBe(true); expect(r.policies, r.relname).toBe(1); }
    }
    await d.close();
  });
});
```

- [ ] **Step 5: Run** `npx vitest run packages/server/src/db/pg/migrate.test.ts` — Expected: FAIL (module missing / RLS block absent). Implement until PASS. Note: `presence`, `inbox_cursors`, `seat_memory`, `seed_thread_entries` have no `team_id` yet — until Task 5 lands v81, `tenantPolicySql` on them will fail with `column "team_id" does not exist`. For THIS task, `teamOwnedTables` excludes those four by a temporary `PENDING_V81` list in `tenancy.ts` that Task 5 deletes; the test asserts they are excluded and Task 5's test asserts they are covered.

- [ ] **Step 6: PGlite stamps role and tenant.** In `pgliteDriver.ts`, the wrap gains a `scope: { role: 'app' | 'operator'; team: string | null }`; the root handle is `{ role: 'app', team: null }` (fail-closed). Every transaction opens with `SET LOCAL ROLE <role>` and, when `team` is set, `SELECT set_config('app.team_id', $1, true)`; bare `get/all/run` on a non-tx handle become one-statement transactions through the same path:

```ts
const stamp = async (q: Transaction, s: Scope) => {
  await q.exec(`SET LOCAL ROLE ${s.role === 'app' ? ROLE.app : ROLE.operator}`);
  if (s.team !== null) await q.query("SELECT set_config('app.team_id', $1, true)", [s.team]);
};
// in wrap(q, depth, scope): outside a tx, each statement is pg.transaction(async (t) => { await stamp(t, scope); return query(t, sql, params) })
// tx(): pg.transaction(async (t) => { await stamp(t, scope); return fn(wrap(t, 1, scope)) })
forTeam: (team) => wrap(pg, 0, { role: 'app', team }),
asOperator: () => wrap(pg, 0, { role: 'operator', team: null }),
```
`exec` (DDL, TRUNCATE in tests) keeps running unstamped on the superuser connection — it is the owner path in the double. Failing test in `pgliteDriver.test.ts`:

```ts
it('fail-closed: the bare handle reads nothing, forTeam reads its team, asOperator reads both (spec §12.1)', async () => {
  const d = await pgliteDriver(); await migratePostgres(d);
  const op = d.asOperator();
  await op.run("INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('A','a','A',1,1)");
  await op.run("INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('B','b','B',1,1)");
  expect((await d.all('SELECT id FROM teams')).length).toBe(0);
  expect((await d.forTeam('A').all<{ id: string }>('SELECT id FROM teams')).map((r) => r.id)).toEqual(['A']);
  expect((await op.all('SELECT id FROM teams')).length).toBe(2);
  expect((await d.forTeam('A').run("UPDATE teams SET display = 'x' WHERE id = 'B'")).changes).toBe(0);
  await d.close();
});
```
Run: FAIL (superuser bypasses RLS until `SET LOCAL ROLE`) → implement → PASS.

- [ ] **Step 7: `testing.ts`** — `pooledPglite` calls `migratePostgres(d)` instead of `loadPgSchema`; `openTestDriver('pglite')` returns `{ ...d.asOperator(), close: async () => undefined }` (a test seeds any team it likes; tenant-scoped tests call `.forTeam(id)` on it). Delete `pgSchema.ts`; fix `03-server.md` tree (remove its line, add `pg/` lines, `ladder.ts`, `guard.ts`, `pgDriver.ts` placeholder is Task 8). Run `npx vitest run packages/server/src/db` and the 24 `withDrivers` files (`MUSTERD_TEST_DRIVER=pglite`) — Expected: green.

- [ ] **Step 8: Commit** `feat(db): frozen Postgres baseline v80 with roles and derived RLS; PGlite stamps role + tenant per transaction; pgSchema.ts retired (1B task 3)`.

---

### Task 4: Team-scoped and operator handles are the ONLY way rows are visible — the tenancy inventory test, part (i) and (iv)

**Files:**
- Create: `packages/server/src/db/tenancy.test.ts`

- [ ] **Step 1: Failing test** (parts (ii)/(iii) are added in Task 10 once the seam and v81 exist)

```ts
import { describe, expect, it } from 'vitest';
import { migratePostgres, teamOwnedTables } from './pg/migrate.js';
import { GLOBAL_TABLES } from './pg/tenancy.js';
import { pgliteDriver } from './pgliteDriver.js';

describe('tenancy (spec §8.2, §12) — inventory and fail-closed', () => {
  it('(i) every public table is team-owned (RLS forced + tenant policy) or in GLOBAL_TABLES', async () => {
    const d = await pgliteDriver(); await migratePostgres(d);
    const all = (await d.all<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).map((r) => r.t);
    const owned = await teamOwnedTables(d);
    for (const t of all) {
      const isGlobal = GLOBAL_TABLES.includes(t); const isOwned = owned.includes(t);
      expect(isGlobal !== isOwned, `${t} must be exactly one of global/team-owned`).toBe(true);
      if (isOwned) {
        const cols = (await d.all<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?", [t])).map((r) => r.c);
        expect(cols.includes('team_id') || t === 'teams', `${t} lacks team_id`).toBe(true);
      }
    }
    await d.close();
  });
  it('(iv) the bare handle reads 0 and writes 0 rows on every team-owned table; the operator sees them', async () => {
    const d = await pgliteDriver(); await migratePostgres(d);
    const op = d.asOperator();
    // seed one row per team-owned table is the store's job (Task 10); here the teams row suffices to
    // prove the mechanism on the table with the most privileged policy
    await op.run("INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('A','a','A',1,1)");
    for (const t of await teamOwnedTables(d)) {
      expect((await d.all(`SELECT 1 FROM "${t}" LIMIT 1`)).length, t).toBe(0);
      expect((await d.run(`DELETE FROM "${t}"`)).changes, t).toBe(0);
    }
    expect((await op.all('SELECT id FROM teams')).length).toBe(1);
    await d.close();
  });
});
```
- [ ] **Step 2: Run** — Expected: (i) FAILS on the four `PENDING_V81` tables (they are neither); this is the RED that Task 5 turns GREEN. Commit the test as `test(db): tenancy inventory (spec §8.2 i, iv) — red until v81 (1B task 4)` with `it.fails` on (i) **only if** the wave to Task 5 is not the same session; otherwise proceed straight to Task 5 and commit both together.

---

### Task 5: v81 — `team_id` on `presence`, `inbox_cursors`, `seat_memory`, `seed_thread_entries`; the portable ladder shape

**Files:**
- Modify: `packages/server/src/db/ladder.ts`, `packages/server/src/db/migrations.ts` (adapter appends the ladder to `MIGRATIONS`), `packages/server/src/db/pg/tenancy.ts` (delete `PENDING_V81`), `packages/server/src/store/presence.ts` (`attach` insert), `store/cursors.ts` (`setCursor` upsert), `store/memory.ts` (`saveMemory` upsert), `store/seeds.ts` (thread-entry insert)
- Test: `packages/server/src/db/ladder.test.ts`, the four stores' tests (already on `withDrivers` for memory; presence/cursors/seeds converted here if not yet)

**Interfaces:**
- Produces: `interface PortableMigration { version: number; sql?: string; sqlite?: (db: Database) => void; postgres?: (d: Driver) => Promise<void>; }` — exactly one of `sql` or both engine functions; `LADDER: PortableMigration[]`; `migrationsFromLadder(): Migration[]` (SQLite adapter).

- [ ] **Step 1: Failing ladder test**

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LADDER } from './ladder.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { migratePostgres } from './pg/migrate.js';
import { pgliteDriver } from './pgliteDriver.js';

describe('the portable ladder (spec §12.2)', () => {
  it('every entry is portable SQL or a complete per-engine pair, versions ascend from 81', () => {
    let prev = 80;
    for (const m of LADDER) {
      expect(m.version).toBeGreaterThan(prev); prev = m.version;
      expect(Boolean(m.sql) !== Boolean(m.sqlite && m.postgres), `v${m.version}`).toBe(true);
    }
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(LADDER[LADDER.length - 1]!.version);
  });
  it('v81: the four member-owned tables carry team_id on both engines', async () => {
    const s = new Database(':memory:'); runMigrations(s);
    for (const t of ['presence', 'inbox_cursors', 'seat_memory', 'seed_thread_entries'])
      expect(s.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name), t).toContain('team_id');
    const p = await pgliteDriver(); await migratePostgres(p);
    for (const t of ['presence', 'inbox_cursors', 'seat_memory', 'seed_thread_entries'])
      expect((await p.all<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?", [t])).map((r) => r.c), t).toContain('team_id');
    await p.close();
  });
});
```
- [ ] **Step 2: Run** — Expected: FAIL (`LADDER` empty; no `team_id`).

- [ ] **Step 3: Implement.** `ladder.ts`:

```ts
export const LADDER: PortableMigration[] = [
  {
    // Spec §12.2: one policy shape for every team-owned table. These four were owned only through
    // `members`/`seeds`; the column is backfilled from the owner and then required.
    version: 81,
    sqlite: (db) => {
      for (const [t, join] of [
        ['presence', 'SELECT team_id FROM members m WHERE m.id = presence.member_id'],
        ['inbox_cursors', 'SELECT team_id FROM members m WHERE m.id = inbox_cursors.member_id'],
        ['seat_memory', 'SELECT team_id FROM members m WHERE m.id = seat_memory.member_id'],
        ['seed_thread_entries', 'SELECT team_id FROM seeds s WHERE s.id = seed_thread_entries.seed_id'],
      ] as const) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN team_id TEXT`);
        db.exec(`UPDATE ${t} SET team_id = (${join})`);
        db.exec(`DELETE FROM ${t} WHERE team_id IS NULL`); // orphans of a removed owner: nothing joins them
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_team ON ${t}(team_id)`);
      }
      // SQLite cannot add NOT NULL to an existing column; the store's inserts set it, and
      // RLS on Postgres refuses a NULL. Enforced there; documented here.
    },
    postgres: async (d) => {
      for (const [t, join] of [/* same four pairs */] as const) {
        await d.exec(`ALTER TABLE ${t} ADD COLUMN team_id TEXT`);
        await d.exec(`UPDATE ${t} SET team_id = (${join})`);
        await d.exec(`DELETE FROM ${t} WHERE team_id IS NULL`);
        await d.exec(`ALTER TABLE ${t} ALTER COLUMN team_id SET NOT NULL`);
        await d.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_team ON ${t}(team_id)`);
      }
    },
  },
];
```
`migrations.ts`: `export const MIGRATIONS: Migration[] = [...LEGACY /* 1–80 as today */, ...LADDER.map((m) => ({ version: m.version, up: (db) => (m.sql ? db.exec(m.sql) : m.sqlite!(db)) }))]`. Delete `PENDING_V81`. Store inserts: `attach` → `INSERT INTO presence (…, team_id) VALUES (…, ?)` with `member.team_id`; `setCursor` → `team_id` from the member row it already loads; `saveMemory(db, memberId, …)` → look up `team_id` from `members` in the same statement: `INSERT INTO seat_memory (member_id, team_id, …) SELECT ?, team_id, ?, ?, ? FROM members WHERE id = ?`; seed thread entries → `seed.team_id`.

- [ ] **Step 4: Run** `ladder.test.ts`, `tenancy.test.ts` (i) now PASSES, `migrate.test.ts`, and `npx vitest run packages/server` on both drivers — Expected: green. `pnpm typecheck`.

- [ ] **Step 5: Commit** `feat(db): portable ladder from v81 — team_id on the four member-owned tables, one tenant policy for every table (1B task 5)`. Docs in the same commit: `01-data-model.md` DDL notes for the four tables + "one ladder from v81" sentence in §Two dialects.

---

### Task 6: The §6 schema guard on both engines

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (`runMigrations` calls `assertSchemaNotNewer(have, ladder max)` before applying), `packages/server/src/db/traceDb.ts` (same for the trace ladder), `packages/server/src/db/pg/migrate.ts` (already calls it — Task 3)
- Test: `packages/server/src/db/guard.test.ts`

- [ ] **Step 1: Failing test**

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_NEWER_SENTENCE } from './guard.js';
import { runMigrations } from './migrations.js';
import { openDb } from './open.js';
import { migratePostgres } from './pg/migrate.js';
import { pgliteDriver } from './pgliteDriver.js';

describe('schema version guard (spec §6)', () => {
  it('SQLite: a database at a version this build does not know refuses to open, with the stable sentence', () => {
    const raw = new Database(':memory:'); runMigrations(raw);
    raw.prepare("UPDATE schema_meta SET value = '9999' WHERE key = 'schema_version'").run();
    expect(() => runMigrations(raw)).toThrow(SCHEMA_NEWER_SENTENCE);
  });
  it('Postgres: migratePostgres refuses the same way', async () => {
    const d = await pgliteDriver(); await migratePostgres(d);
    await d.run("UPDATE schema_meta SET value = '9999' WHERE key = 'schema_version'");
    await expect(migratePostgres(d)).rejects.toThrow(SCHEMA_NEWER_SENTENCE);
    await d.close();
  });
  it('openDb surfaces it (the daemon does not serve a newer schema)', () => {
    // a file db, migrated by "a newer build"
    const path = `${process.env['TMPDIR'] ?? '/tmp'}/guard-${Date.now()}.db`;
    const raw = openDb(path); raw.prepare("UPDATE schema_meta SET value = '9999' WHERE key = 'schema_version'").run(); raw.close();
    expect(() => openDb(path)).toThrow(SCHEMA_NEWER_SENTENCE);
  });
});
```
- [ ] **Step 2: Run** — FAIL. **Step 3:** in `runMigrations`, after computing `have`: `assertSchemaNotNewer(have, ladder[ladder.length - 1]!.version);`. **Step 4:** PASS; run `db/` folder. **Step 5: Commit** `feat(db): refuse to run against a schema newer than this build, both engines (spec §6; 1B task 6)`. Docs: `03-server.md` line for `guard.ts`; wiki `running-the-gates.md` gets no change; `docs/architecture/01-data-model.md` §Migrations one sentence.

---

### Task 7: Schema drift test — SQLite@latest ≙ Postgres ladder

**Files:**
- Create: `packages/server/src/db/pg/drift.test.ts`

- [ ] **Step 1: Test** (this one is written against the current state and must pass; it is a falsifier for future migrations, not a RED/GREEN of new code)

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations.js';
import { migratePostgres } from './migrate.js';
import { pgliteDriver } from '../pgliteDriver.js';

const SQLITE_ONLY = /^insights_fts_(config|content|data|docsize|idx)$/; // FTS5 shadow tables
const PG_ONLY_COLUMNS: Record<string, string[]> = { insights_fts: ['tsv'] };

describe('the two schemas agree (spec §12.2)', () => {
  it('same tables, same column names, per table', async () => {
    const s = new Database(':memory:'); runMigrations(s);
    const sTables = s.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r: any) => r.name as string).filter((t) => !SQLITE_ONLY.test(t)).sort();
    const p = await pgliteDriver(); await migratePostgres(p);
    const pTables = (await p.all<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).map((r) => r.t).sort();
    expect(pTables).toEqual(sTables);
    for (const t of sTables) {
      const sc = s.prepare(`PRAGMA table_info("${t}")`).all().map((c: any) => c.name as string).sort();
      const pc = (await p.all<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?", [t])).map((r) => r.c).filter((c) => !(PG_ONLY_COLUMNS[t] ?? []).includes(c)).sort();
      expect(pc, t).toEqual(sc);
    }
    await p.close();
  });
});
```
- [ ] **Step 2: Run** — Expected: PASS (if it fails, the baseline file is wrong: fix the baseline, never the test). **Step 3: Commit** `test(db): SQLite and Postgres schemas cannot drift silently (1B task 7)`.

---

### Task 8: The `pg` driver

**Files:**
- Create: `packages/server/src/db/pgDriver.ts`
- Test: `packages/server/src/db/pgDriver.test.ts` (choreography against a fake `Pool`; the real wire is the Neon pass)

**Interfaces:**
- Produces: `pgDriver(opts: { appUrl: string; operatorUrl: string; poolSize?: number; acquireTimeoutMs?: number; pools?: PoolFactory }): Driver` where `type PoolFactory = (url: string) => Pick<pg.Pool, 'connect' | 'end'>` (tests inject).

- [ ] **Step 1: Failing test** — a fake pool whose clients record every `query(text, values)` and can be told to throw:

```ts
import { describe, expect, it } from 'vitest';
import { DriverError } from './driver.js';
import { pgDriver } from './pgDriver.js';

function fakePools() {
  const log: string[] = []; let failNext: string | null = null; let busy = 0;
  const client = (label: string) => ({
    async query(text: string, values?: unknown[]) {
      log.push(`${label}: ${text}${values?.length ? ' ' + JSON.stringify(values) : ''}`);
      if (failNext && text.includes(failNext)) { failNext = null; throw new Error('boom'); }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    release: (err?: unknown) => { busy--; log.push(`${label}: release${err ? '(err)' : ''}`); },
  });
  const factory = (url: string) => ({ async connect() { busy++; return client(url.includes('operator') ? 'op' : 'app') as never; }, async end() {} });
  return { factory, log, fail: (s: string) => (failNext = s), busy: () => busy };
}

describe('pgDriver choreography (spec §12.1)', () => {
  it('a bare statement on a team handle is BEGIN / SET LOCAL ROLE / set_config / stmt / COMMIT on one client, then released', async () => {
    const f = fakePools();
    const d = pgDriver({ appUrl: 'postgres://app', operatorUrl: 'postgres://operator', pools: f.factory });
    await d.forTeam('A').get('SELECT 1 FROM teams WHERE id = ?', ['A']);
    expect(f.log).toEqual([
      'app: BEGIN', 'app: SET LOCAL ROLE musterd_app', "app: SELECT set_config('app.team_id', $1, true) [\"A\"]",
      'app: SELECT 1 FROM teams WHERE id = $1 ["A"]', 'app: COMMIT', 'app: release',
    ]);
    expect(f.busy()).toBe(0);
  });
  it('the bare handle sets the role but no tenant (fail-closed); asOperator uses the operator pool', async () => {
    const f = fakePools();
    const d = pgDriver({ appUrl: 'postgres://app', operatorUrl: 'postgres://operator', pools: f.factory });
    await d.all('SELECT 1'); await d.asOperator().all('SELECT 1');
    expect(f.log.filter((l) => l.includes('set_config'))).toEqual([]);
    expect(f.log.some((l) => l.startsWith('op: SET LOCAL ROLE musterd_operator'))).toBe(true);
  });
  it('a throwing body rolls back and releases the client with the error; nested = SAVEPOINT', async () => {
    const f = fakePools();
    const d = pgDriver({ appUrl: 'postgres://app', operatorUrl: 'postgres://operator', pools: f.factory });
    await expect(d.forTeam('A').tx(async (t) => { await t.tx(async (n) => { await n.run('UPDATE x SET y = 1'); }); throw new Error('body'); })).rejects.toThrow('body');
    expect(f.log).toContain('app: SAVEPOINT sp1'); expect(f.log).toContain('app: RELEASE sp1');
    expect(f.log.at(-2)).toBe('app: ROLLBACK'); expect(f.log.at(-1)).toBe('app: release(err)');
  });
  it('a connection error is DriverError("unavailable") with the stable sentence', async () => {
    const d = pgDriver({ appUrl: 'postgres://app', operatorUrl: 'postgres://operator', pools: () => ({ async connect() { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); }, async end() {} }) });
    await expect(d.forTeam('A').get('SELECT 1')).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('database unreachable') });
  });
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement `pgDriver.ts`** — the shape:

```ts
import pg from 'pg';
import { toPostgres } from './dialect.js';
import { DriverError, type Driver, type Params } from './driver.js';
import { ROLE, TENANT_SETTING } from './pg/tenancy.js';

type Scope = { role: 'app' | 'operator'; team: string | null };
type Client = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>; release(err?: unknown): void };
type PoolLike = { connect(): Promise<Client>; end(): Promise<void> };
export type PoolFactory = (url: string) => PoolLike;

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03', '08006', '08001']);
const unavailable = (e: unknown) => new DriverError(`database unreachable: ${e instanceof Error ? e.message : String(e)}`, 'unavailable');

export function pgDriver(opts: { appUrl: string; operatorUrl: string; poolSize?: number; acquireTimeoutMs?: number; pools?: PoolFactory }): Driver {
  const make = opts.pools ?? ((connectionString) => new pg.Pool({ connectionString, max: opts.poolSize ?? 10, connectionTimeoutMillis: opts.acquireTimeoutMs ?? 5_000 }));
  const pools = { app: make(opts.appUrl), operator: make(opts.operatorUrl) };
  let closed = false;

  const stamp = async (c: Client, s: Scope) => {
    await c.query(`SET LOCAL ROLE ${s.role === 'app' ? ROLE.app : ROLE.operator}`);
    if (s.team !== null) await c.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [s.team]);
  };
  const acquire = async (s: Scope): Promise<Client> => {
    if (closed) throw new DriverError('driver is closed', 'closed');
    try { return await pools[s.role].connect(); } catch (e) { throw unavailable(e); }
  };
  const query = async (c: Client, sql: string, params: Params) => {
    const text = toPostgres(sql);
    try { return await c.query(text, params as unknown[]); }
    catch (e) { const code = (e as { code?: string }).code; if (code && UNREACHABLE.has(code)) throw unavailable(e); throw new Error(`${e instanceof Error ? e.message : String(e)}\n  in: ${text.replace(/\s+/g, ' ').trim()}`, { cause: e }); }
  };

  /** One transaction: BEGIN, stamp, body, COMMIT — ROLLBACK and release(err) on any failure. */
  const inTransaction = async <T>(s: Scope, body: (c: Client) => Promise<T>): Promise<T> => {
    const c = await acquire(s);
    try {
      await c.query('BEGIN'); await stamp(c, s);
      const r = await body(c);
      await c.query('COMMIT'); c.release(); return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* the connection is gone; release(err) discards it */ }
      c.release(e); throw e;
    }
  };

  const connectionHandle = (s: Scope): Driver => ({
    dialect: 'postgres',
    get: async <R>(sql: string, params: Params = []) => inTransaction(s, async (c) => (await query(c, sql, params)).rows[0] as R | undefined),
    all: async <R>(sql: string, params: Params = []) => inTransaction(s, async (c) => (await query(c, sql, params)).rows as R[]),
    run: async (sql, params = []) => inTransaction(s, async (c) => ({ changes: (await query(c, sql, params)).rowCount ?? 0 })),
    exec: async (sql) => { await inTransaction(s, async (c) => { await c.query(toPostgres(sql)); }); },
    tx: async (fn) => inTransaction(s, (c) => fn(txHandle(s, c, 0))),
    connection() { return this; },
    forTeam: (team) => connectionHandle({ role: 'app', team }),
    asOperator: () => connectionHandle({ role: 'operator', team: null }),
    close: async () => { closed = true; await Promise.all([pools.app.end(), pools.operator.end()]); },
  });
  const txHandle = (s: Scope, c: Client, depth: number): Driver => {
    const dead = { v: false };
    const guard = () => { if (dead.v) throw new DriverError('tx handle used after its transaction settled', 'tx_closed'); };
    const h: Driver = {
      dialect: 'postgres',
      get: async <R>(sql: string, params: Params = []) => { guard(); return (await query(c, sql, params)).rows[0] as R | undefined; },
      all: async <R>(sql: string, params: Params = []) => { guard(); return (await query(c, sql, params)).rows as R[]; },
      run: async (sql, params = []) => { guard(); return { changes: (await query(c, sql, params)).rowCount ?? 0 }; },
      exec: async (sql) => { guard(); await c.query(toPostgres(sql)); },
      tx: async (fn) => { guard(); const name = `sp${depth + 1}`; await c.query(`SAVEPOINT ${name}`); try { const r = await fn(txHandle(s, c, depth + 1)); await c.query(`RELEASE ${name}`); return r; } catch (e) { await c.query(`ROLLBACK TO ${name}`); await c.query(`RELEASE ${name}`); throw e; } },
      connection: () => connectionHandle(s),
      forTeam: () => { throw new DriverError('scope is fixed for the transaction; call forTeam on the connection', 'no_tenant_scope'); },
      asOperator: () => { throw new DriverError('scope is fixed for the transaction; call asOperator on the connection', 'no_tenant_scope'); },
      close: async () => undefined,
    };
    return h;
  };
  return connectionHandle({ role: 'app', team: null });
}
```
The dead flag must be set by `inTransaction` after the body settles — pass a `settle` callback or return `{handle, kill}` from `txHandle`; implement whichever keeps the test's ROLLBACK/release ordering. Same `tx_closed` semantics as SQLite (1A review I1).

- [ ] **Step 4: Run** — PASS; `pnpm lint` (import/order). `noPgliteInDist.test.ts` still green (pg is fine in dist; pglite is not).

- [ ] **Step 5: Commit** `feat(db): pg driver — pools per role, tenant stamped per transaction, unavailable as a stable error (1B task 8)`. `03-server.md` line: `pgDriver.ts // node-postgres behind Driver (ADR NNN): app + operator pools; every statement in a tx stamped SET LOCAL ROLE + app.team_id; nested = SAVEPOINT; ECONN*/57P*/08* → DriverError('unavailable') "database unreachable"`.

---

### Task 9: The seam — requests are team-scoped, loops and `/health` are operator-scoped

**Files:**
- Modify: `packages/server/src/transport/http.ts` (the `auth*` helpers and their ~200 callers via one pattern), `packages/server/src/transport/ws.ts`, `packages/server/src/index.ts`
- Test: `packages/server/src/transport/tenancy-http.test.ts` (new), `packages/server/src/index.test.ts`

**Interfaces:**
- Consumes: `Driver.forTeam`, `Driver.asOperator` (Task 2), PGlite stamping (Task 3).
- Produces: every `auth*` helper returns its existing shape **plus** `ctx: Ctx` (team-scoped); callers use the returned `ctx` for the rest of the handler.

- [ ] **Step 1: Failing test** — two teams over HTTP on PGlite; `createServer({ db: pgliteOperatorDriver })`:

```ts
// transport/tenancy-http.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type RunningServer } from '../index.js';
import { openTestDriver } from '../db/testing.js';

let server: RunningServer; let base: string; let a: { key: string; slug: string }; let b: typeof a;
beforeAll(async () => {
  const db = await openTestDriver('pglite'); const traceDb = await openTestDriver('pglite');
  server = createServer({ db, traceDb, port: 0 });
  const { port } = await server.listen(); base = `http://127.0.0.1:${port}`;
  const mk = async (slug: string) => { const r = await fetch(`${base}/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, creator: { name: 'nick', kind: 'human' } }) }); const j = await r.json(); return { key: j.agent_key as string, slug }; };
  a = await mk('alpha'); b = await mk('beta');
});
afterAll(() => server.close());

describe('tenancy over HTTP on Postgres (spec §8.2 ii)', () => {
  it("team A's agent key reaches A's roster and is refused at B's host, and B's rows never appear in A's responses", async () => {
    const roster = async (t: typeof a, key: string) => fetch(`${base}/teams/${t.slug}/members`, { headers: { authorization: `Bearer ${key}` } });
    expect((await roster(a, a.key)).status).toBe(200);
    expect((await roster(b, a.key)).status).toBe(401);
    const body = await (await roster(a, a.key)).json();
    expect(JSON.stringify(body)).not.toContain('beta');
  });
  it('/health and the reaper still see both teams (operator scope)', async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h.ok).toBe(true);
  });
});
```
(The 401 on the wrong host is what the credential lookup already does when scoped to `beta`: `findBootstrapCredential(ctx.db.forTeam(beta), …)` cannot see `alpha`'s row. This is RLS doing the isolation, not a code check.)

- [ ] **Step 2: Run** — FAIL: `createServer` calls `sqliteHandle(db)!` on a PGlite driver (Task 3 left `RunningServer.db` non-null) and nothing is team-scoped yet.

- [ ] **Step 3: Implement.**
  - `index.ts`: `RunningServer.db: Database | null` (null when `sqliteHandle(db)` is null; the CLI tests read it only on SQLite). `config.dbPath` falls back to `'postgres'` when there is no handle. Loop starters: `const opCtx: Ctx = { ...ctx, db: ctx.db.asOperator(), traceDb: ctx.traceDb.asOperator() };` and pass `opCtx` to `startReaper`, `startSeedsIngest`, `startSyncPush`, `startSyncPull`, `startTracePush`, `startFootprintSampler`, `startProvisionSweep`, the roster watcher's reconcile, `runProvisionSweep`, `seedDawn` in tests. The request `handler` keeps the bare `ctx`.
  - `http.ts`: each `auth*` helper ends `return { ...auth, ctx: { ...ctx, db: ctx.db.forTeam(team.id), traceDb: ctx.traceDb.forTeam(team.id) } }`. Then, in every route: `const { team, member, ctx: tctx } = await authTouch(ctx, slug, req);` and the rest of the route body uses `tctx`. Mechanical: a codemod over `http.ts` that, for each `const { … } = await auth<X>(ctx, …)` destructuring, adds `ctx: tctx` to the pattern and renames `ctx` → `tctx` within that route block (the `if (method === … && rest === …) { … }` braces). Routes with no auth (`POST /teams`, `/health`, `/claim`, `/oauth/*` discovery, `/store/*` operator routes, `/sync/*` node routes which authenticate a node credential and then take `forTeam(team.id)` explicitly) are listed in the commit body; `/health`, team create and `/store/*` use `ctx.db.asOperator()` explicitly.
  - `ws.ts`: after `const team = await requireTeam(ctx.db, frame.team)` in the claim path, `const tctx = { ...ctx, db: ctx.db.forTeam(team.id), traceDb: ctx.traceDb.forTeam(team.id) }` stored on the connection record and used by every later frame handler for that connection.
  - Team creation (`POST /teams`) runs as operator (it inserts the `teams` row nothing is scoped to yet). Provisioning (`authProvision`) is operator + explicit team.

- [ ] **Step 4: Run** the new test, then `MUSTERD_TEST_DRIVER=both npx vitest run packages/server` — Expected: green on SQLite (no-op seam) and the PGlite files. Add to `index.test.ts`: `it('createServer on a Postgres driver exposes db: null', …)`.

- [ ] **Step 5: Review Focus 2 test** — in `tenancy-http.test.ts`: seed a stale presence row in each team, run one reaper tick through `startReaper`'s exported `tick` (export it), assert both teams' rows were reaped. Same for `runProvisionSweep`. PASS.

- [ ] **Step 6: Commit** `feat(server): requests are team-scoped at the auth seam; loops, /health and team creation are operator-scoped (spec §12.1; 1B task 9)`. Docs: `03-server.md` §auth paragraph, `01-data-model.md` §Two dialects (the seam sentence).

---

### Task 10: The full tenancy leak test — parts (ii) and (iii)

**Files:**
- Modify: `packages/server/src/db/tenancy.test.ts`

- [ ] **Step 1: (ii) cross-tenant through the store's own paths.** Seed teams A and B through `createTeam`/`addMember`/`openLane`/`insertMessage`/`appendAudit`/`enrollResidency`/`saveMemory`/`setCursor`/`attach` (one row per team in every team-owned table — a `seedEveryTable(op, team)` helper in the test; the inventory (i) asserts the helper reached every owned table by counting rows per table as operator, so a new table fails here until the helper seeds it). Then as `d.forTeam(A.id)`: `listLanes`, `listTeamMessages`, `listAudit`, `listResidency`, `getMemory`, `getCursor`, `listPresence`, `listMembers` return only A's rows; `updateLane(A-scoped, B.lane)` returns null; `run("DELETE FROM lanes WHERE id = ?", [B.lane])` → `changes 0`; B's counts unchanged as operator.

- [ ] **Step 2: (iii) alternating tenants on one reused connection.** PGlite is one connection by construction, which is the worst case: 200 iterations alternating `forTeam(A)`/`forTeam(B)` statements and `tx` bodies, every 7th body throwing after a write; after each statement assert the visible `teams.id` set is exactly `[current]`. Then the same through the `pg` driver's choreography fake with `poolSize: 1` asserting `set_config` precedes every statement and `release` follows every transaction (Task 8's fake).

- [ ] **Step 3: Run** on PGlite — PASS. **Commit** `test(db): tenancy leak test complete — cross-tenant via store paths, alternating tenants (spec §8.2; 1B task 10)`.

---

### Task 11: The 96 remaining test files onto `withDrivers` — cluster A, `store/*` and `db/*` (49 files)

**Files:** every `store/*.test.ts`, `db/db.test.ts`, `footprint/sampler.test.ts`, `presence/reaper.test.ts`, `projection/reconcile.test.ts`, `seeds/ingest.test.ts` still importing `openTestDb` (list by `grep -rl "openTestDb(" packages/server/src`).

**Recipe (the 1A one, exactly):**
1. `import { openTestDb } …` → `import { withDrivers } from '../db/testing.js'` + `import type { Driver } from '../db/driver.js'`; `let openStore: () => Promise<Driver>;` after the imports.
2. `openTestDb(':memory:')` → `await openStore()`; `TestDb` → `Driver`; `sqliteDriver(x)` wrappers removed (a Driver is a Driver).
3. Wrap the file's top-level `describe`/`it` blocks in `withDrivers('<basename>', (o, kind) => { beforeEach(() => { openStore = o; }); … });` — **`beforeEach`, never a bare assignment**: `describe.each` collects every driver before any test runs.
4. Raw reads become driver calls: `db.prepare(SQL).get(a, b)` → `await db.get(SQL, [a, b])`; `.all(...)` → `await db.all(SQL, [...])`; `.run(...)` → `await db.run(SQL, [...])`; `db.exec(SQL)` → `await db.exec(SQL)` (on PGlite `exec` runs as owner: fine for `DROP`/`CREATE TRIGGER` fixtures — but an `UPDATE audit SET ts = …` fixture must go through `run` on the operator handle, or RLS hides the row). `db.pragma(...)` → `it.runIf(kind === 'sqlite')` (SQLite-only property) or delete the assertion if it only proved SQLite internals.
5. `@name` params in test SQL → positional. SQL the translator refuses → rewrite the test's SQL portably (see `01-data-model.md` §Two dialects).
6. Run the file with `MUSTERD_TEST_DRIVER=both`; fix; move to the next. Commit per 10–15 files.

- [ ] **Step 1:** convert `store/*` in alphabetical batches of ~12; after each batch `MUSTERD_TEST_DRIVER=both npx vitest run <batch>` green, commit `test(store): <batch> on both drivers (1B task 11, n/4)`.
- [ ] **Step 2:** `db/db.test.ts` (81 raw reads — it tests migrations; keep it SQLite-only by design: it exercises `runMigrations(raw)`; move it to `withDrivers` only for the Driver-facing cases, leave the ladder cases on a raw handle with a comment), `presence/reaper.test.ts`, `footprint/sampler.test.ts`, `projection/reconcile.test.ts`, `seeds/ingest.test.ts`.
- [ ] **Step 3:** every dialect finding goes into the source SQL or `dialect.ts` with a `dialect.test.ts` case — never a `kind === 'sqlite'` branch in a store module.

---

### Task 12: Cluster B — `sync/*` and `transport/*` (47 files, `createServer`-based)

These boot one or two servers with `openTestDb`/`openDb` and read `server.db.prepare(...)`.

- [ ] **Step 1: A server fixture on both drivers.** In `testing.ts`: `export async function openTestServer(kind: DriverKind, opts?: Omit<ServerOptions, 'db' | 'traceDb'>): Promise<{ server: RunningServer; db: Driver; traceDb: Driver; base: string }>` — `db` is the **operator-scoped** handle for test reads; on SQLite it is the same handle the server has. Tests read back with `await db.get/all` instead of `server.db.prepare`.
- [ ] **Step 2:** `withDrivers('<file>', (o, kind) => { beforeEach/beforeAll(async () => { fixture = await openTestServer(kind, …) }) … })`. The two-server sync tests (`hub`, `joiner`) open two fixtures; on PGlite that is two `openTestDriver('pglite')` handles on **one** pooled instance — which breaks isolation. Give `pooledPglite` a second instance for the joiner: `openTestDriver('pglite', { instance: 'b' })`. Both are truncated per test.
- [ ] **Step 3:** `RunningServer.db` raw reads gone from `packages/server` tests. Commit per ~12 files: `test(sync|transport): <batch> on both drivers (1B task 12, n/4)`.

---

### Task 13: Delete the hybrid handle; CI on both drivers is the only mode

**Files:**
- Modify: `packages/server/src/db/testing.ts` (delete `hybrid`, `openTestDb`, `openTestTraceDb`, `TestDb`), `.github/workflows/ci.yml` (keep `MUSTERD_TEST_DRIVER: both`), `docs/architecture/03-server.md` (testing.ts line), `docs/wiki/running-the-gates.md`

- [ ] **Step 1:** `grep -rn "openTestDb\|openTestTraceDb\|TestDb" packages/server/src` → empty (the 30 CLI test files use `openDb` + `createServer`, untouched; they stay SQLite by design — the CLI is the laptop). Delete the hybrid. `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check` green; `MUSTERD_TEST_DRIVER=both npx vitest run packages/server` green; record the wall time.
- [ ] **Step 2: Commit** `test(server): the hybrid test handle is gone — every store test runs on both drivers (1B task 13)`.

---

### Task 14: The Neon pass, the result page, and the docs

**Files:**
- Create: `scripts/cloud/neon-pass.mjs`, `docs/perf/neon-pass.md`
- Modify: `.gitignore` (nothing — the env file lives outside the repo), `docs/decisions/479-two-store-backends.md` (dated Consequences note), `docs/architecture/01-data-model.md`, `03-server.md`, `docs/wiki/running-the-gates.md`

- [ ] **Step 1: The script.** Reads `~/.musterd/cloud/neon.env` (`DATABASE_OWNER_URL`, `DATABASE_APP_URL`, `DATABASE_OPERATOR_URL` — three login users the operator created with `neonctl`, granted `musterd_owner`/`musterd_app`/`musterd_operator` respectively after the first `migratePostgres` run created the roles), refuses to run if the file is not mode 600, never prints a URL. Steps: `migratePostgres(pgDriver(owner))`; `GRANT musterd_app TO <app user>; GRANT musterd_operator TO <operator user>` (owner); then runs `vitest run packages/server/src/db/tenancy.test.ts packages/server/src/db/pg` with `MUSTERD_TEST_DRIVER=pg` — add `'pg'` as a third `DriverKind` in `testing.ts` that `openTestDriver` satisfies from the env file (operator handle; TRUNCATE between tests as owner) — and then the whole server store suite under `MUSTERD_TEST_DRIVER=pg`. Writes a summary (counts, durations, Postgres `version()`, no URLs) to stdout for the result page.
- [ ] **Step 2: Nick's part (out of band):** `neonctl auth`, `neonctl projects create --name musterd-1b`, create the three users, write the env file (`chmod 600`). The plan does not script secrets.
- [ ] **Step 3: Run the pass;** write `docs/perf/neon-pass.md` (date, Neon region + Postgres version, suite counts on `pg`, tenancy test result, any dialect finding that PGlite did not model and the fix). If a finding is a driver or translator bug, fix RED→GREEN and rerun before recording.
- [ ] **Step 4: Docs.** ADR 479 Consequences: dated note (1B landed: pg driver, baseline+ladder, tenancy test, suite on both drivers with N files, the Neon pass result). `01-data-model.md` §Two dialects: the tenancy paragraph (policy shape, allowlist, `forTeam`/`asOperator`, the four tables). `03-server.md`: tree lines for `pg/`, `pgDriver.ts`, `ladder.ts`, `guard.ts`, `tenancy.test.ts`; testing.ts line ("kinds: sqlite | pglite | pg"). Wiki: `running-the-gates.md` — "the pg kind needs the env file; CI never has it".
- [ ] **Step 5:** fast gates; commit `feat(cloud): the Neon pass — real Postgres proves the ladder, the roles and the tenancy test; 1B docs (1B task 14)`; final whole-branch review (fresh read-only reviewer, most capable model — the 1A one found a Critical; budget for a fix pass); PR ready; `gh pr merge --squash --auto --delete-branch`; `lane_submit`.

---

## Self-review (done while writing)

- **Spec coverage:** §12.1 → Tasks 2, 3 (stamping), 8, 9; §12.2 → 3, 5, 6, 7; §12.3 → 4, 10 (tenancy), 5–7 (ladder), 11–13 (the 96 files), 14 (Neon); §12.4 → 8 (`unavailable`), 1 (ADR); §12.5 done-when → 13 + 14. §6 guard → 6. §8.2's "production app role, never owner" → the app pool in Task 8 and `SET LOCAL ROLE musterd_app` in the double (Task 3); "per transaction SET LOCAL" → Tasks 3, 8; "alternating tenants on reused pooled connections" → Task 10 (iii).
- **Placeholders:** the pool-choreography `txHandle` dead-flag wiring is left to the implementer with the constraint stated (Task 8 step 3); Task 11/12 are recipe tasks by design, with the exact transformations and the batch/commit rhythm.
- **Type consistency:** `forTeam(teamId: string): Driver`, `asOperator(): Driver`, `migratePostgres(owner: Driver): Promise<number>`, `teamOwnedTables(d: Driver): Promise<string[]>`, `GLOBAL_TABLES`, `ROLE`, `TENANT_SETTING`, `tenantPolicySql(table)`, `LADDER`, `PortableMigration`, `assertSchemaNotNewer(have, max)`, `SCHEMA_NEWER_SENTENCE`, `pgDriver(opts)`, `PoolFactory`, `openTestDriver(kind, { team?, instance? })`, `openTestServer(kind, opts)` — named identically throughout.
- **Review Focus:** 1 → Task 5 step 4 + Task 10 (ii) seeds through the store paths as app role; 2 → Task 9 step 5; 3 → Task 8 test 3 + Task 10 (iii); 4 → Task 6; 5 → Tasks 11–13.

## After 1B

1C (cloud mode: `MUSTERD_MODE=cloud`, config wiring `MUSTERD_DATABASE_*_URL` → `pgDriver`, loopback audit, test issuer, the 503 with the stable sentence, host-name isolation) and 1D (deploy to Fly behind Cloudflare, the §8.1 load test, rolling expand/contract rehearsal on a Neon branch) each get a plan of this shape. Nothing in 1B is reopened by them: they consume `pgDriver`, `migratePostgres`, `DriverError('unavailable')` and `SCHEMA_NEWER_SENTENCE` as defined here.
