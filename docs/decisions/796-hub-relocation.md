# 796 — Relocating the hub

- Status: accepted
- Date: 2026-11-03

## Context

ADR 376 made the hub the machine the team was created on, and named relocating it as its own
ceremony (decision 4), deliberately undecided. revive's hub is nick's laptop. When the laptop
sleeps, travels or restarts, joiners cannot claim or fold and the box's seats wait. nick wants the
hub on an always-on box, `musterd-joiner-1`, with nothing visible to anyone using the team.

The design is `docs/superpowers/specs/2026-11-03-hub-relocation-design.md` (approved by nick
2026-11-03, with big-body's credential review folded in). The plan is
`docs/superpowers/plans/2026-11-03-hub-relocation.md`.

Measured 2026-11-03 in the code:

- A daemon is a hub when other nodes hold live credentials (`hasEnrolledJoiners`), and a joiner
  when `node.json` names a hub for the team (`joinerEnrollment`).
- The hub's own events carry its `local_node` id as `origin_node`.
- A fresh joiner folds the hub's `sync_log` from 0; there is no snapshot pull.
- Joiner credentials live on the hub only as sha256 hashes in `nodes`.
- No team-wide wake pause existed. The hold effects were `autorefresh_paused`, `merges_paused` and
  `notice`.

## Problem

There is no way to move the hub without losing data, minting new identities everyone must re-learn,
or running two hubs at once.

## Decision

1. **The hub moves as its file.** The new hub starts from a byte copy of the old hub's
   `musterd.db`, taken after every joiner has drained, with its WAL checkpointed. It inherits the
   hub's `local_node` identity, its `sync_log` and `hub_seq`, and every joiner credential hash, so
   joiners keep their credentials and nothing is renumbered.
2. **The old hub rejoins as a new node.** Its file is renamed aside, never reopened as a hub. It
   enrolls fresh at the new hub with a new invite, so it gets a new node id. No
   `(origin_node, origin_seq)` pair is ever reused: the hub identity continues on the new machine,
   and the old machine's later events carry a new origin.
3. **The new hub's former joiner identity retires.** The box's own joiner node is drained before
   the copy, and its credential is revoked on the new hub. Seats bound to it are re-bound to the
   hub identity, which now runs on the box.
4. **Proof by inventory.** Before and after the copy, every table's row count and a digest over its
   rows in primary-key order are compared. Any mismatch stops the move with the old hub
   untouched. Any row the box's replica holds that the copy does not (outside the ephemeral tables:
   presence, wake leases, footprint, schema meta, sync cursors, pull announcements) is either
   carried by a named rule or is a mismatch.
5. **A new hold effect, `wakes_paused`.** While an active `wakes_paused` hold stands, the wake
   derivation mints no lease: not a human-sent act (ADR 790), not a provisioned first wake, not a
   shift wake, not a dream. A lease minted before the hold runs to its end. The hold never cancels
   one. Like every hold, it is set by a person, capped at 12 hours, and lifted by hand or by expiry
   (ADR 516).
6. **Re-pointing joiners and relabeling the hub node are commands** (`musterd node repoint`,
   `musterd node relabel`), each specified in its own increment. A re-point is refused unless the
   new hub accepts the joiner's existing credential.
7. **The move is a person's act.** It runs on nick's accept of an ask, outside working hours, with
   the security preconditions in the design met first.

ADR 376's two refusals stand. Outside this ceremony, a joiner still cannot mint an invite and a hub
still cannot enroll.

## Consequences

- revive's hub can leave the laptop; the laptop becomes an ordinary joiner and keeps serving
  `localhost:4849`.
- A rollback before re-pointing restarts the old hub on its untouched file. After re-pointing, a
  problem is fixed forward. Going back is the same ceremony run in reverse.
- `wakes_paused` is useful beyond a move (a demo, an incident) and is in the holds vocabulary on
  every surface: `musterd hold set wakes_paused`, `/live`'s holds banner, the CLI help.
- _(2026-11-03)_ `POST /node/repoint` presents this machine's node credential to the address it
  is given, so the security review of lane `01M6HWV7AF12X6T0VVPYSGM0SC` narrowed who may aim it and
  where. A request with an `Origin` header is refused (a browser page cannot call it). The address
  must be `https`, or plain `http` only to loopback or a tailnet address (100.64.0.0/10,
  `*.ts.net`), and may carry no user or password; anything else is refused before the credential
  leaves the machine. The probe refuses redirects. A local process of the same user can already
  read `~/.musterd/node.json`, so the route adds no exposure beyond that.
- _(2026-11-04)_ That last sentence held only for a process that can read the file: a local agent
  seat whose tools cannot read `~/.musterd/` could still call the route (a second security finding,
  forwarded by miley, lane `01M6JDXBKA93QDTCV9Z6NP6S49`). The request now carries
  `node_credential`, which the CLI reads from `node.json` and the daemon compares (timing-safe)
  with the credential it holds, refusing with 403 before any probe. The route now grants nothing
  beyond reading the file. The protocol's `NodeRepointRequestSchema` gains the field.
- Follows-up: lane `01M6HWV4HY93C1FX99KGEZFGMY` (the inventory), lane
  `01M6HWV7AF12X6T0VVPYSGM0SC` (repoint and relabel), lane `01M6HWV9E48ECHG1M77GX5HNDG` (security
  preconditions), lane `01M6HWVB7F56DF6WPPMZT662RP` (rehearsal), lane
  `01M6HWVD5J3APBQJ9PDFT5JDW5` (the switch).
- 2026-11-04 (lane `01M6MG78J7`, fifty): the carry rules, from rehearsal 1's replica-only list.
  Each machine projects the roster under its own ids, so the check now names rows by team slug and
  member name (`NATURAL_KEYS`), and skips the node-local `local_node` and `host_liveness`. Run on
  that day's stores, only three tables still held box-only rows:

  | Box-only rows | Rule |
  | --- | --- |
  | `grants`: 3 standing seat grants (gptbot, mason, resident), issued by nick on the box 2026-10-29 | **Carry.** Copy the rows into the new hub with `team_id` mapped to its team, plus their 3 `grant.issue` audit rows, before the wake pause lifts. The seats' bindings hold the tokens, so the copied hashes keep them working |
  | `agent_bootstrap_credentials`: 1 `legacy` `team-key-compatibility` row | **Not carried.** It is the joiner's compatibility row for the team key, and the copied hub store holds the team's own |
  | `audit`: `residency.wake_exhausted` (39,907), `store.pruned` (83), presence and claim rows (5) | **Not carried.** Node-local operation records. The box's replica file is set aside for history, like the laptop's store |

## Observability & Evaluation

- **Traces:** the hold's `holds` row and its set and lift audit rows; the inventory reports
  (written to the move's backup); the switch's `status_update` to the team with the result and the
  window's length.
- **Eval:** `residency.test.ts` pins that a `wakes_paused` hold leases nothing, even a human steer,
  that a lease minted before it is untouched, and that leases resume once it is lifted.
  `holds.test.ts` pins the effect as enforced. The inventory, repoint and relabel are pinned by
  their own increments.
- **Experiment:** the move itself, rehearsed first. **Falsify:** an inventory mismatch after the
  copy, an event on the new hub whose `(origin_node, origin_seq)` was already used, or the pause
  window exceeding 30 minutes in the rehearsal.
