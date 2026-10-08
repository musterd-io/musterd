# 552 — The hub doorbell: a joiner's pull waits at the hub instead of polling

- Status: proposed
- Date: 2026-10-08
- Deciders: nick ("work on the cross machine hub stuff… real time / multiplayer, think google docs or figma", "one step at a time and then remeasure each step", 2026-10-08)
- Lane: `01M4EEQD6G9KNHQ9J9ANXR7RBM` (goal `realtime-sync`, step 3 of 4)
- Builds on: ADR 325 (federation: one hub arbitrates order), ADR 335 (the sync wire format), ADR 328
  (the machine credential that admits `/sync/pull`)

## Context

Cross-machine latency was two 60 s polls in series. Steps 1, 2a and 2b of the `realtime-sync` goal
removed the joiner→hub direction (all measured on two real daemons, 2026-10-08):

| Step | Change | Before | After |
| --- | --- | --- | --- |
| 1 (#2219) | a local send kicks the push loop | send → hub `sync_log`: 60 104 ms | 209 ms |
| 2a (#2222) | the hub folds as `/sync/push` lands | send → hub `messages`: 60 051 ms | 360 ms |
| 2b (#2230) | a fold pushes to open sockets | send → live frame on a hub seat: none in 20 s | 317 ms |

Those steps left the hub→joiner direction as it was. A joiner learns what the hub holds by `GET /sync/pull?after=N`
on a 60 s timer (`SYNC_PULL_INTERVAL_MS`). A page that comes back full is followed at once, but an
idle poll waits the full minute, so an act made on the hub — or on a third machine and pushed there —
reaches this laptop's seats up to 60 s late.

## Problem

The hub is the only machine with the answer to "is there anything new for me?", and the joiner can
only ask. Shortening the timer trades latency for load linearly (a 1 s timer is 60× the idle requests
per joiner, each a full authenticated page read with node-liveness and seat bindings) and still
leaves up to a second of lag. The hub cannot call the joiner: joiners are outbound-only, behind NAT,
often asleep (`deployment-topology.md`: the daemon is the only listener).

## Decision

### 1. `GET /sync/pull` takes `wait`: hold the request until the head moves

`GET /teams/:slug/sync/pull?after=N&wait=S` answers **immediately** when the hub holds events past
`N` — exactly today's response. When it holds none, the hub keeps the request open for up to `S`
seconds (capped at `SYNC_PULL_MAX_WAIT_S = 25`) and answers the moment `ingestBatch` stages an event
for that team, or at the cap with the same empty page it returns today. No new route, no new frame,
no new event shape: the response is `SyncPullResponseSchema` unchanged, so a joiner that omits `wait`
(every released build) behaves exactly as before, and a hub that ignores an unknown `wait` (every
released hub) answers at once — the joiner's loop must therefore not treat a fast empty answer as a
reason to hammer: see §3.

This is a long-poll, not a WebSocket or SSE stream. It reuses the one authenticated read the fold is
already built on, needs no dependency (hard rule 6), passes proxies and the cloud edge that buffer
streams, and has nothing to reconnect: a dropped request is just the next request.

### 2. The hub rings waiters from one place

`ingestBatch` is the only writer of `sync_log` (the hub's own sends reach it by loopback push, which
step 1 made immediate). After a batch commits with `accepted > 0`, it calls
`ringPullWaiters(db, teamId)`, which resolves every request parked for that team. Waiters live in a
per-database in-memory registry, never in the database: a restart drops them and the joiner's next
request simply parks again. `createServer().close()` resolves them all, so a held request never
delays a graceful shutdown.

### 3. The joiner follows; the 60 s tick is the floor, not the mechanism

After a drain that ends on an empty page the joiner issues the next pull with `wait=25` and, when it
returns, drains again — a per-team loop in `startSyncPull`, alongside the existing tick, which stays
as the fallback and as the only driver against a hub that ignores `wait`. The loop guards the
unknown-`wait` case: if a waited request returns empty in under `SYNC_PULL_MIN_HOLD_MS` (2 s), the
joiner stops following that hub until the next tick (a hub that answers instantly is not holding).
The request timeout is `wait + PULL_TIMEOUT_MS` so a held request is not mistaken for an unreachable
hub. Offline stays the expected state: a failed request logs at `warn` once and backs off to the tick.

### 4. What does not change

The fold, the cursor, the `409` re-anchor, node liveness riding the page, the pre-genesis lane
adoption, and the machine credential are untouched. A held request still authenticates and
`touchNode`s on arrival; it does not re-`touchNode` while parked (a parked request is not evidence the
node is alive past its arrival — the next request is).

## Consequences

- Hub→joiner latency becomes one round trip plus the fold: expected ≈ 300–400 ms on a LAN, measured
  below. The remaining 60 s costs — lane and presence writes riding the push timer — are step 4.
- One parked request per enrolled joiner per team on the hub: a Node socket and a promise, no
  database read while idle. At the team sizes federation targets (single digits of machines) this is
  negligible; `cloud` has no joiners (`loopsFor` excludes sync), so it is unaffected.
- A hub behind a proxy with a read timeout under 25 s answers its own `504`; the joiner treats any
  non-2xx as "retry on the tick", which is today's behaviour. `SYNC_PULL_MAX_WAIT_S` is the knob.
- `SPEC.md` is unaffected: `/sync/*` is daemon-to-daemon, outside the normative protocol
  (ADR 325). `02-protocol.md`'s sync section and `03-server.md` gain the `wait` parameter.

## Observability & Evaluation

- **Traces:** `sync_pull_held` (debug; team, `waited_ms`, `rang` or `timeout`) on the hub per parked
  request. The joiner's `sync_pulled` / `sync_drained` lines are unchanged; a joiner that stops
  following a hub that does not hold logs `sync_pull_wait_unsupported` once.
- **Eval:** the measurement this ADR is accepted on — two real daemons (the `push.test.ts` harness),
  a seat connected on the **joiner**, a send on the **hub**, time to the `deliver` frame on the
  joiner. Baseline: up to 60 s (the timer, as steps 1–2 were measured). Accepted if the median over
  5 runs is under 2 s with the 60 s tick still enabled. Second falsifier: the same test against a hub
  stub that ignores `wait` still delivers within one tick and issues no more than one request per
  `SYNC_PULL_MIN_HOLD_MS`. Third: a held request does not delay `close()` (`shutdown.test.ts` shape).
- **Experiment:** none beyond the above — a latency fix with a hard before/after number, not a
  behaviour change a trial would inform. **Reopens if** a hub topology we must support sits behind a
  stream-hostile proxy with a read timeout under 25 s: then `wait` shrinks, or this becomes SSE with
  its own ADR.
