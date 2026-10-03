# 496 — The migrate step verifies the landed schema against the catalog: the version row is a claim, not evidence

- Status: proposed
- Date: 2026-10-02
- Deciders: izzo (nick asked for the lane to be taken on 2026-10-02)
- Lane: `01M3ZC2DBEH5YETNKJ5QX0QJT7` (goal `cloud`), found by lane `01M3Z429Q3Y69K1A4ZNX631Q8Y`
- Relates to: ADR 479 (two store backends), ADR 486 (the `pg` driver), the cloud design spec §6
  (schema changes and deploys) and §12.2 (one portable ladder)

## Context

The Postgres ladder (`db/pg/migrate.ts`) is keyed on one number: `schema_meta.schema_version`.
`migratePostgres` applies every ladder entry above it and never looks at what the database actually
has. `drift.test.ts` holds the baseline + ladder to the SQLite schema — on a **fresh** database.

On 2026-10-02 the Neon pass ([docs/perf/neon-pass.md](../perf/neon-pass.md)) found `musterd-1b`
at `schema_version = 84` with a `lanes` table that had never received v81's `follows_up_json` and
`abandon_reason`. The 2026-09-30 pass had migrated the project from the 1B branch hours before it
merged, when v81 on that branch was a different step; once the ladder's numbering was final, v81
was "already applied" by the row and skipped. Every lane `UPDATE` on that database failed —
127 captured tests in 12 store files, 27 more in 7 — while the migrate step reported it current and
boot would have served it. Production (`musterd-cloud`) was created after the ladder was final and
was not exposed; the same gap re-opens for any database migrated from a branch before the ladder's
numbers settle, and spec §6's own rehearsal step ("on a Neon branch of production") is exactly
such a database.

## Problem

A version row records what some build once ran, not what the database holds. Nothing between the
ladder and the first request reads the catalog, so a database that cannot update a lane is
"migrated" and "healthy" by every check that exists.

## Decision

1. **After the ladder, the migrate step verifies the landed schema against the catalog.**
   `expectedSchema(store)` (`db/pg/expectedSchema.ts`) derives the table → column set a Postgres
   database must carry by landing the SQLite ladder on an in-memory `better-sqlite3`, under the two
   translation rules spec §12.2 allows the engines to differ by (FTS5 shadow tables are SQLite-only;
   the tsvector column is Postgres-only). It is derived, never hand-kept: a new ladder entry needs no
   second file. `verifyPostgresSchema(d, store)` reads the live `public` base tables from
   `pg_catalog` — which every role sees whole, where `information_schema` hides what the current
   role holds no privilege on — and returns `{ missing, extra }` as `table` or `table.column`.
2. **Missing is drift; drift refuses.** A table or column the ladder lands and the database lacks
   fails `migratePostgres` / `migrateTracePostgres` with the stable sentence
   `schema drift: missing <items>`. `assertSchemaCurrent` — the cloud boot check — applies the same
   verification after its version checks, so a drifted database never serves.
3. **Repair is explicit and reported, never silent.** `migratePostgres(owner, { repair: true })`
   replays every ladder entry — each is idempotent by the ladder's own contract (`db.test.ts` runs
   it twice) — verifies again, and reports `schema drift repaired: <items>` through `report`. Still
   missing afterwards refuses. The cloud migrate step opts in with `MUSTERD_MIGRATE_REPAIR=1`; the
   Neon pass with `--repair`. The version row is never rewritten by a repair.
4. **Extra is reported and left alone.** Tables and columns the ladder does not know (a fixture's
   scratch table, an operator's) are printed as `schema extras (not the ladder's, left alone)` and
   get no tenant policy: the policy loop after the ladder covers the ladder's tables only, where it
   used to apply `team_id = …` to every base table and die on one without the column.
5. `drift.test.ts` keeps its assertion and runs it through the same `verifyPostgresSchema` on a
   fresh double, so the fresh-database check and the live-database check cannot disagree about
   what the schema is.

Weighed and rejected: a content hash per ladder entry recorded in `schema_meta` (a renumbered or
reworded step detected at apply time). Function-shaped entries hash their source; any refactor of
one would refuse for nothing, and the catalog check catches the outcome whatever the cause.
Index and constraint verification wait until a pass shows one missing; tables and columns are what
broke.

## Consequences

- A database migrated from a branch, then by `main`, is refused with its drift named instead of
  served; the operator repairs on purpose. The rehearsal database spec §6 asks for is covered by
  the same step.
- The migrate step reads the catalog and runs one in-memory SQLite per process (~100 ms); boot
  pays one catalog query per store.
- `migratePostgres` gains an options argument; existing callers and tests are unchanged
  (`number` is still returned).
- A hand-added table no longer gets a tenant policy automatically; it is reported instead. The
  ladder's own tables are covered as before.

## Observability & Evaluation

**Traces.** No new trace event. The migrate step's own output is the record: `scripts/cloud/migrate.mjs`
and `scripts/cloud/neon-pass.mjs` print `schema drift: missing …` (and exit 1), `schema drift repaired: …`
when `MUSTERD_MIGRATE_REPAIR=1` / `--repair` replayed the ladder, and `schema extras (not the ladder's,
left alone): …`. A cloud server that boots against a drifted database refuses with the same sentence,
which `/health` surfaces as it does `schema older than this build`.

**Eval.** Dataset: every Neon pass (`docs/perf/neon-pass.md`) and every cloud deploy's migrate output.
Baseline: 2026-10-02 — `musterd-1b` at v84 without v81's two columns, reported current by the migrate
step, 154 store tests failing on `column "follows_up_json" … does not exist`, diagnosed by hand from a
per-file digest. Target: the same database refused at the migrate step with
`schema drift: missing lanes.abandon_reason, lanes.follows_up_json` before any test runs, and repaired
in one opted-in run; `pg/migrate.test.ts` pins both on the double.

**Experiment.** n/a. A migrate step either names the drift or it does not; the kind-5 row of the Neon
pass page is the running count of times it had to.

Falsifier: a Postgres database whose catalog lacks a table or column the ladder lands, that
`migratePostgres` returns a version for or `assertSchemaCurrent` passes; or a `--repair` run that
leaves the version row changed or a replayed entry failing on a database the ladder already covered.
