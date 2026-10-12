# 552 — The hub doorbell: the hub pokes a joiner over a WebSocket the joiner opens

- Status: proposed
- Date: 2026-10-08
- Deciders: nick ("work on the cross machine hub stuff… real time / multiplayer, think google docs or figma", "one step at a time and then remeasure each step", 2026-10-08; "lets just do websocket now", 2026-10-12)
- Lane: `01M4EEQD6G9KNHQ9J9ANXR7RBM` (goal `realtime-sync`, step 3 of 4)
- Builds on: ADR 325 (federation: one hub arbitrates order), ADR 335 (the sync wire format), ADR 328
  (the machine credential that admits `/sync/pull`), ADR 443 (the doorbell: a poke is a wake, never the data)

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

### 1. A joiner opens one WebSocket to its hub: `GET /teams/:slug/sync/stream`

The upgrade authenticates exactly as `/sync/pull` does: `authenticateNode(db, team.id, bearer(req))`
with the `msnode_` machine credential in the `Authorization` header, then `touchNode`. Anything else is
refused before the upgrade completes. It reuses the daemon's existing `ws` server (already a
dependency: no new one, hard rule 6) and its Origin/Host gate (ADR 040); `attachWsServer` today
destroys every upgrade that is not `/ws`, so the stream path is a second accepted pathname, not a
second server. The seat WebSocket at `/ws` is untouched.

**Who opens it:** every enrolled daemon that is not the hub: the same daemons that run `startSyncPull`
against a hub URL today. The hub opens nothing. It is hub-and-spoke: no joiner-to-joiner socket, and a
team with no joiners (a hub alone, and `cloud`, where `loopsFor` excludes sync) opens none.

### 2. Frames: a poke, not the data

Both directions are JSON, schema-validated at the boundary (hard rule 4) in `@musterd/protocol`
`sync.ts` as `SyncStreamFrameSchema`: `{type:'head', seq}` (hub → joiner: "the log is at `seq`") and
`{type:'ping'}` / `{type:'pong'}` (liveness). A frame the schema rejects is dropped with a `warn`; the
socket stays up. A poke carries no events. On `head`, the joiner runs the pull it already has,
`GET /sync/pull?after=<cursor>`, unchanged, so the fold, the cursor, the `409` re-anchor, node liveness
and the pre-genesis adoption keep one implementation. A `head` whose `seq` is at or below the joiner's
cursor triggers nothing, and pokes that arrive while a pull is running coalesce into one more pull.

### 3. The hub rings from one place

`ingestBatch` is the only writer of `sync_log`. After a batch commits with `accepted > 0` it calls
`ringStreams(db, teamId)`, which sends `head` with the new `sync_log` head to every open stream for that
team. Streams live in a per-database in-memory registry, never in the database; a restart drops them
and each joiner reconnects. `createServer().close()` closes them all first, so a held socket never
delays a graceful shutdown.

### 4. The 60 s tick is the floor, not the mechanism

`startSyncPull` keeps its timer and its drain loop. The stream only adds an earlier trigger, so a hub
that predates this ADR (it answers the upgrade with 404), a proxy that refuses upgrades, or a joiner
that cannot connect all degrade to today's behaviour with no flag. The joiner reconnects with
exponential backoff (1 s doubling to 30 s, with jitter) and logs `sync_stream_down` once per outage.
The hub pings every 20 s and drops a stream that has not answered in 45 s, so a laptop that slept does
not leave a ghost registered; the joiner treats a missed ping the same way and reconnects.

### 5. Outbound frames are reserved, not built

The socket is duplex so that step 4 (lane and presence writes riding the push timer) can send
`{type:'push'}` over it. This ADR defines no joiner → hub data frame. The one joiner → hub frame is
`pong`. Step 4 amends the frame schema in its own ADR.

### 6. What does not change

The fold, the cursor, the `409` re-anchor, node liveness riding the page, the pre-genesis lane adoption
and the machine credential are untouched. A socket upgrade stamps the node alive on arrival; a pong does
not (a pong proves the socket, not the node's work: the next pull does).

## Consequences

- Hub → joiner latency becomes one `head` frame plus one pull plus the fold. The wire step is
  sub-millisecond on a LAN; the pull and fold dominate (≈300 ms measured at step 2a), which is why this
  ADR does not put events in the frame: a poke keeps one fold path.
- Per-event cost on the hub is N tiny frames, then N authenticated page reads, one per joiner.
  The hub was measured saturated on 2026-10-12 (`/sync/pull` 4–8 s per call, wallow's lane
  `01M4RNPQD0`). A page read per joiner per event is the cost to watch, and the measurement below
  records it. Pushing the staged slice in the frame (one serialisation, no per-joiner read) is the
  next lever, taken only if the measurement shows the pull dominating.
- One idle socket per joiner per team on the hub; at single-digit machines this is negligible.
- A stream-hostile proxy costs only latency: the upgrade fails, the tick carries on.
- `SPEC.md` is unaffected: `/sync/*` is daemon-to-daemon, outside the normative protocol (ADR 325).
  `03-server.md` gains the stream (`02-protocol.md` carries no `/sync/*` section); `SyncStreamFrameSchema` is a protocol-package
  schema addition and this ADR is its gate (hard rule 1).
- Measured 2026-10-12 on two real daemons (the `push.test.ts` harness), hub send → live `deliver` frame
  on a joiner seat, five runs: 324, 329, 336, 347, 358 ms (median 336 ms), 60 s tick still enabled.
  Hub CPU per event at 1 and 3 joiners is not yet recorded; the eval above still owes it.
- Superseded within this ADR before acceptance: the first draft chose a long-poll
  (`GET /sync/pull?wait=S`). It was dropped on 2026-10-12 because step 4 needs a duplex channel and the
  `ws` server already exists; `ringStreams` is the same single ring point that design used.

## Observability & Evaluation

- **Traces:** hub `sync_stream_open` / `sync_stream_close` (info; team, node, `reason`: `ping_timeout`
  for a reaped stream) and `sync_stream_refused` (warn). Joiner `sync_stream_up`, and
  `sync_stream_down` (warn, once per outage). A poke is not logged per event: the daemon has no debug
  level, and `sync_pulled` already records the pull a poke causes.
- **Eval:** two real daemons (the `push.test.ts` harness), a seat connected on the **joiner**, a send on
  the **hub**, time to the `deliver` frame on the joiner. Baseline: up to 60 s (the timer, as steps
  1–2 were measured). Accepted if the median over 5 runs is under 2 s with the 60 s tick still
  enabled. Second falsifier: against a hub that answers the upgrade with 404 the joiner still
  delivers within one tick and retries the upgrade no faster than the backoff. Third: an open stream
  does not delay `close()` (`shutdown.test.ts` shape). Fourth: a joiner whose socket is killed
  mid-run reconnects and the next send still arrives. The run records hub CPU per event at 1 and 3
  joiners so the fan-out cost is a number, not a guess.
- **Experiment:** none beyond the above: a latency fix with a hard before/after number. **Reopens if**
  the fan-out measurement shows the per-joiner page read dominating hub load (then the frame carries
  the slice), or a topology we must support refuses WebSocket upgrades (then a long-poll fallback gets
  its own ADR).
