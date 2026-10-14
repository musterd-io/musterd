# 507 — On Postgres, a request leases one pooled client and runs every statement on it

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (asked for the one-per-request fix after load run 9, 2026-10-05), fifty (lane
  `01M3Z455NEWNZMCJ5KR6EX3TG0`)
- Amends: [ADR 486](486-pg-driver-dependency.md) — *where* a statement's client comes from; the
  stamped-transaction choreography is unchanged
- Relates to: [ADR 479](479-two-store-backends.md) (the Driver), [ADR 504](504-origin-seq-at-commit.md)
  (the lever this replaces), [docs/perf/daemon-load-baseline.md](../perf/daemon-load-baseline.md)

## Context

The pg driver runs every statement as its own stamped transaction on a client it checks out of the
pool and returns: `get`, `all`, `run` and each `tx` all call `pool.connect()`. Cloud load run 9
(2026-10-05, b291774a) logged per request the transactions opened and the time spent waiting for a
client (`db_tx`, `db_wait_ms`, #2063):

| Route | Requests | tx / request | Pool wait, summed |
| --- | --- | --- | --- |
| `GET /teams/:t` (roster) | 21 364 | 15 | 26 382 s |
| `GET …/inbox/interrupt-check` | 13 215 | 13 | 12 147 s |
| `POST /mcp` | 2 473 | 13 (max 162) | 10 589 s |
| agent `POST /messages` | 524 | 165 | 6 551 s |

About 870 000 checkouts in 21 minutes, all queueing for the same 40 clients. A slow `POST /lanes`
(p95 20.5 s) spent 14.5 s waiting for clients, 6.0 s holding them and 2.1 s in queries — and every
one of its 168 statements re-joined the back of the queue. Postgres held no transaction past 0.18 s
(run 7's lock sampler) and the server's main thread was half idle (run 8's CPU sampling): the queue
is the pool, and its length is the number of checkouts.

## Problem

Make a request's statements stop competing with every other request's, one checkout at a time,
without changing what a statement means.

## Decision

1. **A request leases one client per pool it touches.** The HTTP handler opens a request scope
   (the `AsyncLocalStorage` record `db/requestTiming.ts` already carries). The first statement on a
   pool (app or operator role) inside that scope checks a client out; every later statement on that
   pool in the same request reuses it. The scope's end — the response's `finish` or `close` — returns
   the clients.
2. **Each statement is still its own stamped transaction.** _(Amended 2026-10-13: consecutive reads of one scope on a lease now share one — [ADR 589](589-pg-reads-share-a-lease-transaction.md).)_ On the leased client, a bare statement
   is the same `BEGIN; SET LOCAL ROLE …; set_config(…)` / statement / `COMMIT` as today, and a `tx`
   body is the same one transaction. A failed statement rolls back only itself; a write commits when
   its statement or `tx` does, visible to other requests at once. Tenant scope stays per statement
   (`SET LOCAL`), so a request touching two teams on one client is as safe as two checkouts.
3. **The lease serialises its own work.** A request may run statements concurrently
   (`Promise.all`). The lease is a queue: a statement or a whole `tx` takes it, runs, and gives it
   back, so a bare statement can never land inside another branch's open transaction.
4. **Outside a request nothing changes.** Loops, sweeps, the WebSocket frame handlers and work a
   request defers past its response (a notification's `.then`) find no live scope and check out per
   statement as today. A deferred continuation that starts after the scope ended must not reuse a
   released client: the scope records `ended`, and an ended scope means "no lease".
5. **A lease idles out and ages out.** A lease that runs no work for 250 ms gives its client back,
   so a request that leased and then stalled — a slow client, a stream waiting on nothing — holds a
   client for at most that long, and open-but-idle requests cannot drain the pool. Separately, once a lease is older than 1 s, its client goes back to the pool after the
   transaction that crossed the line, and the request's next statement leases afresh. A
   long-lived response (an MCP stream) therefore never pins a client; run 9's median request held
   its clients ~0.3 s, so ordinary requests never reach the cap.
6. **A broken client ends the lease.** If a statement fails as `unavailable` (connection lost), the
   client is released with the error and the next statement in the request checks out afresh.

## Consequences

- Checkouts fall from one per statement to one per request per pool: run 9's ~870 000 becomes
  roughly the request count (~50 000). The pool queue should mostly disappear; measured in the next
  §8.1 run.
- A request holds its client for its whole duration, idle time included, so a slow non-database
  await inside a request (a JWKS fetch, an outbound call) now holds a client. Run 9's median request
  held its clients ~0.3 s; the risk is the long tail, read from `db_hold_ms`.
- The pool must be at least the number of concurrent requests that touch the store, or requests
  wait for a lease instead of per statement. `MUSTERD_PG_POOL_SIZE` (#2026) stays the knob.
- Rejected: **one transaction per request** — one caught statement error (an expected unique
  violation) would abort every later statement in the request, writes would stay invisible to other
  requests until the response, and a long request would hold row locks for its whole life.
  **Raising the pool alone** — run 5b took the pool from 10 to 40 and p95 from 14 s to 2.8 s, but
  the checkout count is unchanged and Neon's connection cap bounds it.

- 2026-10-13: [ADR 589](589-pg-reads-share-a-lease-transaction.md) narrows decision 2 for reads.
  With no request waiting on the pool any more (run 39: `db_wait_ms` 0 at p95), the cost this ADR
  moved off the queue had become three round trips per statement. Consecutive `SELECT`s of one scope
  on a lease now run in one open transaction; writes and `tx` bodies keep decision 2 unchanged.

## Observability & Evaluation

**Traces.** n/a — no new span kinds. `db_tx`, `db_wait_ms`, `db_hold_ms` and `db_query_ms` on the
`http_request` line (#2063) are the measure; `db_wait_ms` becomes the wait for the lease's first
checkout.

**Eval.** Success is: the next §8.1 run's summed `db_wait_ms` falls by an order of magnitude from
run 9's ~67 000 s, and p95 falls from 10.9 s toward 1 s. The pg driver's choreography tests prove
reuse, serialisation, the ended-scope fallback and the broken-client release.

**Experiment.** Falsifier: summed pool wait falls but p95 does not — then the queue moved to the
leases (pool smaller than concurrent requests) or to the per-recipient fan-out (lane
`01M4563RDYDBMGP6SSH6YATQ1G`), and this ADR's Context is incomplete.
