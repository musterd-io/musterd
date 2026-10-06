# 531 — `origin_seq` is stamped at commit, not at insert

- **Status:** accepted
- **Date:** 2026-10-06
- **Lane:** `01M477RVRV` (goal `cloud`)
- **Amends:** [ADR 331](331-ordering-substrate.md) §Decision 2 (where the counter is read and
  bumped). The invariant 331 exists for — `origin_seq` gapless per node, assigned in commit order
  — is unchanged.

## Context

ADR 331 numbers every replicated row — a message, a `lane.*` or `presence.*` audit event — with
`(origin_node, origin_seq)`, drawn from one counter per node, `nodes.next_seq`. `insertMessage` and
`appendReplicatedEvent` run `UPDATE nodes SET next_seq = next_seq + 1 … RETURNING` and insert the
row in the same transaction. On SQLite the single writer makes that gapless and commit-ordered for
free. On Postgres the same property comes from the row lock the `UPDATE` takes, which is held until
the transaction **commits**.

That lock is held for the rest of the *outer* transaction, not just the insert. `insertMessage`
opens a savepoint inside whatever the caller holds; a `claim` or `POST /lanes` bumps the counter
early and then runs a dozen more statements before its COMMIT. On Cloud a team is one node, so
every replicated write in a team queues on that one row for the remainder of whichever write got
there first.

## Problem

Measured on Cloud, 75 humans + 75 agents + 75 viewers (`docs/perf/daemon-load-baseline.md`):

- Run 14 (Neon 4 CU): the counter `UPDATE` averaged 19.7 ms, max 2.57 s, over 5 414 calls.
- Run 15 (Neon 1 CU, after the roster fix): it averaged **123 ms** at **14 buffers** a call — 24 %
  of all database time, nearly all of it lock wait. `claim` (7.7 s p95), `POST /lanes` (7.1 s) and
  agent `POST /messages` (4.7 s) are the worst routes, and all three hold the counter longest.

The rejected cheap fixes all break 331's invariant: a Postgres `SEQUENCE` leaves a hole on every
rollback; allocating blocks of numbers per transaction breaks commit order, so a puller holding
seq 10 can later see a committed seq 9 — the "absence is indistinguishable from a gap" ambiguity
331 exists to remove.

## Decision

**1. A replicated row is inserted with `origin_seq = 0` and numbered just before its transaction
commits.** `insertMessage` and `appendReplicatedEvent` still set `origin_node` at insert. They
register the row with a per-transaction stamper instead of bumping the counter. Immediately before
COMMIT, the stamper takes the counter once per node — `UPDATE nodes SET next_seq = next_seq + k
WHERE id = ? RETURNING next_seq - k` for the k rows that transaction wrote — and assigns them
`first … first + k − 1` in insertion order. The counter lock is now held for the stamp and the
COMMIT round trip, not for the request.

**2. The invariant holds by the same mechanism as before.** The stamp and the rows are in one
transaction, so a rollback burns no number (gapless). The counter-row lock is still taken inside
the transaction and released only by its COMMIT, so a later-committing transaction always gets
higher numbers (commit order). Nothing outside the transaction can see an unstamped row: Postgres
and SQLite both hide uncommitted rows.

**3. The `Driver` grows one seam: `beforeCommit(fn)`.** On a transaction handle it queues `fn` to run
on the outermost transaction after the body succeeds, before COMMIT. A callback registered inside
a savepoint that rolls back is dropped with it, so a row the savepoint undid is never numbered. On
SQLite the same seam runs the same stamper. One code path serves both engines, and SQLite's
behaviour is unchanged in effect.

**4. `idx_messages_origin` becomes partial, `WHERE origin_seq > 0`,** matching `idx_audit_origin`
(v58). Two unstamped rows in one transaction would otherwise collide on `(origin_node, 0)`. Every
committed replicated row is stamped, so the partial index enforces exactly what the full one did.
Schema v90 rebuilds it on both engines.

**5. A row's `origin_seq` is final only after commit.** Code that reads the number off a row it just
wrote, inside the same transaction, sees 0. The stamper writes the assigned number back onto the
row object it was handed, so a caller that reads it after `tx()` resolves sees the real value.

## Consequences

- **Lock hold shrinks from "rest of the request" to one round trip.** Prediction for the next Cloud
  run: the counter `UPDATE` mean falls from 123 ms to single-digit ms, and the write routes' p95
  falls with it. Falsifier: the mean stays above ~20 ms. That would mean writes are queueing on
  something other than the counter.
- **Every committed replicated row is still stamped.** The stamper runs inside the transaction, and
  a throw there rolls the whole transaction back. There is no committed-but-unstamped state.
- **`origin_seq = 0` now means two things at different times:** "never replicated" for plain audit
  rows (as today), and "not yet stamped" inside an open transaction. Only the first is ever visible
  to another reader.
- **ADR 331's eval case (i), gaplessness under concurrency, is extended** to interleaved
  transactions on Postgres (PGlite in CI). Each one writes several replicated rows, some roll back
  part-way, and the committed numbers must form a gapless prefix in commit order.
- **Not in scope:** sharding the counter, or numbering per member. Either would change what a
  puller can conclude from a gap and would need its own ADR.

## Observability & Evaluation

- **Traces:** `pg_stat_statements` on Cloud. The counter statement keeps its text shape
  (`next_seq + $2`), so runs 14–15 compare directly with the next run. The request log's
  `db_hold_ms` on `claim`, `POST /lanes` and agent `POST /messages` is the per-route view.
- **Eval:** dataset: `store/originStamp.test.ts` on both drivers, six interleaved transactions mixing
  messages and `lane.*` rows, each with a savepoint that rolls back, and one whole transaction that
  rolls back. Baseline: ADR 331's sequential evals (i)–(v), which still pass unchanged. The test
  asserts a gapless 1..N, each transaction's rows consecutive, and the counter at N + 1. The v90 index
  test asserts the index is partial.
- **Experiment:** the next Cloud load run on main at or after this change, compared with run 15
  (Neon 1 CU, same population). Prediction and falsifier are in §Consequences: the counter mean
  falls from 123 ms to single-digit ms, or stays above ~20 ms.
