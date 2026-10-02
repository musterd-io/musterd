# The Neon pass — 1B's store on real Postgres

- Date: 2026-09-30 · lane `01M3SQHCJNSWM340JFV5FW89YM` (plan 1B, Task 14) · ADR 479, ADR 486
- Target: Neon project `musterd-1b`, aws-us-east-1, Postgres 17; app and operator logins on the
  pooled endpoint, owner on the direct endpoint. Run from nick's laptop (Apple M3, Node 22).
- Method: `node scripts/cloud/neon-pass.mjs` — `migratePostgres` + `migrateTracePostgres` as the
  owner, `GRANT musterd_app` / `musterd_operator` to the login users, then vitest with
  `MUSTERD_TEST_DRIVER=pg`, one worker (one database for every test). The whole-suite run hung at
  ~35 min with Neon idle, so the store files were rerun one at a time with a 4-minute cap each.
- Question: does what CI proves on the PGlite double hold on a real Postgres over the network?

## Result

| | |
| --- | --- |
| Migration (baseline v80 + ladder, both stores) | applied, idempotent on rerun |
| **Tenancy leak test (spec §8.2, parts i–iv)** | **4/4 pass** |
| `db/pg` (migrate, drift) | 6/6 pass |
| Store files run before the 2 h background cap | 55 of 68 — 39 pass, 16 fail |

### What the 16 failures were

| Kind | Files | Verdict |
| --- | --- | --- |
| BIGINT / `COUNT(*)` returned as a string (`'1'`, `'2000'`) | 5 | **Real driver bug the double hid** (PGlite parses oid 20; `pg` does not). Fixed in `pgDriver.ts` with a per-pool type parser; no file failed on it after the fix. |
| Test timeout at 30 s | 9 | Latency, not correctness. Every statement on the `pg` driver is its own stamped transaction — BEGIN, SET LOCAL ROLE, set_config, statement, COMMIT: five round trips over a WAN. Heavy store tests exceed 30 s. |
| Deadlock / FK violation on `members.team_id` | 5 | Test isolation on one shared database: a test's deferred writes still in flight when the next test truncates. The `pg` test kind now settles and retries a deadlocked TRUNCATE. |
| Owner-only DDL in a fixture / `onStatement` | 3 | Test-side: a fixture renames `audit` (needs table ownership the operator login lacks), one counts statements through the SQLite/PGlite seam the `pg` driver does not expose. |

Not reached: 13 files (the trace store tests, toolCalls, the store tail).

## What it changes

- 1B's correctness claims — RLS fail-closed, team scoping, alternating tenants on a reused
  connection — hold on real Postgres, not only the double.
- One real bug found and fixed (BIGINT parsing) that no CI run could have caught.
- **The per-statement transaction is the cost to watch for 1C/1D:** five round trips per bare
  statement is fine on a same-region pool and painful over a WAN. 1D's load test (§8.1) runs
  co-located with Neon and is where it is measured honestly; batching bare reads into one
  transaction per request is the lever if it is too slow.

## Falsifier (2026-09-30)

Rerun `node scripts/cloud/neon-pass.mjs` against a fresh Neon branch: if the tenancy test fails, or
a store file fails for a reason other than the four kinds above, this page is wrong.

> Fired 2026-10-02: a fifth kind — see below. The four kinds still hold; the page was incomplete,
> not wrong about them.

## Second result — 2026-10-02 (cloud increment 1D)

- Lane `01M3Z429Q3Y69K1A4ZNX631Q8Y` · the same `musterd-1b` project, Postgres 17.11, now run from a
  one-shot Fly machine in `iad` next to Neon (`scripts/cloud/bench-run.mjs`, performance-2x), never
  the shared laptop. Build `fecee783` on top of main `39cec85e`. Fifty's checkpoint 21:29–21:49Z and
  izzo's rerun 22:04–22:25Z gave identical verdicts; the rerun captured each failure's error and
  statement (`neon-pass --per-file` now prints them).
- Migration: main v84 / trace v4 in 2.1 s. **Tenancy + `db/pg` + PGlite double: 35/35 pass.**
- Per-file, 240 s cap: **all 68 store files reached** (the 13 the first pass never ran included) —
  **47 pass, 21 fail, 0 timeout.** Co-located, the 09-30 "30 s test timeout" kind is gone: the
  slowest files are residency (127 s, 111 tests) and quiescence (182 s — the fake-timers row below).

### What the 21 failures were (168 tests)

| Kind | Tests (files) | Verdict |
| --- | --- | --- |
| `column "follows_up_json" of relation "lanes" does not exist`, on every lane `UPDATE` | 127 captured in 12 files: lanes 40/66, orientation 25/36, residency 20/111, laneSweep 10/10, laneClose.authorization 7/7, incidents.route 7/25, insights 5/55, review 4/47, incidents 3/10, parked 3/11, stakesProvenance 2/8, staleness 1/6 — plus, almost certainly, the 27 in the seven files whose errors the log window dropped (closeReason 8/8, followsUp 10/21, delivery 5/23, auditSubject, deferralFold, goals, governed 1 each; the one surviving line is this error) | **Kind 5 — schema drift on the live database. Not a driver bug.** `musterd-1b` reports `schema_version = 84` yet its `lanes` table lacks v81's `follows_up_json` and `abandon_reason` (v82's `unfinished_todos_json` and v84's `console_token_jti` are there). The 09-30 pass migrated the project (created 16:54Z) from the 1B branch, hours before it merged (04:16Z next day), when v81 on that branch was a different step; `migratePostgres` applies "every ladder step above the version row" and never looks at the catalog, so the final v81 was skipped as done. `drift.test.ts` cannot see this — it lands baseline + ladder on a fresh database. **Production `musterd-cloud` was created 2026-10-02 20:43Z on the final ladder and is not exposed** (Neon API `created_at`). Repair for 1b: the ladder's own two `ALTER TABLE lanes ADD COLUMN IF NOT EXISTS …` statements as owner — a human step (nick), pending. Structural fix: lane `01M3ZC2DBEH5YETNKJ5QX0QJT7` — the migrate step verifies the landed schema against the catalog, not the version row. |
| `db.onStatement is not a function` | 5 (residency) | Kind 4, test-side: the statement seam existed on `SqliteDriver` and the double only. Fixed on this branch: `PgDriver.onStatement` reports every store statement as written (never the BEGIN / SET LOCAL / set_config / COMMIT stamping), so the query-shape counts run on real Postgres too. |
| `permission denied for schema public` on a fixture's `CREATE TABLE` / `CREATE FUNCTION` | 3 (lanes 2, store 1) | Kind 4, test-side: the double runs `exec` as the owner by construction; the pg test kind ran it as the operator, who owns nothing in the schema. Fixed: `openTestDriver`'s handle runs `exec` as owner on both engines (production handles are untouched). |
| Test timed out at 30 s, every test in the file | 6 (quiescence) | Kind 4, test-side, not Neon latency: the file opens its store inside `vi.useFakeTimers()`, and the pg kind's 250 ms settle in `openTestDriver` was a `setTimeout` a faked clock never fires — 6 × 30 s = the file's 182 s. Fixed: the settle uses the real timer captured at import. |

The three harness fixes are verified on the PGlite double and by `pgDriver.test.ts`; their effect on
Neon, and the 27 uncaptured tests, are confirmed by the rerun after the v81 repair (recorded below
when it has run).

### What it changes

- The 1B claims stand on real Postgres: tenancy 4/4 on both passes, and 47 store files clean of any
  driver kind; the one real driver bug stays the 09-30 BIGINT parser.
- **A version row is a claim, not evidence.** The Postgres ladder trusted `schema_version` and
  shipped a database that could not update a lane. Any Cloud database migrated from a branch before
  the ladder's numbers are final can carry the same hole; the migrate step has to read the catalog.
- Co-location removes the latency kind entirely; the per-statement transaction cost moves to 1D's
  load test (§8.1), where it belongs.

### Falsifier (2026-10-02)

Run `node scripts/cloud/bench-run.mjs --secrets-from ~/.musterd/cloud/neon.env -- node
scripts/cloud/neon-pass.mjs --per-file` after the v81 repair: if any store file fails for a reason
other than the five kinds above, or a kind-4/5 file still fails, this page is wrong. Until lane
`01M3ZC2DBEH5YETNKJ5QX0QJT7` lands, the first thing to check on any failing Neon pass is the
catalog, not the driver.
