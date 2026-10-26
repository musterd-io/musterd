# 736 — Roster roots are pulled on a timer, not only on an unresolved-seat stop

- Status: accepted
- Date: 2026-10-26

## Context

A seat's roster entry and a role's file travel by git (ADR 058). Each daemon projects the roster
files in its own checkout into its database, and a file watcher re-projects them when they change.
ADR 592 made the daemon run the one git step a person used to run: when a sync page stops on a seat
this machine has never seen, `makeUnresolvedSeatHook` runs `git pull --ff-only` in every roster root
and reconciles what arrived.

That hook is the only place the daemon pulls. Only a seat that does not exist yet stops a fold.

## Problem

An edit to something that already exists never reaches the other machines. On 2026-10-21 (lane
`01M5FY2XFX`, then lane `01M5GC5YKP`), new roles and ten seat role assignments were pushed to the
roster repo from the laptop. The laptop reconciled them. The hub never pulled them, because no
fold stopped. Hours later the hub's `role list` still showed the old library, and a seat's daemon
row had `roles = []`. Pages served from the hub carried the stale roles, an acceptor reading the hub
saw nothing, and the machine that made the edit reported that everything was fine.

## Decision

1. **Every daemon with roster roots pulls them on a timer.** Every `ROSTER_PULL_INTERVAL_MS`
   (5 minutes), `startRosterPull` (`packages/server/src/sync/rosterRefresh.ts`) runs the same
   `refreshRosterRoots` as the ADR 592 hook: `git pull --ff-only` in each root that is a git
   checkout with an upstream. When any root moved, it reconciles and broadcasts, as the watcher
   does. This applies to the hub and to joiners alike. A machine whose roster another machine
   edited is stale in the same way, wherever it sits.
2. **It rides the roster watcher.** The timer starts and stops with the watcher (`startWatching`
   in `packages/server/src/index.ts`), so it runs exactly where `roster_watch` runs and never on
   Cloud, which has no roster checkouts. `reload` re-points it with the watcher.
3. **ADR 592 §3 holds unchanged.** The daemon never merges, rebases, commits, pushes or resolves
   a conflict. A root that cannot fast-forward is logged as `roster_pull_failed` with git's first
   line and the `git -C <root> pull` a person runs. It is logged when the failure first appears or
   changes, not on every tick.
4. **One tick at a time.** A tick still pulling when the next is due is not overlapped.

## Consequences

- A roster edit reaches every daemon within one interval plus one pull, about 5 minutes, instead of
  never. A brand-new seat still arrives at once through the ADR 592 hook.
- Each daemon now runs `git pull` in its roster checkouts every 5 minutes, including on a
  developer's laptop. That is the fast-forward-only pull ADR 592 already ran on a stop. A checkout
  with local commits or a branch that cannot fast-forward is left alone and reported once.
- The timer and the ADR 592 hook can overlap on one root. git's own lock makes the second call fail,
  which logs once and is retried on the next tick. They are not serialized with each other.
- A push-side nudge after `role assign` or `role create`, so the hub pulls at once rather than
  within 5 minutes, is not part of this. The timer bounds the delay without it.

## Observability & Evaluation

- **Traces:** `roster_pulled` (info, the root that moved) and `roster_pull_failed` (warn, git's
  first line and the fix) in the daemon log; reconcile failures log `roster_pull_reconcile_failed`.
- **Eval:** `packages/server/src/sync/rosterRefresh.test.ts` ("ADR 736") runs a real bare remote and
  two clones. A role edit to an existing seat pushed from one clone is pulled by the other's tick,
  which reconciles once; a second tick with a quiet remote reconciles nothing; a root that keeps
  failing the same way warns once; a tick still pulling is not overlapped.
- **Experiment:** n/a. The falsifier on the live team: a role or seat edit pushed to the roster repo
  that `MUSTERD_SERVER=<hub> musterd role list` still does not show 10 minutes later, while the
  hub's log has no `roster_pull_failed` for that root.
