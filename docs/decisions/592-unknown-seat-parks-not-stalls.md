# 592 — A seat minted on one machine reaches every other machine without a human git step

- Status: accepted
- Date: 2026-10-13
- Deciders: nick ("open the lane … take it", 2026-10-13)
- Lane: `01M4WADR47N3NSF816S0H4HFE5` · Goal: `seat-continuity`
- Builds on: [ADR 058](058-durable-on-git-live-on-daemon.md) (seat files travel by git; the file is
  the single writer on a file-backed team), [ADR 393](393-residency-enrollment-projects.md) (an
  unknown seat in the fold is git lag: stop, don't skip), [ADR 547](547-stopped-fold-is-a-standing-warning.md)
  (a stopped fold is a standing roster warning), [ADR 591](591-a-held-stream-is-visible-at-both-ends.md)
  (the hub's stop reaches the joiner; every seat-making command prints the publish lines)

## Context

The roster of a file-backed team is the `.musterd/seats/*.toml` tree in the team's roster repo,
reconciled by every daemon from its own checkout (ADR 058). A seat's acts, lanes and presence travel
by sync; its roster entry travels by git. When a daemon's fold meets an event naming a seat its
roster does not hold, it stops at that event and retries each tick — ADR 393 chose stop over skip,
because an act folded without its seat is worse than an act that waits, and ADR 547 left the
question of whether to keep stopping "until stops are visible and their frequency is known".

They are known now. The hub's error log on 2026-10-13 holds four distinct `unresolved_seat` stops
in two weeks — `dreamy`, `slippy`, `TJ`, `resident` — each cleared only when a human committed,
pushed or pulled a seat file by hand. The last one is the one that hurt: `resident` was minted on a
joiner at 18:08 with its seat file never committed; the hub's fold stopped at 18:21 (hub sequence
267866) and held every later event from that machine — two lane births, the acceptance asks for
three landed lanes, every status update — until nick ran `musterd team add resident` on the hub at
about 20:05. Then the hub's commit and the joiner's commit diverged in the roster repo, and the next
`git pull` on the hub refused until a human reconciled that too. ADR 591, landed the same evening,
made the stop visible at both ends and made every seat-making command _print_ the fix. The lines
were printed. Nobody ran them for a hundred minutes.

Two facts stand behind the hold:

1. **The commands that end a stop are git commands nobody is standing at.** On the minting machine:
   add, commit, push the seat file. On every other machine: `git pull` in the roster home. A daemon
   is at both places all the time; a person is at neither when it matters.
2. **A fold retries each tick but never changes anything between ticks.** It re-reads the same
   roster and meets the same absence, so "retrying each tick" is only a promise to notice once
   somebody else acts.

ADR 591 deliberately did not decide whether the daemon should write seat files or replicate members
over sync, because both move where the roster is authoritative. This ADR keeps the roster where it
is and keeps the stop (ADR 393). It changes who runs the git commands.

## Problem

A seat minted on one machine must become resolvable on every other machine on the team without a
person running git by hand, while the roster stays a git tree, the daemon never writes a seat file
it did not author, and a fold never folds an act for a seat it cannot resolve.

## Decision

1. **A seat-making CLI command publishes the seat file it wrote.** `publishSeatFile(home, name)`
   (`packages/cli/src/roster.ts`): in the roster home, `git add` the seat's own file, `git commit`
   that file alone with the message `roster: add <name>`, `git push`. A push the remote refuses as
   behind is retried once after `git pull --rebase --autostash`. It runs after the daemon has
   accepted the member, so a refused add pushes nothing. `musterd team add` and `musterd agent`
   call it; `--no-publish` on either skips it and prints the ADR 547 lines instead. Its outcome is
   one of `published`, `already` (committed and pushed before the call), `skipped` (not a checkout,
   or no upstream) or `failed` (git's first line), and the command prints one sentence for success
   or the ADR 591 warning and fix for anything else. `--json` carries it as `seat_file_published`
   beside the existing `seat_file_unpublished`.
2. **A fold stopped on an unknown seat pulls the roster itself, then folds again in the same
   tick.** `Ctx.onUnresolvedSeat` (`packages/server/src/context.ts`) is what `pullPage` calls when
   `foldBatch` stops as `unresolved_seat`. The daemon wires it to `makeUnresolvedSeatHook`
   (`packages/server/src/sync/rosterRefresh.ts`): `git pull --ff-only` in every roster root that is
   a git checkout with an upstream, reconcile when any root moved, and answer whether the page
   should be folded again now. A `true` folds the next page at once — the events before the stop
   have already committed, so the second pass starts from the advanced cursor. A `false` leaves the
   stop standing, reported and recorded exactly as ADR 547 does. The hook is rate-limited per team
   and seat: the first tick that sees a stop pulls at once; the same stop pulls again at most once
   per minute.
3. **The daemon never resolves a git conflict.** `--ff-only` is the whole of what it runs. A root
   that cannot fast-forward — local commits, a tree git refuses to touch — is reported as
   `sync_roster_refresh_failed` with git's first line and the `git -C <root> pull` a person then
   runs; the stop stands. The CLI's one rebase (decision 1) is on the minting machine, inside the
   command the person just ran, and a conflict there is reported the same way: `failed`, git's
   words, the fallback lines, nothing resolved on their behalf.
4. **Stop, don't skip, stands.** No event is parked or folded past its seat; the ADR 393 rule and
   the ADR 331 cursor invariant ("everything up to N is applied") are untouched. What changes is
   how long a stop lasts: the time for the minting machine's push plus one pull, instead of the
   time for two people to notice.

## Consequences

- No protocol change. `Ctx` gains one optional field; a test that builds a bare ctx gets the old
  behaviour. The CLI's `--json` gains one optional field.
- Two new daemon log lines: `sync_roster_refreshed` (root, outcome) and `sync_roster_refresh_failed`
  (root, git's line, the command). A hub whose joiner never pushes a seat file logs one of these a
  minute, not one per page.
- A seat-making command now runs `git` three to five times in the roster home. On a db-only team,
  outside a checkout, or without an upstream, it runs nothing and says why.
- The 2026-10-13 shape, replayed under this ADR: `musterd agent resident` on the joiner pushes
  `resident.toml` as it finishes; the hub's fold stops at 18:21, pulls, reconciles, folds past —
  one tick. If the push had failed, the joiner's command says so with the fix, and the hub's roster
  carries the ADR 591 warning naming the seat until it lands.
- The CLI's `init` "Add a new agent" path (lane `01M4RJF62E`, stanley) and the second-machine
  bootstrap (lane `01M41NQ05V`) write seat files on paths this ADR does not touch; they can call
  `publishSeatFile` when they land.

## Observability & Evaluation

- **Traces:** n/a — no agent tool path or audit verb changes; the two log lines above are the
  daemon's own.
- **Eval:** three tests pin the decision. `sync/rosterRefresh.test.ts` runs `refreshRosterRoot`
  against a real bare remote and two clones: `updated` when the remote moved, `current` when it did
  not, `skipped` outside a checkout or with no upstream, `failed` — with git's line and the local
  commit untouched — when the root cannot fast-forward; and the hook pulls, reconciles only when a
  root moved, and rate-limits the same stop to once a minute. `sync/pull.test.ts` ("ADR 592") runs
  two real daemons: the hub stops on a joiner-minted seat; a hook that cannot help leaves the stop
  standing; a hook that adds the seat makes the same `pullTeam` call fold the act. `roster.test.ts`
  ("publishSeatFile") publishes an uncommitted file and only that file, pushes a committed one, is
  a no-op on a published one, catches up once when another machine pushed first, and reports a
  conflicting seat as `failed` with the fallback lines. Baseline: before this ADR the same sequence
  on real machines held for 100 minutes (2026-10-13, 18:21–20:05).
- **Experiment:** watch the hub's `sync_fold_blocked` lines for `unresolved_seat`. Each one should
  now be followed within the same tick by `sync_roster_refreshed` and, when the file was pushed, by
  the fold advancing; one that holds past a minute with `sync_roster_refresh_failed` names a root a
  person must pull by hand. If stops keep holding for minutes after this lands, the remaining cause
  is on the minting side (a `failed` publish nobody read), and the next step is the one ADR 591
  left open: the daemon writes and publishes the file itself.
