# Async store layer — what the Driver cost the hook path

- Date: 2026-09-30 · machine: nick's dev laptop (Apple M3, Node 22) · lane 01M3R7F6H0 (plan 1A, Task 23)
- Question: plan 1A put every store call behind an async `Driver` ([ADR 479](../decisions/479-two-store-backends.md) §2).
  The PreToolUse gate is the latency-sensitive path. What did the Promise wrapper cost it?
- Method: `node scripts/perf/async-store-overhead.mjs <before-dist> <after-dist> 500`. The gate's
  own store calls, on two builds of `@musterd/server`, each in its own process on its own
  file-backed WAL database seeded through its own store functions (team, 50 members, 400 lanes,
  5,000 messages, 20,000 audit rows), `ANALYZE` after seed, one warm-up, 500 rounds.
  - **before** = `~/.musterd/runtime/packages/server/dist`, built from `main` at `604b6a70`
    (synchronous store functions on a raw better-sqlite3 handle).
  - **after** = `packages/server/dist` on `feat/store-driver-1a` (the same functions through the
    async Driver; `16a34506` plus the tx-handle change in the Task 23 commit).
- Bar (plan Task 23): after ≤ 1.2× before at p95 on every call.

## Result: pass, 1.05× worst — after the tx path was tightened

| call | before p50 / p95 / p99 (ms) | after p50 / p95 / p99 (ms) | after ÷ before (p95) |
| --- | --- | --- | --- |
| `getPolicy` | 0.014 / 0.018 / 0.076 | 0.012 / 0.013 / 0.024 | 0.70× |
| `laneCoveringPath` | 1.556 / 1.873 / 2.193 | 1.567 / 1.965 / 2.337 | 1.05× |
| `getMemberByName` | 0.014 / 0.015 / 0.023 | 0.006 / 0.009 / 0.029 | 0.61× |
| `countUnread` | 0.202 / 0.219 / 0.327 | 0.196 / 0.216 / 0.329 | 0.99× |
| `findGateAsk` | 0.232 / 0.261 / 0.368 | 0.228 / 0.259 / 0.348 | 0.99× |
| `appendAudit` (own transaction) | 0.058 / 0.077 / 0.142 | 0.036 / 0.056 / 0.095 | 0.73× |

Reads are at parity or faster: the Driver caches prepared statements per connection, where the
synchronous store re-prepared on every call (better-sqlite3's own cache absorbed most, not all, of
that). `laneCoveringPath` is the one call that is genuinely a little slower (+0.09 ms p95): it
hydrates ~400 lane rows and the per-row `await` is where a microtask each still shows.

## The first run failed the bar, on the write

The first measurement (300 rounds, same seed) passed every read and failed `appendAudit`:
0.088 → 0.128 ms p95, **1.45×**, with p99 0.33 → 0.59 ms. `appendAudit` opens its own
transaction, and the tx path was doing two things per call that reads do not: allocating a fresh
tx handle (seven closures) for every `tx()`/savepoint, and taking one extra microtask per
statement inside the body (`await guard()` even when the handle never waits). Both are now gone —
one tx handle per connection, and a synchronous fast path inside a transaction — and the write
came in at 0.73×. The read numbers moved within noise between the two runs.

## Rerun after the review fix pass (same day)

The whole-branch review's Critical (an outer statement could execute inside the *next* queued
transaction — two microtask hops against the queue's one) moved every outer-handle statement into
the reaction that observes the queue, and gave each transaction its own handle again (one that
refuses after its commit). Rerun, 500 rounds: `getPolicy` 0.59×, `laneCoveringPath` 1.01×,
`getMemberByName` 0.40×, `countUnread` 0.98×, `findGateAsk` 0.96×, `appendAudit` 0.66× —
**1.01× worst**. Per-transaction allocation was never the cost; the extra hop was.

## Falsifiers

- A `report trace`-visible PreToolUse gate p95 on the laptop daemon above 1.2× its pre-1A reading
  (the ADR 445 hook-call rows carry the timing) within a week of the refresh.
- `node scripts/perf/async-store-overhead.mjs` against a `main` build from before plan 1A
  reporting any call above 1.2× at p95 on a quiet machine.
