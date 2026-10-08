# 547 — A fold that cannot advance is a standing roster warning

- Status: accepted
- Date: 2026-10-08
- Deciders: nick ("take the sync lane", then "yes", 2026-10-08)
- Lane: `01M4E71RJT1D9ARP7QDJK7F57A` (goal `seat-continuity`)
- Builds on: ADR 360 follow-on (a wedged push says so on the roster), ADR 325 inc 3b-ii (the fold
  blocks, never skips), ADR 393 (an unknown seat on `residency.enrolled` is git lag: stop, don't skip)

## Context

On 2026-10-08 Air 2 stopped applying the hub's log at about 02:00 UTC and was found stuck at about
17:30 UTC, roughly 15 hours and ~4,300 events behind. dreamy (opencode, Air 2) never got the acceptance
asks sent to it. The first reading was a slow hub, because Air 2's log held 333
`sync_pull_failed … TimeoutError` lines since Oct 5. Those were the hub laptop asleep overnight, with
pulls working in between. The hub answered 770 of 771 pulls in under 5 s (the one outlier was a laptop
sleep), and the stuck page was 30 KB gzipped.

The cursor was frozen at `hub_seq` 191205. The next event, 191206, was `residency.enrolled` for
**alfie**, a seat created on the hub laptop that morning. Seat files travel by git, not by sync, and
`.musterd/seats/alfie.toml` was never committed to `musterd-revive`. Air 2's roster did not hold
alfie, so its fold stopped at 191206 as `unresolved_seat` (ADR 393: git lag, stop). The fix was a
commit and a `git pull`; the hub saw an eleven-page drain two seconds after.

## Problem

The stop was correct and the visibility was not. `reportStop` logs a stop once per distinct blocker
and then stays silent (so a stall is not 1,440 lines a day). Every later tick logged only
`sync_pull_failed` timeouts when the hub was asleep, which read as "offline". Nothing on any surface a
seat or human reads said "your machine has applied nothing since 02:00 and here is why".
A wedged *push* has said so on the roster since ADR 360; a stopped *pull* never did.

## Decision

1. **The daemon remembers the stop.** `pullPage` records the `FoldStop` that held the cursor (kind,
   the thing it names, `hub_seq`, and `since`, the first tick that saw this same stop) and clears it
   when the fold advances or a page comes back empty. In memory, per daemon: the fold recomputes the
   same stop every tick, so a restart re-derives it within one `SYNC_PULL_INTERVAL_MS`. No migration.
2. **A grace, then a warning.** `readPullStop` returns it only once it has held for
   `SYNC_STOP_WARN_AFTER_MS` (5 min). A one-tick stop can be nothing more than a seat file one
   `git pull` away, and should not flash a warning.
3. **One additive roster field.** `GET /teams/:slug/members` gains `sync.pull_stopped`
   `{kind, subject, hub_seq, since} | null` beside `sync.wedged`. `kind` is an open string so an older
   client reads a newer daemon's kinds. The wording lives in `@musterd/protocol`
   (`describeSyncPullStop`), one sentence per cause with the remedy: for `unresolved_seat`, `git pull`
   the team roster repo (and check the seat file was pushed); for an unreadable event, upgrade; for an
   invariant break, an operator.
4. **The subject is peer text, so it is cleaned twice.** For an unreadable act the subject is a string
   the hub's event carried. `sanitizeStopSubject` (protocol) keeps letters, digits and `._:@/-`, turns
   everything else to `?`, and cuts at 64 characters. The daemon applies it when it records the stop and
   `describeSyncPullStop` applies it again when it builds the sentence, so neither a control or escape
   byte reaches a terminal nor a line of instructions reaches an agent through this field.
5. **Surfaces.** `musterd status` prints it beside a wedged push; the MCP `team_status` and inbox
   warning (`syncWedgeWarning`) append it. The structured inbox warning fact is left for a follow-up.

Not decided here: whether one unresolvable seat should stop replication at all. ADR 393 chose to stop
rather than skip, and the cost of skipping (an act folded without its seat) is not obviously smaller
than the cost of stopping. That is a separate decision, and it is easier to make once stops are
visible and their frequency is known.

## Consequences

- Additive protocol surface: a new optional field and an exported interface (`RosterSyncState`). An
  older client ignores the field; an older daemon omits it and the clients treat that as silence.
- The warning is per daemon and says nothing about the hub: the hub folds its own log and a stop
  there is reported the same way.
- A stop that clears and returns restarts its clock only if it is a different stop (kind or subject).
- Follow-up 2026-10-08, lane `01M4EAQ1150XE8AB2CZ6DX2H69`: `team add` now says when the new seat file is
  uncommitted or unpushed, which is the cause of this incident (`seatFileUnpublished` in `roster.ts`).
  CLI-side only; no protocol change.
- Follow-up 2026-10-08, lane `01M4EHMGGG3BEDX1M55GHE28E5`: `describeSyncWedge` now cleans the seat, machine
  label and node id it quotes from the hub's refusal the way `sanitizeStopSubject` cleans a stop subject
  (`sanitizeWedgeLabel`; a label keeps spaces and apostrophes, a node id is cleaned but never cut).
  Wording unchanged for ordinary values; no schema change.

## Observability & Evaluation

- **Traces:** n/a — this changes what a roster read says, not an agent's tool path.
- **Eval:** the falsifier is a held stop. On a joiner whose fold is stopped, `GET /teams/:slug/members`
  returns `sync.pull_stopped` non-null after 5 minutes, naming the same `hub_seq` as the
  `sync_fold_blocked` log line. Dataset: the 2026-10-08 Air 2 incident (alfie at `hub_seq` 191206),
  reproduced by `pull.test.ts` "a stop that holds the cursor is readable as a standing warning".
  Baseline: before this change the roster carried nothing for a stopped pull.
- **Experiment:** n/a — mechanical. Watch whether `pull_stopped` ever fires on a healthy machine for a stop under 5 minutes (it must not).
