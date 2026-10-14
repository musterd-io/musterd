# 591 — A replicated stream held on an unknown seat is visible at both ends, and a seat minted on a joiner is told how to reach the hub

- Status: accepted
- Date: 2026-10-13
- Deciders: nick ("you can claim it", 2026-10-13)
- Lane: `01M4W28V0BVY8G8WRF2ADG45TT` · Goal: `seat-continuity`
- Builds on: [ADR 547](547-stopped-fold-is-a-standing-warning.md) (a stopped fold is a standing
  roster warning — on the machine whose fold stopped), [ADR 393](393-residency-enrollment-projects.md)
  (an unknown seat on `residency.enrolled` is git lag: stop, don't skip), [ADR 058](058-durable-on-git-live-on-daemon.md)
  (seat files travel by git), [ADR 355](355-hub-arbitrates-a-joiners-claim.md) (lane claims are arbitrated on
  the hub), [ADR 588](588-resident-byok-seat.md) (the seat that surfaced it)

## Context

On 2026-10-13 a resident seat (`resident`, ADR 588) was minted on Air 2, a joiner, at 18:08. The
`musterd agent` run that minted it wrote `.musterd/seats/resident.toml` into Air 2's roster repo
first (ADR 058 §5) and then died at the credential mint, before the line that says "commit and push
this file" (ADR 547's follow-up) could print. The file sat uncommitted. At 18:21 `residency on`
replicated `residency.enrolled` for `resident` to the hub; the hub's fold stopped there as
`unresolved_seat`, exactly as ADR 393 says it must.

What ADR 547 did not foresee is which end could act. The stop was on the hub. The hub's roster said
`pull_stopped` — on a machine nobody was reading. On Air 2, every push was accepted (the cursor
advanced to 29339), two lanes opened there (18:23, 19:01) were refused on every patch as "not yet
replicated to the hub — its birth has not folded here; retry after the next sync", `lane_claim` and
`lane_submit` from the seat were refused as "not on the hub's roster yet", and nothing on Air 2 said
why. The lanes were invisible to the hub for 100 minutes; `musterd team add resident` on the hub
cleared it in one tick. The diagnosis took two seats and a human ninety minutes, mostly spent
proving that pushes were flowing.

Two facts made this a trap rather than a bug anyone would have seen:

1. **The stop is loud only where it happens.** ADR 547 made a stopped fold a standing warning on
   the roster of the daemon whose fold stopped. A joiner's fold stop is seen by the joiner's seats,
   who can `git pull`. A hub's fold stop is seen by whoever reads the hub's roster — and it holds
   every lane claim, handoff and submit from every machine, because those are arbitrated on the
   hub (ADR 355).
2. **A seat can be minted without a reachable seat file.** `POST /members` on a joiner (the
   loopback agent-seat path) creates the member in that daemon; the seat file is the CLI's job,
   and the three CLI paths that make a seat usable — `musterd agent`, `bootstrap mint --install`,
   `residency on` — each assumed someone else had checked the file. A failed `musterd agent` leaves
   the file and says nothing; the other two never looked.

ADR 547 left one question open on purpose: whether an unresolvable seat should stop replication at
all. This ADR does not reopen it. The stop stays (skipping an event folds an act without its seat,
and ADR 393's reason holds); what changes is who hears about it and how early.

## Problem

A fold stop on the hub must reach the joiner whose events it holds — on the surfaces that joiner's
seats and humans read, and in the refusal they get when they try to work — and a seat whose file
cannot reach the hub must be told so at the moment it is minted, installed, or enrolled, with the one
command that fixes it.

## Decision

1. **The hub says, on every answer, whether its fold is held.** `POST /sync/push` and
   `GET /sync/pull` responses gain an additive `fold_stopped: SyncPullStop | null` — the hub's own
   ADR 547 stop, with no grace (the joiner applies the grace from the stop's `since`). A quiet
   joiner has nothing to push, so the pull page is what tells it; both carry it so a busy joiner
   hears it on the next push, not the next minute.
2. **The joiner remembers what the hub said.** `sync/hubStop.ts`: `noteHubStop` records the latest
   answer per team (null, or an older hub's silence, clears it — a stale stop never outlives the hub
   that reported it); `readHubStop` returns it after the same five-minute grace ADR 547 gives a local
   stop. In memory per daemon config, like the pull stop: the hub restates it on every answer.
3. **The roster carries it as `sync.hub_stopped`.** Additive beside `wedged` and `pull_stopped`
   (`RosterSyncState`). `musterd status` and the MCP inbox warning (`syncWedgeWarning`) print it
   with the hub wording of `describeSyncPullStop(stop, now, 'hub')`: the hub's roster does not hold
   the seat, every lane claim from every machine waits, and the two fixes — commit and push the seat
   file on the machine that added the seat, or `musterd team add <seat>` on the hub. Null on the
   hub itself and on a machine without one.
4. **The lane refusal names the stop.** When the hub refuses a lane patch because the lane has not
   folded there, and the hub's own fold is held, the refusal says so and names the stop and its fix
   instead of "retry after the next sync" — because no retry will fold it.
5. **Every seat-making CLI path checks the seat can reach the hub.** `roster.ts` gains
   `seatReachLines(seat, rosterHome, kind, role)`: the warning and fix when the seat has no file
   under the roster home at all (`musterd team add <seat> --kind <k> [--role <r>]`, then commit and
   push) or an unpublished one (ADR 547's lines). `residency on` and `bootstrap mint --install`
   print it; `musterd agent` prints it on failure too, since the file is written before the step
   that can fail.

Not decided here: replicating members over sync, or having the daemon write seat files itself. Both
would change where the roster is authoritative (ADR 058) and are a separate decision; this ADR makes
the existing design visible and self-explaining at the point of failure.

## Consequences

- Additive protocol surface: `fold_stopped` on two sync answers, `hub_stopped` on the roster, a third
  parameter on `describeSyncPullStop`. An older hub sends none and the joiner reads silence; an
  older client ignores the field.
- The hub's fold stop is now reported three ways on the joiner — roster, status, inbox — and once
  more in the refusal a seat gets when it tries to work. The remedy text names both machines' fixes
  because the person reading it is usually on the wrong one.
- The seat-file check runs on three CLI commands. It adds one `git` call per command on a machine
  with a roster home and nothing elsewhere.
- Air 2's uncommitted `resident.toml` and the hub's copy written by `team add` are two files for one
  seat; the hub's wins on the next reconcile, and `seatReachLines` would have named the first one at
  18:21.
- **2026-10-13, later — [ADR 592](592-unknown-seat-parks-not-stalls.md) runs the commands this ADR
  prints.** `team add` and `musterd agent` publish the seat file themselves (`publishSeatFile`), and
  a daemon stopped on an unknown seat pulls its roster roots and folds again in the same tick. The
  lines in decision 5 stay as the fallback when a publish fails or `--no-publish` was passed. Still
  not decided: the daemon writing seat files, or members as a sync kind.

## Observability & Evaluation

- **Traces:** n/a — this changes what sync answers, the roster and a refusal say; no agent tool path
  or audit verb changes.
- **Eval:** the falsifier is tonight's shape, run as a test between two real daemons
  (`sync/pull.test.ts`, "the hub's stop reaches the joiner"): a seat minted on the joiner with no
  seat file on the hub; the hub's fold stops; the push answer and the pull page carry
  `fold_stopped`; the joiner's roster carries `sync.hub_stopped` after the grace and the hub's own
  roster carries null; a lane born on the joiner behind the stop is refused with the hub's stop and
  the seat named in the message; the seat reaching the hub clears it on the next pull. Baseline:
  before this ADR the same sequence produced "retry after the next sync" and a joiner roster with no
  warning (2026-10-13, 18:24–20:04). CLI: `roster.test.ts` pins `seatReachLines` for no file,
  uncommitted, published and no roster home.
- **Experiment:** n/a — mechanical. Watch for a `hub_stopped` warning on a joiner whose hub is
  moving (it must not appear) and for the refusal text ever lacking the stop when the hub is held.
