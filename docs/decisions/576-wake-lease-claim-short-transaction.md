# 576 — The wake-lease claim derives outside the transaction and writes in a short one

- Status: proposed
- Date: 2026-10-12
- Deciders: nick, wallow
- Lane: `01M4SDYXKC1X36W3SXBFK1YTAB`
- Supersedes: [ADR 131](131-harness-residency-wake-ledger-host.md) §4, the clause "in one
  transaction the daemon derives due wakes, inserts a lease per grant, and returns the orders"
  only. The guarantee that clause was there for — no seat is ever double-spawned — stands, and is
  made stronger. Rate policy stays derived, as ADR 131 §4 decided.

## Context

`POST /teams/:team/residency/wake-leases` runs `claimWakeLeases` (`store/residency.ts`) as one
`db.tx`. For every seat enrolled on the polling host it reads presence, the live lease, the
deferral snooze, the rate counters, the due candidates (the directed ledger, work orders, the
ADR 434 horizon and spent-act checks, the ADR 262/306 edge breakers) and the dream gates, and then
inserts at most one lease per seat. On the hub that is about 800 awaited statements per poll.

The SQLite driver runs one transaction at a time, and a statement outside a transaction waits for
the one in progress (`sqliteDriver.ts`, the `tail` queue). Every `await` inside the transaction
yields to the event loop, so the poll's hold time is its own statements plus whatever other work
the loop runs in between, while every other write on the daemon queues behind it.

Measured on the hub, 2026-10-12 (`sqlite_tx_slow`, the instrumentation from #2423): holds of
1.0 to 2.2 s under load with `wait_ms` 0, all at `claimWakeLeases`; the most recent, after the
deploy of 71fe157, held 1,079 ms. The Air's 5 s calls had a different cause, the ledger lookups
fixed by #2440 (lane 01M4S0ZAG8); this is what remains on a large team.

## Problem

1. **The poll stalls every writer on the daemon.** A second-long hold on a shared daemon delays
   every send, claim and lane update that arrives during it, by up to the same second.
2. **Most of the transaction is reads that need no transaction.** Of the work above, the only
   writes are the lease insert, its `residency.wake_leased` audit row, the provisioned-wake mark
   (`host_provisions.first_wake_at`) and the `residency.wake_exhausted` audit rows. Everything
   else derives rate and eligibility from stores that ADR 131 §4 already accepts as derived.
3. **The one-transaction rule does not give the guarantee everywhere.** On SQLite, double-spawn is
   prevented because the driver serialises transactions, not because the derivation sits inside
   one. On Postgres (`pgDriver.ts`, plain `BEGIN`, read committed) two concurrent polls can both
   read "no live lease" for a seat and both insert. Nothing in the schema stops it:
   `wake_leases` has indexes on `(member_id, status)` and `(team_id, status)`, neither unique.

## Decision

1. **Derive outside the transaction.** `claimWakeLeases` first works out, for each enrolled seat,
   the plan it would act on — a provisioned first wake, the ordered candidates that passed every
   gate, a dream, or nothing — using plain reads on `db`, with no writes. The gate logic and its
   order are unchanged.
2. **Write each seat in its own short transaction, after a recheck.** For a seat with a plan, one
   `db.tx` rechecks the stored facts the plan depends on and only then writes:
   - no live lease for the seat (`liveLease`), and no live presence;
   - for a provisioned wake, the mark is taken with
     `UPDATE … SET first_wake_at = ? WHERE id = ? AND first_wake_at IS NULL`, and the wake is
     dropped if it changed no row;
   - a `residency.wake_exhausted` row is written only if `isExhausted` is still false.

   Rate counters (`wakesSince`, `attemptsForAct`, the edge counts) are not rechecked. They change
   only when a host reports or the reaper expires a lease, and either one needs a lease for this
   seat, which the recheck above has just ruled out; at worst a report that lands mid-poll is
   counted on the next poll, which is the staleness ADR 131 §4 already accepts for derived rate.
   A seat whose recheck fails gets no order this poll and is derived again on the next.
3. **The stored constraint is the guarantee.** A migration adds a partial unique index,
   `CREATE UNIQUE INDEX idx_wake_leases_one_live ON wake_leases(member_id) WHERE status = 'leased'`,
   on SQLite and Postgres alike. The insert in decision 2 uses `ON CONFLICT DO NOTHING` and drops
   the seat's order if no row was inserted. A lease past its expiry but not yet reaped still holds
   the slot until the reaper's next pass marks it `expired`, which delays that seat's next wake by
   at most one reaper interval; it never allows two.

## Consequences

- The poll's transaction hold falls from the whole derivation to the writes for one seat: a
  handful of statements, typically a few milliseconds.
- Double-spawn is prevented by the schema on both drivers, not by the SQLite queue. That closes
  the Postgres race in Problem 3, which existed before this change.
- The derivation sees no single snapshot across seats. That is safe because each seat's plan
  depends only on that seat's rows and team-wide settings, and the per-seat recheck covers the
  rows that matter for exclusion.
- The migration fails if a store already holds two `leased` rows for one member. Before it creates
  the index it marks every such row but the newest `expired`; the reaper's `wake_failed` path never
  sees those, so the rows are recorded by one `residency.lease_deduped` audit row each.
- ADR 131 §4's claim that "two hosts, a crash mid-spawn, or a re-poll race can never double-spawn
  a seat" held on SQLite and did not hold on Postgres; the ledger entry is
  `docs/claims/entries/2026-10-12-one-transaction-prevents-double-spawn.md`. No double spawn has
  been observed: the hub's store, the largest, holds no member with two `leased` rows.

## Observability & Evaluation

**Traces** — n/a: no new span. `sqlite_tx_slow` (`hold_ms`, `at`) and the `db_hold_ms` /
`db_wait_ms` fields on slow `http_request` lines already show the poll's hold and what queued
behind it.

**Eval** — after deploy, 30 minutes of the hub's `daemon.log` under normal load: no
`sqlite_tx_slow` line whose `at` is `claimWakeLeases`, and wake-leases `http_request` p50 no
worse than before. Tests on both drivers: a second `leased` row for one member is refused by the
index, and two `claimWakeLeases` calls started together for one seat return one order between
them. PGlite serialises its single connection like SQLite does, so the first test, not the
second, is what covers the Postgres race.

**Experiment** — the falsifier for decision 2: a seat spawned twice for one act inside one lease
TTL. Count `residency.wake_leased` rows per (member, act) whose `created_at` fall within
`WAKE_LEASE_TTL_MS` of each other, in the 30 days after this ships. Any such pair means the
recheck or the index missed a case, and the claim goes back to one transaction until it is found.
