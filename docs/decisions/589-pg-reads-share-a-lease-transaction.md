# 589 — Consecutive reads on a request's leased Postgres client share one transaction

- Status: accepted
- Date: 2026-10-13
- Deciders: nick (chose this over bundling statements with inlined values, 2026-10-13), fifty (lane
  `01M4VV1HYE2EF0AMXP9BSZRA3W`)
- Amends: [ADR 507](507-pg-request-lease.md) §2 — for reads only; writes and `tx` bodies keep their
  own stamped transaction
- Relates to: [ADR 486](486-pg-driver-dependency.md) (the driver and its one-trip opening),
  [docs/perf/daemon-load-baseline.md](../perf/daemon-load-baseline.md) (runs 38, 38b and 39)

## Context

ADR 507 gave a request one leased client per pool, and kept every statement its own transaction:
`BEGIN; SET LOCAL ROLE …; set_config(…)` in one round trip, then the statement, then `COMMIT`. That
makes three round trips to Neon for every statement, of which one does the work.

Cloud run 39 (2026-10-13, `6fd7aca`, #2533) captured the server's `http_request` lines for a whole
75/75/75 run:

- No request waited for a connection (`db_wait_ms` 0 at p95).
- The median request opened 6 transactions and held its client 163 ms, of which 54 ms was the driver
  waiting on statements. That is 8.7 ms per transaction at p50, for statements Postgres ran in 1–2 ms
  (run 38b's `pg_stat_statements`).
- Interrupt-check, the hottest route (16 800 calls a run), opened 15 transactions to return nothing.
  `GET /inbox` opened 23 and `POST /claim` 28.

#2543 (lane `01M4VR41VE`) took 4 statements out of the presence touch every authenticated route
runs. After it, interrupt-check runs about 11 statements, nearly all reads:

- one operator read of the team;
- five reads of the team, member, lease, presence row and liveness;
- one presence `UPDATE`;
- four reads of the cursor, window, own acts and names.

That is about 33 round trips.

Across the store, 495 `get`/`all` calls begin with `SELECT`. Five begin with `UPDATE`, `INSERT` or
`DELETE … RETURNING`: `governed.ts:258`, `messages.ts:96`, `nodes.ts:65`, `nodes.ts:353` and
`sync/log.ts:247`. No store SQL takes a row lock (`FOR UPDATE` / `FOR SHARE`), calls
`nextval`, takes an advisory lock or overrides the isolation level. Every transaction runs at
Postgres's default READ COMMITTED. Each statement takes a fresh snapshot, so whether two reads share
a transaction does not change what either one returns.

ADR 507 rejected one transaction per request for three reasons:

- a caught statement error would abort every later statement;
- writes would stay invisible to other requests until the response;
- a long request would hold row locks for its whole life.

The decision below shares a transaction only between reads, so none of the three applies:

- a failed read discards the client, and the next statement starts afresh;
- a write commits at once;
- a plain `SELECT` takes no row locks.

## Problem

Cut the round trips a request spends on reads, without changing:

- what any statement returns;
- when a write becomes visible;
- which role and tenant a statement runs as.

## Decision

1. **A read is decided by its SQL text, not its method.** A statement is a *read* when:
   - it is sent through `get` or `all`;
   - its text, after leading whitespace and comments, begins with `SELECT`;
   - it carries no locking clause (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`,
     `FOR KEY SHARE`).

   Everything else is a *write*, including the five `get`s above that write and return rows, every
   `run`, every `exec` and every `tx`.
2. **On a leased client, a read leaves its transaction open, and the next read of the same scope runs
   inside it.** The lease records the scope (role and tenant) of the read transaction it left open.
   - A read whose scope matches the open one sends only its statement: one round trip.
   - A read with no open transaction, or a different scope, sends its opening, prefixed by `COMMIT; `
     when one is open, then its statement, and leaves the transaction open: two round trips.
3. **A write commits any open read first, in the same round trip as its own opening.** A write, or a
   `tx` body, sends `COMMIT; BEGIN; SET LOCAL ROLE …; set_config(…)` as one simple query. It then
   runs and commits exactly as ADR 507 §2 says. A write's transaction is never left open. The time a
   write becomes visible to other requests does not move.
4. **A lease commits before it lets go.** Each of ADR 507's release paths sends `COMMIT` before the
   client returns to the pool:
   - the 250 ms idle-out;
   - the 1 s age-out;
   - the request's end;
   - a broken client, which still releases with its error and does not commit.

   At the request's end that commit happens after the response is written, off the latency path.
5. **A failed read rolls back only reads.** A statement that fails inside an open read transaction
   rolls back and discards the client, as ADR 507 §6 does. Its error reaches its caller. The reads
   before it have already returned their rows and changed nothing, so nothing is lost.
6. **Outside a lease nothing changes.** Loops, sweeps, WebSocket frames and deferred work still check
   out a client per statement, run one stamped transaction each, and never leave one open. SQLite
   and the PGlite double are unchanged.

## Consequences

- **Round trips.** Interrupt-check goes from about 33 round trips to about 17:
  - the operator read: 3;
  - five reads: 2 + 4 × 1;
  - the presence write: 3;
  - four reads: 2 + 3 × 1.

  The final commit happens after the response. Read-heavy routes gain most, and a route that
  alternates reads and writes gains least.
- **Locks are held for a run, not for one statement.** Each read takes `AccessShareLock` on what it
  reads, and the lock is held until the run commits. That is at most 250 ms idle or 1 s of lease age
  (ADR 507 §5).

  The one statement that conflicts with that lock is DDL taking `ACCESS EXCLUSIVE`, which is a
  migration (spec §6). Such a migration waits for the open runs to commit, at most about 1 s, where
  today it waits only for the in-flight statements. Queries queued behind it wait as long.
- **`idle in transaction` becomes a normal state.** `pg_stat_activity` will show leased clients
  `idle in transaction` for up to 250 ms. A READ COMMITTED transaction that has written nothing
  holds no snapshot between statements, so vacuum is not held back by it. The Experiment below
  checks this, not trust.
- **Neon's pooler pins the server connection for the length of a run.** The app reaches Neon through
  its pooler (run 1's setup). A transaction pins a server connection for its life, so a run pins one
  for up to 1 s instead of one statement. The app's 10-client pool already bounds the pins at 10.
- **The read rule is a promise the store must keep.** A statement that begins with `SELECT` but
  writes, through a volatile function or a writing CTE, would have its write committed late, or
  rolled back by a later read's failure. None exists today (Context). A new one would need the rule
  to learn it.
- **`db_tx` changes meaning.** It counts transactions opened, so it falls. Comparing it across this
  change is not a like-for-like comparison. The implementation adds `db_stmt` (statements sent) to
  the `http_request` line, so a request's work and its transactions can be told apart.
- 2026-10-14 — **the snapshot premise above was wrong; the effect it guarded against did not show.**
  During run 40 (`1311808`, #2556), `pg_stat_activity` showed `idle in transaction` backends after a
  plain `SELECT` with a non-null `backend_xmin`. That was 5 of 7 such backends across four samples,
  in transactions 3–18 ms old. An open read run does pin the vacuum horizon for its length. Two
  things bound it in practice:
  - the run is capped at 250 ms idle and 1 s of age;
  - in the same run `presence`, the table that churns hardest, was autovacuumed to 0 dead rows.

  Experiment 2's first clause fired; its second, vacuum falling behind, did not. So runs stay as
  decided, and the vacuum check moves into every load run's readout. Ledger:
  `docs/claims/entries/2026-10-14-read-run-holds-no-snapshot.md`.
- 2026-10-14 — **the Eval met, by more than asked.** Run 40 against run 39, server-side:
  - median `db_hold_ms` fell from 163 to 51 ms;
  - interrupt-check's median hold fell from 247 to 55 ms, with 4 transactions for 11 statements;
  - the bench's p95 fell from 1 754 to 537 ms.

  #2543 shipped in the same deploy, so the run measures both changes together. Experiment 1's
  falsifier, hold falling while the p95 did not, did not fire: the p95 fell with it. The detail is in
  `docs/perf/daemon-load-baseline.md`, run 40.
- Follows-up: lane 01M4VVMNEX2CQB9TYSKA6CNGD4 builds it in `pgDriver.ts` with choreography tests on
  the injected fake pool, adds `db_stmt`, and measures it with a cloud run.

## Observability & Evaluation

**Traces.** n/a — no new span kinds. The `http_request` line carries the measure: `db_tx`,
`db_hold_ms`, `db_query_ms`, and the new `db_stmt`.

**Eval.** The pg driver's choreography tests on the fake pool prove the following round trips for
these sequences:

| Sequence | Round trips |
| --- | --- |
| read, read | `BEGIN…`, read, read |
| read, write | `BEGIN…`, read, `COMMIT; BEGIN…`, write, `COMMIT` |
| read in scope A, then read in scope B | `BEGIN…A`, read, `COMMIT; BEGIN…B`, read |

They also prove three more things:

- each release path commits;
- a failed read rolls back and discards;
- a write's statement is never followed by another statement in the same transaction.

On staging, success is a 75/75/75 run on the built change, with the run-39 capture. Against run 39,
interrupt-check's median `db_hold_ms` should fall from 163 ms by at least a third, with `db_stmt`
unchanged.

**Experiment.** Two falsifiers.

1. Hold time falls but the bench's p95 does not. Then round trips were not the cost. Run 39 put two
   fifths of the bench's p95 outside the handler, and the slowdown since `dc09c35` is elsewhere: in
   the edge, or in the Node process before `request`.
2. During the run, `pg_stat_activity` shows an `idle in transaction` backend with a non-null
   `backend_xmin`, or vacuum falls behind on `presence` or `messages`. Then decision 2 is holding
   back vacuum, and runs must commit sooner.
