# What one test pays before its first assertion — the per-open cost on both store engines

- Date: 2026-10-03 · lane `01M3ZRQAGDDMTG6TA9T27D02N9` (goal `ci-cost`) · follows ADR 498 / ADR 499
- Question: the PGlite leg is ~85% of the CI coverage leaf's CPU (runs 37085242981 vs 37084809904:
  ~2,470 file-seconds on both drivers against ~370 on SQLite alone; `integration.test.ts` ≈ 1.7 s
  per test on PGlite, 0.14 s on SQLite). Where does a test's fixed cost go, and which part is cheap
  to cut?
- Method: one-off scripts on the laptop (Apple M3, Node 22) against the built `packages/server`,
  medians of 8–30 operations on one instance; nothing from the suite was run. CI's 2-vCPU runner is
  2–3× slower than these numbers, in the same proportions.

## Result

| Per-open cost | Measured | Share of a 1.7 s PGlite test |
| --- | --- | --- |
| PGlite `TRUNCATE` of all 44 tables `RESTART IDENTITY CASCADE` (what `openTestDriver('pglite')` does) | 21 ms | ~1% |
| PGlite `createServer` + `listen` (a test daemon) | 2 ms (first 6) | — |
| PGlite cold start + `migratePostgres` (once per worker **per file**, `isolate: true`) | 1,106 ms | per file, not per test |
| SQLite `openDb(':memory:')` — the full 84-step ladder replayed on every open (before) | **24.5 ms** | the whole SQLite per-test fixed cost |
| SQLite clone of a once-migrated template (`serialize()` → `new Database(buffer)`) (after) | **0.27 ms** | 90× cheaper |
| SQLite `createServer` + `listen` | 1 ms | — |

Cheaper PGlite resets exist (`DELETE FROM` all 44 in one statement: 0.7 ms) but drop `RESTART
IDENTITY`, which tests rely on, and buy ~20 ms a test — not the lever.

## What it changes

- **The PGlite leg's cost is the statements themselves, not the harness.** Truncate plus boot is
  under 3% of a PGlite test; the remaining ~1.65 s is the test's own queries through the WASM engine
  under coverage. There is no cheap harness-side cut; the compute levers for that leg are *where* it
  runs (ADR 492's scoping, ADR 499's docs-only skip) and *on how many machines* (ADR 498).
- **The SQLite leg had a 90× cut hiding in `openDb(':memory:')`.** Every test opens an in-memory
  store (through `openTestDriver`, through 73 direct `openDb(':memory:')` calls in 42 test files, and
  every test daemon's trace store on boot), so the ladder replayed ~9,500 times a run. `open.ts` and
  `traceDb.ts` now migrate once per process and clone the serialized template; `open.test.ts` holds a
  clone to be a freshly migrated database (same `sqlite_master`, same version, same pragmas, nothing
  shared). Expected on CI: ~9,500 × (24.5 ms × 2–3) ≈ 450–700 file-seconds less per run.
  **Measured 2026-10-03 (#2012's run against #2010's, both drivers, the same three shards, back to
  back): vitest `tests` time 2,524 → 2,295 s (−229 s, −9%); shard wall 678/425/424 → 655/366/386 s
  (−120 s, −8%).** Below the estimate — fewer than 9,500 opens replay the ladder, since many of the
  SQLite-leg tests open no store — and real: shards 2 and 3, the store-heavy ones, lost 14% and 9%;
  shard 1, dominated by `integration.test.ts`'s PGlite leg, lost 3%.
- PGlite's per-file cold start (1.1 s × every `withDrivers` file) is the next fixed cost worth a
  number: a `loadDataDir` snapshot would skip the migration, not the WASM start. Open, not promised.

## Falsifier

Rerun the three scripts (`scratchpad/truncate-bench.mjs`, `boot-bench.mjs`,
`sqlite-template-bench.mjs` of lane `01M3ZRQAGDDMTG6TA9T27D02N9`'s session, or their equivalent): if
the full-ladder open is under 5 ms or the clone over 2 ms, or if the first CI run after the clone
landed shows the SQLite-only coverage job's `tests` time within 10% of 370 file-seconds, this page is
wrong about where the SQLite leg's time went.
