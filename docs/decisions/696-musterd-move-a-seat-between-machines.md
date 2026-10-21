# 696 — `musterd move`: one command moves a seat between machines

- Status: accepted
- Date: 2026-10-21
- Lane: `01M5G22C7NEA4T3R9R4SSZE09M`
- Deciders: nick (in chat, 2026-10-21: "make an easy, intuitive path to migrate musterd seats (human
  and agent) across machines (actual computers or vm/cloud)"; skipped the design questions, so the
  shape below is wallow's call), wallow
- Relates to: [ADR 328](328-machine-credential.md) §4 (residence binding, the admin unbind),
  [ADR 358](358-human-seat-trusts-a-set-of-machines.md) (a human's set; agents stay one-node),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (residency), [ADR 463](463-sponsor-hosted-agents.md) §3
  (a host stands a seat up), [ADR 366](366-seat-continuity-replicates-with-the-note.md) (memory
  follows the seat), [ADR 422](422-hub-relocation-ceremony.md) (the hub's own move — not this)

## Context

nick runs agents for team `revive` on two laptops, `mac.lan` (the hub) and `macbook-air-2.lan` (an
enrolled joiner), and asked wallow, a seat on the hub, to move itself to the Air. It could not.
The path that exists is `docs/guides/second-machine.md` "Moving a seat":

1. on the hub, as an admin: `musterd residency off --seat X`, then `musterd node unbind X`;
2. on the joiner: `bash ~/bootstrap.sh seat X <harness>`, then `musterd X`.

That is four commands on two machines, and two of them only a human admin can run. A script copied
off-repo carries the destination half, and the old session is never told that it is moving.
Two other problems make it worse:

- **A race between the two halves.** `node unbind` leaves the seat with no binding. ADR 328 §4 binds
  an unbound seat to whichever node speaks for it first. If the old session is still running when
  its daemon next pushes, the seat binds straight back to the machine you are leaving. This is the
  unbind race in `docs/wiki/joiner-wedges.md`.
- **A dead path in the docs.** `musterd claim <name> --token <code>` is still printed by `musterd
  help claim` and the musterd skill as the way to "adopt" a seat. The flag was dropped at the ADR 075
  credential cutover, and `claim` now refuses it.

## Problem

Moving a seat should take one command, run on either machine, by whoever is moving it: a person at
the new machine, an admin, or the seat itself. It must keep ADR 042's rule that one agent never runs
live in two places. It must leave the old session a chance to push its work. It must work when the
target is a VM or cloud machine that nobody is sitting at.

## Decision

### 1. The verb

```
musterd move <seat>                 # bring <seat> to THIS machine
musterd move <seat> --to <machine>  # send <seat> to an enrolled machine (its label, as `musterd node list` / residency show it)
            [--now] [--wait <dur>] [--clone] [--harness <id>] [--dry-run]
```

`move` with no `--to` is run at the destination. `--to` can be run from anywhere, including from the
seat's own session ("wallow, move to the Air" is wallow running `musterd move wallow --to
macbook-air-2.lan`). `<machine>` resolves on the hub against the team's unrevoked nodes, by label,
then by node id. An ambiguous or unknown name is refused with the list.

### 2. One hub act re-binds the seat — no unbound window

`POST /teams/:slug/seats/:name/move` `{ to_node }` is decided on the hub, in one transaction. A
joiner forwards it under its machine credential as `POST /teams/:slug/sync/move` `{ seat, to_node,
by }`, which is ADR 358's trust shape. The transaction does three things:

- **Re-binds the seat.**
  - An agent seat's `seat_nodes` set is replaced by `{to_node}`.
  - A human seat's set gains `to_node` (ADR 358: a person may be on several machines). With
    `--only`, the human's set is replaced instead.
- **Revokes the seat's residency row, if it has one** (`revokeResidency`). The old host stops
  getting wake leases for the seat from that moment. The response returns the revoked row's
  harness and policy overrides, so the destination can re-enroll with the same settings.
- **Writes the audit row** `seat.moved` (allow) `{ from: [node…], to, by, residency }`.

Because the old binding is replaced and never cleared, there is no unbound window: the old node's
next push for the seat is refused with `bound_elsewhere` (ADR 328 §4), and the race above cannot
happen.

Who may move a seat (authority):

| Mover                       | May move                                                                          |
| --------------------------- | --------------------------------------------------------------------------------- |
| a team admin                | any agent seat                                                                    |
| the seat's sponsor (ADR 463) | the agents they sponsor                                                          |
| the agent seat itself       | itself, and only with `--to`                                                      |
| a human                     | only their own seat, and only when spoken from a node already in their set (ADR 358 §2's rule, unchanged) |

Anyone else gets `forbidden`. An admin **cannot** move another human's seat. ADR 358 deliberately
made which machine is asking part of the decision, and an admin credential presented from a fresh
machine must not get around it.

### 3. The old session is told, then given a short time to finish

If the seat has live presence when `move` runs, the CLI first sends the seat a `steer`, in its own
thread:

> moving you to `<machine>`: push your branch and save your seat memory, then reply `accept`

Then it waits up to `--wait` (default 5 m) for an `accept` in that thread before calling the hub.
`--now` skips the wait. On timeout the move goes ahead, and the CLI names the seat's claimed lanes
whose branches are not on `origin`, because those changes stay on the old machine. When the seat is
moving itself, there is no steer: the session running `move` is the old session. The CLI prints
that this session should end once the move lands.

The old session ends the existing way. Its daemon's pushes for the seat are refused as
`bound_elsewhere`. When the new session claims from the destination, the cross-workspace supersede
in `ws.ts` closes the old one.

### 4. The destination half

The destination half is one function, `arriveSeat(seat, residency)`. It runs on the destination
machine either way:

- **Without `--to`:** the CLI runs it in place, after the hub act.
- **With `--to`:** the target's `musterd host` loop runs it. The hub writes a provision row pinned to
  that node, the same row ADR 463 §3 already uses for a sponsored mint with a host (bf33cfe26), with
  `kind: 'move'`. The host claims it and reports `ready` or `failed`, and the CLI waits for that
  report and prints it. If no host on the target has polled within `HOST_STALE_MS`, `move --to`
  refuses before anything changes. It says to start `musterd host` there or to run `musterd move
  <seat>` at the target.

`arriveSeat` does what `bootstrap.sh seat` does today, in this order:

1. Provision the Workspace at `~/musterd/<team>/<repo>/<seat>`: a worktree by default, a full
   clone with `--clone` (ADR 463 §3). An existing Workspace for the seat is reused.
2. Write the seat's binding through the existing `musterd agent` reconcile, which mints a
   `claim_seat` bootstrap credential.
3. For Claude Code, pre-accept the folder trust (cloud-seat finding 8).
4. Run `init --refresh-hooks`, then `wire`.
5. If the hub revoked a residency row, run `residency on` with that row's harness and overrides.

For a human seat, steps 2 to 5 become `musterd human <seat>`. The human must already hold their own
credential on this machine. If they do not, `move` stops and prints the sign-in step.

It ends by printing the one command that opens the seat: `musterd <seat>`.

Two things do not move, and `move` says so on success:

- **The harness session.** ADR 210's continuity registry is per machine, so the seat starts a fresh
  session that keeps its musterd seat memory (ADR 366).
- **The old Workspace.** It is left in place. `musterd seats` on the old machine already shows
  "resident on <node>" for it (ADR 503 §2).

### 5. What the dead path becomes

`claim --token` comes out of `help claim`, the help catalog and the musterd skill. "Adopt a seat on
another machine" now points to `musterd move`. `docs/guides/second-machine.md` "Moving a seat"
becomes the one command. `bootstrap.sh seat` stays as the path for a seat born on the joiner, which
has no hub half.

## Alternatives considered

- **A two-sided move code**, like `node invite`/`join`: the source machine prints a code and the
  destination redeems it. It is safe, but every move needs someone at both machines, and that is
  the friction nick asked to remove. It is no help when the old machine is dead (an admin can still
  move the seat) or when the target is headless (`--to` reaches its host).
- **Floating seats** (spec 2026-10-17 §4.6): a seat enrolled on several nodes, with the hub's lease
  as the guard. That is a different feature: a seat that runs wherever it is woken, not a seat that
  has moved. It is still blocked on its fencing token. `move` keeps one node per agent and so needs
  no fencing.
- **Make `node unbind` also re-bind.** This overloads an admin release valve with an authority
  model (sponsor, the seat itself) it was never meant to carry. It also fixes nothing on the
  destination side.

## Consequences

- One protocol addition (`SeatMoveRequest`/`SeatMoveResult`, the `sync/move` forward, the
  `seat.moved` audit action, and `kind: 'move'` on a provision row). This ADR gates it (hard rule 1).
- `node unbind` stays, unchanged, as the admin's escape valve.
- The unbind race in `joiner-wedges.md` is closed for any move made through `move`. A bare unbind
  still has it.
- An agent can move itself. This is new authority. It is bounded: the seat can only move itself,
  only to an unrevoked node of its own team, and every move is audited as `seat.moved` with `by`.

## Observability & Evaluation

- **Traces:** `seat.moved` audit rows (from, to, by, residency carried), plus the CLI's wait outcome
  (`accepted` | `timeout` | `skipped`) in the act stamp of the steer.
- **Eval:** the CLI test drives a move with a stubbed hub through each branch: live seat that
  accepts, live seat that times out with an unpushed branch, an idle seat, the seat moving itself,
  a human, and a forbidden caller. The server test drives the transaction, checking that there is
  no unbound window: a racing `bindSeatToNode` from the old node during the move is refused.
- **Experiment:** the next real move, wallow from `mac.lan` to `macbook-air-2.lan`, is done with
  this command. Success means one command, the seat claimed on the Air, and no `bound_elsewhere`
  wedge on either daemon's next five pushes. A failure is recorded in `joiner-wedges.md`.
  Follows-up: lane `01M5G22C7NEA4T3R9R4SSZE09M` records the readout.
