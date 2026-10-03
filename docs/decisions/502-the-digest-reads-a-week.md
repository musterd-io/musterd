# 502 — The digest reads a week

- Status: accepted
- Date: 2026-10-03
- Deciders: nick (both rules, in session with ryder, 2026-10-03), ryder
- Lanes: `01M41G2YT5` (this ADR and its change, ryder)
- Builds on: ADR 494 §5 (the morning digest), ADR 202 (a `lane_review` ask and its lane)

## Context

The first live morning digest was posted on 2026-10-03, and its "Unanswered asks" section listed ryder's asks to nick
going back 65 days. Of the nine asks listed, six were already settled. Two had been settled by a merged PR. One
was an ADR that had since been accepted. One owed experiment had since been run and accepted. One concerned a
loop that a later ADR had fixed. One was a scope question the work had long outgrown. None had a reply or a
`resolve` on its own thread, so the digest still counted all six as open. The "Waiting" section had the same
shape: every directed thread never formally closed, from all time, which came to 630 threads for one seat.

## Problem

ADR 494 §5 says the digest shows "which asks went unanswered", but it never bounds that list. `buildDigest`
reads every ask with no accept or decline and no thread `resolve`, back to the start of the team. It also
cannot see the most common way an ask is settled, which is that the work it was about closes. A morning
summary that leads with two-month-old settled asks buries last night's live ones, and the team learns to
skip the section.

## Decision

1. **A week window.** The digest lists asks, and counts waiting threads, received in the last seven days
   (`DIGEST_WINDOW_MS`, on the receipt clock ADR 494 already uses). Open asks older than that are not
   listed. They are counted in one line: "+N older open asks — `musterd report delivery` lists them". The
   older asks are still reachable, but they no longer crowd out the current ones.
2. **A settled lane settles its ask.** An ask that names a lane is discharged for the digest when that lane
   is `done` or `abandoned`. "Names a lane" means `meta.lane_review.lane`, `meta.lane` or `meta.lane_id`. A merged PR does
   not count on its own, because the server cannot see GitHub. A merge reaches the board only through its lane.

This changes what the digest shows and nothing else. The discharge ledger, `musterd report delivery`, and the
waiting ledger's other readers are unchanged.

## Consequences

- On 2026-10-03's nine asks, rule 2 alone would have removed none. Measured that day: three of the nine
  carry `meta.lane`. Two of those name lanes that are absent from this hub, because they predate its
  history (2026-09-02). The third names the cookoff lane, which is still open and correctly owed. The week
  window does the work on old backlogs. Rule 2 is for the routine case going forward: lane-review asks
  (981 of 1,203 asks on this hub) whose lane closed by some route other than their own accept.
- An ask that is truly still owed after a week drops to the "+N older" count. The count line keeps it from
  disappearing silently, and `musterd report delivery` still lists it individually.
- `waitingOn` gains an optional `since`. The default (no `since`) is unchanged for every other caller.

## Observability & Evaluation

**Traces.** None new. The digest is an ordinary message, and its body is the record.

**Eval.** Read the next five working-day digests on `revive`. Targets: (1) no listed ask is older than
seven days; (2) no listed ask names a lane that is `done` or `abandoned`; (3) the "+N older" count is
present whenever older open asks exist. Falsify: a digest that lists an ask older than seven days, or one
whose named lane was closed before the digest was posted.

**Experiment.** Before: the 2026-10-03 digest, with nine ryder→nick asks listed and the oldest 65 days old. After: the
first digest posted on a build that includes this change, read against the same `messages` table. Expected: only
asks from the last week are listed, and one "+N older" line appears.
