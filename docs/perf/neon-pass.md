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

## Falsifier

Rerun `node scripts/cloud/neon-pass.mjs` against a fresh Neon branch: if the tenancy test fails, or
a store file fails for a reason other than the four kinds above, this page is wrong.
