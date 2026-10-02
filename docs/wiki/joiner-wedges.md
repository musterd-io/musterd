# Joiner wedges

How an enrolled joiner's pushes get refused for good, which daemon decisions a joiner must leave to the hub, and the one recovery that works.

Read off the live wedge on nick's second MacBook Air and three read-only audits of the code, 2026-10-02
(lane `01M3YZ0AY0`). The decisions are [ADR 358](../decisions/358-human-seat-trusts-a-set-of-machines.md)
and [ADR 360](../decisions/360-push-level-residence.md) (residence),
[ADR 361](../decisions/361-every-ownership-edge-is-the-hubs.md) (ownership and state edges are the
hub's), [ADR 371](../decisions/371-the-record-kind-and-the-rest-of-the-ledger.md) §2 (the incident
pool is the hub's) and [ADR 376](../decisions/376-the-hub-is-the-machine-the-team-was-created-on.md)
(one hub). Enrolment is [node enrollment](node-enrollment.md), the push loop is
[sync push](sync-push.md), and the runbook is the [second-machine guide](../guides/second-machine.md).

## How one refused event wedges the whole machine

The hub resolves every pushed event's actor (a message's `from`, an audit row's `actor`) on its own
roster before the replay and gap checks (`packages/server/src/sync/log.ts`, `ingestBatch`). A seat that is
not a service seat and is bound to a different node refuses the **whole batch**, `403 bound_elsewhere`.
Exempt: a null actor, an actor not on the hub roster, service seats, and the hub's own loopback pushes.
`policy`, `seed` and `record.incident_report` events are refused outright from any other push
(`403 forbidden`, with no seat in the body, so they never show as `sync.wedged`).

- The refusal rolls the batch back, bindings made earlier in it included, and the cursor stays. The
  pusher takes the next 500 rows after the cursor, oldest first, every 60 s, with no backoff and no
  exit — so one refused row anywhere in that window blocks everything behind it. Measured on
  Air 2 on 2026-10-02: 11 `lane.review_rerouted` rows as four hub-resident seats, refused every tick;
  falsify: on any wedged joiner, `SELECT refused_json FROM sync_push_cursor` names a seat whose
  `seat_nodes` row on the hub is a different node.
- The joiner records only the first refusal. Fixing that seat reveals the next one.
- An agent seat has exactly one node; a human seat has a set (ADR 358). The first writer binds an
  unbound seat, so an unrelated machine speaking first can take a seat.

## What a joiner must leave to the hub

An enrolled joiner holds a **replica**: partial mid-drain, stale after a sleep, blind to every seat that
lives on another machine. A daemon that decides things about the whole team from it writes hub-owned
lane state, or sends messages *as* seats bound to the hub, and the hub refuses them for good. Every one
of these is guarded per team with `joinerEnrollment(db, teamId, slug)` (a daemon can be the hub of one
team and a joiner of another; ADR 376 rejected a replicated hub flag, so a new loop is unguarded until
someone adds the guard):

| Decision | Where | Status |
| --- | --- | --- |
| re-route an acceptance whose reviewer was reaped | `protocol/laneReroute.ts` | guarded, #1976 |
| route an incident nobody claimed (and tell the new owner AS a reporter) | `store/incidents.ts`, `protocol/route.ts` | guarded, #1978 |
| the ADR 229 backstop that closes abandoned acceptances | `store/laneSweep.ts` | guarded, #1978 |
| release a lane a departed seat still owns | `store/lanes.ts` | guarded, #1978 |
| poll the seeds relay and stamp `seed.captured` | `seeds/ingest.ts` | **open**, lane `01M3ZBTDJ5` |
| prune stamped churn the hub has not acked | `store/retention.ts` | **open**, lane `01M3ZBT9VY` |
| roster-removal release as `musterd`, ambient touch adopting a folded remote row, a gated human ask composed on a joiner | `store/members.ts`, `store/presence.ts`, `protocol/route.ts` | **open**, lane `01M3ZBTJKD` |

Why "this seat looks gone" means nothing on a joiner: a hub seat's liveness there is the node's last
pull (live within 165 s), presence replicates as transitions never snapshots (ADR 384), and folded
lanes carry the origin's timestamps, so any age-based sweep sees a replayed lane as ancient. Absence has
three indistinguishable causes — not folded yet, deleted by the TTL, simply not resident.

## What does not fix a wedge

All read from the code on 2026-10-02, none reproduced:

- **Deleting the poisoned rows.** The hub needs a dense `origin_seq` per node; a hole is `409` for good
  (the pusher then oscillates its cursor and logs only `sync_push_gap`, never `sync.wedged`). The 5-day
  churn prune does this on its own to an unpushed tail (lane `01M3ZBT9VY`); falsify: a joiner offline
  for six days with unpushed `presence.attached` rows still pushes cleanly afterwards.
- **`musterd node unbind <seat>`** on the hub. It clears the seat's whole set; the first node to speak
  re-binds it, so it races the hub's own writes, and the rows the joiner then lands become hub history
  (a `lane.review_rerouted` marks the hub's live acceptance ask superseded).
- **`musterd node trust`.** It is for human seats; an agent seat is refused `forbidden`.
- **`musterd node revoke`** cuts the node off but clears nothing, and a revoked id can never enrol
  again: the hub refuses any id it already knows, and the id lives in the joiner's DB (`local_node`).
- **`musterd node rotate`** keeps the id and swaps the credential only.

## The recovery that works

Reset the machine so it gets a new node id: revoke the old node on the hub, run
`bootstrap.sh reset --yes` on the joiner (it keeps the build and the roster clone and moves the rest
aside), mint a new invite, enrol, and `musterd node trust` the new node. The revoked node stays in
`node list` as `revoked` forever and the human's node set keeps its id; both are inert (there is no
per-node unbind). Details and the exact commands: [the guide](../guides/second-machine.md).

Triage on a suspect joiner, read-only:

```sql
SELECT actor, action, COUNT(*) FROM audit
 WHERE origin_node = (SELECT node_id FROM local_node)
   AND origin_seq > (SELECT last_seq FROM sync_push_cursor)
 GROUP BY 1, 2;
```

Any row whose `actor` is a seat that lives on another machine is the poison. Also look for holes in
`origin_seq` across `messages` and `audit` for the local node, and for `sync_push_gap` in the daemon
log.
