# 504 — origin_seq is taken at commit, not at insert: the node counter's lock lasts one statement, not a transaction

- Status: accepted
- Date: 2026-10-03
- Deciders: nick (chose this option over "no seq on Cloud" and "a Postgres sequence", 2026-10-03),
  fifty (lane `01M3Z455NEWNZMCJ5KR6EX3TG0`)
- Amends: [ADR 331](331-ordering-substrate.md) — *when* a number is taken; what it means is unchanged
- Relates to: [ADR 325](325-multi-machine-federation.md) (why the seq exists), [ADR 479](479-two-store-backends.md) /
  [ADR 486](486-pg-driver-dependency.md) (the async Driver and the pg driver),
  [docs/perf/daemon-load-baseline.md](../perf/daemon-load-baseline.md) (Cloud runs 4–5)

## Context

ADR 331 numbers every message and audit row with `(origin_node, origin_seq)`, drawn from the
team's `nodes.next_seq` row: `UPDATE nodes SET next_seq = next_seq + 1 … RETURNING next_seq - 1`,
then the `INSERT`, in one transaction. Two properties are load-bearing for sync
(`sync/push.ts`, `sync/log.ts`):

1. **Gapless** — a puller holding 1–4 and 10 must know 5–9 are undelivered, never unwritten
   (`SyncGapError`).
2. **Visible in order** — push reads `origin_seq > cursor ORDER BY origin_seq` and advances the
   cursor to the last row it sent. If seq 6 commits before seq 5, a push between the two commits
   sends 6, moves the cursor past 5, and 5 is never pushed.

On SQLite both hold for free: one writer at a time. On Postgres the `UPDATE` takes the node row's
lock and keeps it **until the outermost transaction commits**. `insertMessage` and the audit
writer are called early inside larger transactions (a lane create writes the lane, audit rows and
messages, and keeps going), so every write on a team waits for the whole of the previous write.

Cloud load runs 5a–5c measured it (2026-10-03, after #2026 and a pool of 40): reads p95 0.6–2.4 s,
but `POST /lanes` server-side p50 293 ms and p95 15.9 s, max 30.9 s, with no errors behind them —
the queue on one row.

## Problem

Keep both properties and stop holding the counter's lock for a whole transaction.

## Decision

1. **A row is written with a placeholder and numbered at commit.** `insertMessage` and
   `appendReplicatedEvent` insert with a **unique negative** `origin_seq` (`pendingSeq()`) and
   register the numbering with the transaction. Not 0: `idx_messages_origin (origin_node,
   origin_seq)` is unique and not partial, so two open transactions writing `(node, 0)` would make
   the second wait on the first's uncommitted row — the same queue again. A negative value is never
   read: push and retention walk `origin_seq > cursor ≥ 0`, and `SyncEventSchema` refuses ≤ 0.
2. **The driver runs a pre-commit step.** `Driver.tx` gains `beforeCommit(fn)` on a tx handle: the
   callbacks run in registration order as the last statements of the **outermost** transaction,
   immediately before `COMMIT` (a nested `tx`/SAVEPOINT hands its registrations to the outer one; a
   rollback discards them). The SQLite drivers implement the same seam, so one code path serves
   both engines.
3. **Numbering takes the lock at the end.** Each registered row runs `takeSeq` — ADR 331's
   `UPDATE nodes SET next_seq = next_seq + 1 … RETURNING next_seq - 1` — then stamps its row, in
   insert order, back to back. The lock is held from the first of those statements to `COMMIT`,
   instead of from the transaction's first write to `COMMIT`. (One bump per row, not one per
   transaction: simpler, and the window is still the commit tail.)
4. **Both properties still hold, by the same lock.** Gapless: the bump and the stamps commit or roll
   back together, as before. In order: the next transaction to number rows waits for this one's
   `COMMIT`, so seq order is commit order.
5. **Nothing reads a row's seq before commit.** `MessageRow.origin_seq` / the audit row's are
   returned as the committed value: the writer resolves them in the pre-commit step, and callers
   that today read the returned row after the transaction see the stamped number. A row with
   `origin_seq = 0` exists only inside an uncommitted transaction; push already filters
   `origin_seq > cursor ≥ 0`.

## Consequences

- One extra round trip per numbered transaction on Postgres (the stamp `UPDATE`), against a lock
  held for the whole transaction today. Expected: write latency falls to the read curve; measured by
  the next §8.1 run.
- A body that reads its own message's `origin_seq` inside the transaction now sees 0. None does
  today (audited 2026-10-03: only `sync/push.ts` and `sync/log.ts` read it, both outside a write
  transaction); a test pins that the returned row carries the committed number.
- Rejected: **no seq on Cloud** — simplest, but Cloud would silently lose gap detection the day it
  joins a sync; **a Postgres sequence** — gaps on rollback and out-of-order visibility, breaking both
  properties for every deployment.

- **2026-10-04 — falsified by Cloud load run 6 and reverted.** With this decision deployed
  (188f73e6, pool 40), p95 rose from run 5c's 2.6 s to 7.0 s; server-side `POST /lanes` p95 from
  15.9 s to 20.9 s; agent `POST /messages` p50 from 2.1 s to 13.8 s. The node counter was not the
  write queue: moving the bump to commit added two statements per numbered row (a lane write numbers
  several audit rows) and removed no wait. The code was reverted; ADR 331's at-insert numbering
  stands. The queue's real cause is to be read from Postgres lock waits sampled during run 7 (lane
  `01M3Z455NEWNZMCJ5KR6EX3TG0`). The `Decision` above is kept as written, as the record of what was
  tried.

- **2026-10-05 — the 2026-10-04 note above overstated it.** Run 7, on the revert (791793fb), was
  slower still (p95 9.3 s), so the jump from run 5c to run 6 was not this decision: `main` moved
  between the two. What stands is "no effect", not "made it worse". The queue, measured in run 9 with
  per-request timing (#2063), is the pool: every statement checks a client out, ~870 000 checkouts in
  a run; see [ADR 507](507-pg-request-lease.md).

## Observability & Evaluation

**Traces.** n/a — no new span kinds. The request log's per-request `ms` (the line #2000 added) is
what shows the queue: server-side write latency by route.

**Eval.** Success is: the next §8.1 load run's server-side `POST /lanes` p95 falls from run 5c's
15.9 s to the read curve (under ~2.5 s), with zero `SyncGapError` in the sync tests on both drivers.

**Experiment.** Falsifier: writes still queue at the same depth after this lands — then the counter
row was not the bottleneck, and this ADR's Context is wrong.
