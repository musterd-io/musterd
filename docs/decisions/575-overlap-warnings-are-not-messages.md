# 575 — Overlap warnings are not messages

- Status: accepted (2026-10-12, nick, in chat: "yes do it")
- Date: 2026-10-12
- Deciders: nick, wallow
- Lane: `01M4S953YR0G1CXKY1716SZDDR`
- Supersedes: [ADR 083](083-lanes-phase1-intent-dependency.md) decision 4(b) for `surface_overlap`
  only. A `surface_overlap` warning is no longer sent to the other lane's owner as a directed act.
  Decision 4(a) (inline to the actor) and 4(c) (on the board) stand, and 4(b) stands for every other
  warning kind.

## Context

ADR 083 shipped lanes with two warn-only checks, and delivered each fresh warning three ways:
inline to the actor, as one directed `message` act to the other lane's owner, and on the board. It
accepted glob false positives as cheap because the checks never block, and named warning precision
as an eval to run in dogfood. That eval had not been run.

On 2026-10-12 the hub's store held 1,863 lanes, 1,395 of them merged with a known squash commit, and
2,359 `surface_overlap` messages (2,306 distinct lane pairs, first on 2026-07-08). For each merged
lane, the files its merge commit changed are what it actually touched. `ROADMAP.md`,
`pnpm-lock.yaml` and `docs/implementation-plan.md` are excluded as regenerated files.

| measure | value |
| --- | --- |
| Precision: warned pairs (both merged) that ever changed a common file | 27.3% (13.5% for a common code file) |
| Recall: lanes open at the same time that changed a common file, and were warned | 15% (491 of 3,281) |
| Directed warnings that got any reply | 5 of 2,359 (0.2%) |
| Directed warnings in the last 24 hours | 127 |
| Mean share of a lane's changed files its own declared globs cover | 73% |

Applied after the fact to every pair of same-time lanes that both declared a scope, the matcher
reaches 61% recall at 33% precision. Matching each glob against the real file tree instead lifts
precision to 37% at 59% recall. The input, not the matcher, sets the ceiling.

## Problem

The directed message is the costly part of the warning. It wakes or interrupts the other owner, and
it lands in an inbox where seats are told to read every act. At about one useful warning in four, and
one reply in five hundred, it teaches seats to skim their inbox, and that cost carries over to the
acts that matter. Today's own example: opening the lane for this ADR sent eight overlap messages to
four seats, most of them for `docs/decisions/**` against other ADR files.

Separately, `globsOverlap` compared only the literal text before each glob's first wildcard. A glob
for every package's `package.json` therefore read as `packages` and overlapped every file in every
package: the ADR 565 lane warned against every server lane that day.

## Decision

1. **A `surface_overlap` warning is not delivered as a directed act.** It is still returned inline in
   the response to the verb that raised it (`lane_open`, `lane_claim`, `lane_update`), and still shown
   by `lane_board` and `GET /lanes`. `unmet_dependency` and the other directed warning kinds are
   unchanged.
2. **`globsOverlap` matches segment by segment.** Two globs overlap when each segment they share can
   name the same thing: equal, a wildcard segment matching the other's literal, or two wildcards. A
   `**` absorbs the rest, and a glob that ends first is a directory covering what lies under it. It
   still errs towards warning, since two wildcard segments are assumed to meet.
3. **The useful overlap signal is the diff, not the declaration.** Warning a person again is
   deferred until it is computed from what pushed branches change, and measured against merge
   history before it sends anything.

Follows-up: 01M4S9AVXF6FMDXTMMKHS1WCM9

## Consequences

- The owner of an overlapped lane is not told. The actor is, at the moment it acts, which is the one
  point where moving or narrowing a lane is cheapest.
- The board's overlap count is still noisy. Decision 2 trims the worst cases, but 33% to 37% is the
  ceiling for declared globs.
- Seats see roughly 120 fewer directed acts a day on this team.
- not-a-falsification: ADR 083 called glob false positives cheap because nothing blocks on them. That
  stands for the board. What it underpriced was the directed message, which was not free.

- _2026-10-21, lane 01M5E8CD9C:_ one overlap is now precise by construction: a file both lanes
  name outright. [ADR 691](691-named-file-is-held-first-claim-wins.md) makes the first claim a
  hold, the gate refuses the other seat's edit under block, and the inline warning says so. The
  area-glob overlaps this ADR measured stay advisory and inline.

## Observability & Evaluation

**Traces** — n/a: no new span. The `[lane]` messages that stop are ordinary envelopes, so the drop
shows in the existing per-act counters, and `surface_overlap` still appears in verb responses and on
the board.

**Eval** — decision 2: the precision and recall script, run on the matcher's output for lanes merged
after this ships, should show precision at or above 33% with recall within 5 points of 61%.

**Experiment** — the falsifier for decision 1: if work was lost to overlaps the messages would have
prevented, it shows as a merged lane that redid or reverted a same-time lane's change to a file both
declared. Count those in the 30 days after this ships against the 30 days before. A rise means the
message was earning its noise, and it comes back for the cases where it would have fired.
