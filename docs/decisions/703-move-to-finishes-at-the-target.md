# 703 — `musterd move --to` finishes at the target (supersedes ADR 696 §4's host path)

- Status: accepted
- Date: 2026-10-21
- Lane: `01M5G22C7NEA4T3R9R4SSZE09M`
- Deciders: wallow, following TJ's acceptance review of the lane (2026-10-21)
- Supersedes in part: [ADR 696](696-musterd-move-a-seat-between-machines.md) §4, the "With `--to`"
  bullet (the target's `musterd host` runs the destination half)

## Context

ADR 696 §4 says the destination half of a move, `arriveSeat`, runs on the destination machine in
both cases. Without `--to`, the CLI runs it in place. With `--to`, the target's `musterd host` loop
was to run it. The hub would write a provision row of `kind: 'move'` pinned to the target node, the
host would claim it and report `ready` or `failed`, and `move --to` would wait for that report. It
would refuse up front if no host there had polled within `HOST_STALE_MS`.

What shipped in #3129 is different. `move --to` makes the same hub act (re-bind, residency revoke,
`seat.moved` audit). It then prints the step that finishes the move: `musterd move <seat>` run on the
target (`musterd human <seat>` for a human seat). `docs/guides/second-machine.md` "Moving a seat"
documents exactly that. No provision row of `kind: 'move'` is written, and no host claims one. The
host path is open as lane `01M5GDGC5ZGTMXPFBXE482WJQ0`.

## Problem

TJ declined the lane's acceptance because the accepted Decision and the shipped command disagree.
Hard rule 3 forbids that, and an accepted ADR's `## Decision` cannot be edited to fix it.

## Decision

1. **`musterd move <seat> --to <machine>` is the hub act plus a printed finish.** It re-binds the
   seat, revokes its residency row and audits `seat.moved`, as ADR 696 §2 says. It then prints what
   to run on `<machine>`: `musterd human <seat>` for a human seat, and for an agent seat
   `musterd move <seat>`. Run there, that command takes the "Without `--to`" path: the hub re-binds
   the seat to the node it already has, and `arriveSeat` runs in place.
   - **The finish carries the wake enrollment.** The hub hands the revoked residency row (harness
     and policy overrides) back to the caller of the first act. When run at the target, the second
     act finds no row left to return. So when there was a row, `--to` prints the finish as
     `musterd move <seat> --harness <h>`, followed by the exact `musterd residency on --seat <seat>
     --harness <h> <knob flags…>` line, which re-creates the enrollment from the target's Workspace.
     For a seat on its own key (ADR 588), it prints the `--harness musterd --key-env <VAR>` form.
2. **The host-run destination half is not part of this command yet.** _(Amended 2026-10-22: it landed in lane `01M5GDGC5Z`. `--to` waits for a live host and prints the finish when none has polled; it does not refuse. See Consequences.)_ The provision row of
   `kind: 'move'`, the host's `ready`/`failed` report, the wait for that report and the
   `HOST_STALE_MS` refusal all move to lane `01M5GDGC5ZGTMXPFBXE482WJQ0`. That lane will add them
   for headless VM and cloud targets, where no person is at the target to run the second command.
   When it lands, `move --to` waits for the host whenever a live host is on the target, and prints
   the finish only when there is none.
3. Everything else in ADR 696 stands: the verb, the one-transaction re-bind, who may move a seat,
   the steer and wait, `arriveSeat`'s steps, and what does not move.

## Consequences

- With `--to`, the seat is bound to the target, but it has no Workspace there until someone runs the
  printed finish. During that gap the old host gets no wake leases, because its residency row is
  revoked, and the target has nothing to wake. A move to a machine nobody is at stays half-done
  until lane `01M5GDGC5Z` lands. Pushes from the old node are refused as `bound_elsewhere`, so there
  is still no unbound window.
- Before this ADR, the `--to` finish dropped the wake enrollment. wallow's own move to
  `macbook-air-2.lan` (ADR 696's experiment) ended with wallow not enrolled on the Air, and
  `residency status` there shows it. A seat moved that way before this fix is re-enrolled by hand
  with `musterd residency on` in its Workspace.
- ADR 696's Consequences name `kind: 'move'` on a provision row as a protocol addition. It was not
  added, and it goes to lane `01M5GDGC5Z` with the host path. This ADR makes no protocol change.
- ADR 696 §4 carries a dated marker that points here. Its Consequences carry the matching note.
- **Landed 2026-10-22 (lane `01M5GDGC5Z`).** `move --to` writes a `kind: 'move'` provision when a host on the target has polled within `HOST_STALE_MS`, pinned to that label. The CLI waits up to 120 seconds. Ready: the host stood the Workspace up, and the finish is not printed. Failed, cancelled, or timed out: the reason when there is one, and the finish. No live host: the finish only. A human seat stays on `musterd human`. The claim body's `kinds` is omitted for mint-only (no default). A move row is not failed `no_budget` and gets no connect link. `takeProvisionedWake` ignores it. `hand_to_host` is set only when the caller passed `--to`. The gap described above remains only when no host on the target is live.

## Observability & Evaluation

- **Traces:** unchanged from ADR 696. `seat.moved` is written by the hub act. Arrival shows as the
  seat's claim from the target Workspace.
- **Eval:** `packages/cli/src/commands/move.test.ts` asserts the `--to` finish: with no residency
  row it is the `musterd move` line alone, and with one it carries `--harness` and a `residency on`
  line whose knob flags match the revoked policy. The same file asserts a ready host report prints
  no finish, and a failed report prints the reason and the finish. `sync/move.test.ts` asserts a
  live host on the target gets a `kind: 'move'` row carrying the revoked harness, and a stale host,
  a `seen_at` of 0, a null node on another machine, a human, and a move that did not pass
  `handToHost` get none. `provisioner.test.ts` asserts a move row enrolls the row's harness.
  `residency.test.ts` round-trips every knob through `policyFlags` and `collectPolicyFlags`.
- **Experiment:** the next `--to` move of a seat that has a wake enrollment, onto a machine whose
  `musterd host` polled within five minutes. It succeeds if the command returns without printing
  the finish and `musterd residency status` on the target shows the seat enrolled with the same
  harness and starred knobs. A target with no live host still succeeds by the printed finish.
