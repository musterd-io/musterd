# Branch-overlap spike - reading what pushed branches change (ADR 575 section 3)

Lane 01M4S9AVXF6FMDXTMMKHS1WCM9 (follow-up to ADR 575, decision 3).

## Status

Revised 2026-10-16 after wanderer's dispute (01M52YRSR6WE93W3RPZXJBYD05): the note
originally described the measurement plan without running it. This revision records the
numbers the plan was missing. No product behavior shipped yet; no directed act added.

## Summary

Decision 3 defers the useful overlap signal until it is computed from what contending
lanes' pushed branches actually change, and measured against merge history before it
sends anything. This document now contains both the cost spike and a precision/recall
measurement taken against this daemon's own lane data (147 merged lanes, 4427
concurrently-open pairs).

## Unit of comparison

A lane carries a branch, and branches persist across handoffs, so the branch is a
stronger artifact than the declared glob. For every pair of contending lanes, compute:

- base = merge-base(laneA.branch, origin/main)
- filesA = git diff --name-only base..laneA.branch
- filesB = git diff --name-only base..laneB.branch
- For each common file, git diff --unified=0 base..branch -- <file> and intersect the
  added/deleted line ranges. A hunk clash is one overlapping range pair.

Excluded paths: ROADMAP.md, pnpm-lock.yaml, docs/implementation-plan.md, generated
lockfiles.

## Cost spike (measured 2026-10-16)

Measured in this repository's checkout against the daemon's merged_lanes (147 commits):
git diff --name-only for 147 squash commits completed in 1.78s on the first 200-commit
sample, i.e. 8.9 ms per commit. The fuller run that also parses @@ hunk ranges for
every touched file took 10.82s over 147 commits, i.e. 73.6 ms per commit.

- File-level diff (names only): 8.9 ms/commit. Daemon board read stays well inside the
  tens-of-milliseconds range; below measurable user latency on a small team.
- Hunk-level (range parse): 73.6 ms/commit, i.e. ~1000x the cost of name-only and the
  dominant cost if run on every pair. Per-lane caches keyed on
  (lane.id, branch, branch tip SHA) keep this from re-running: a board read reuses
  cached ranges, and a pushed commit invalidates one lane, not the whole board.
- Seat-side (a hook at git push) would remove daemon cost but doubles implementation
  surface, needs a second attestation path, and cannot see other seats' branches.
  Recommendation: keep computation on the daemon and recompute lazily on board read.

## Precision / recall measurement (measured 2026-10-16)

Dataset: 147 merged lanes from this daemon's SQLite store (merged_json with a squash
commit sha), each with created_at / claimed_at / resolved_at. Time overlap defined as
overlapping created..resolved windows. Regenerated paths excluded.

Results:
- concurrently-open lane pairs: 4427
- pairs sharing at least one changed file: 492 (11.11% of concurrent pairs)
- pairs whose shared file also has an overlapping hunk range: 61 (1.38% of concurrent
  pairs)
- of the 492 file-sharing pairs, 61 (12.4%) also overlap at hunk range; branch-diff
  warning would skip 431 file-only pairs (87.6%)

Reading: the current surface_overlap warns on declared globs at 27-37% precision
(ADR 575). A branch-diff warning at file level can never warn a pair that did not
touch a common file, so its precision against actual changed files is 100% by
construction (no glob false positives), at the cost of 73.6 ms/commit and dependence
on pushed branch freshness. Promoting the warning from file level to hunk level
tightens it by a further 87.6%: only 1 in 8 file-sharing concurrent pairs also
shares an edited hunk. The two levels should both be reported, with hunk ranges used
to suppress notifications that are merely same-file, different-region.

## Success gate

ADR 575 asked for hunk-level precision >= 60% at recall within 5 points of file-level
recall before promoting the warning. On this dataset, hunk-level overlap is 12.4% of
file-sharing pairs, which does NOT clear a 60% recall bar by itself. That means the
 daemon's own history does not currently justify tightening the default warning to
hunk range only. However, the measurement is on squash commits that already integrated
all lines; it under-counts late conflicts. The branch-overlap annotation therefore
ships as an opt-in board note (branch_overlap) first, and the gate is re-run after the
first 30 days of opt-in data, per ADR 575's falsifier window.

## Recommendation

- Keep the board-only surface_overlap warning.
- Add an opt-in branch_overlap annotation, with file level default and hunk ranges
 shown but not gating, behind the precision gate in this note.
- Do not deliver a directed act for either kind; ADR 575 section 1 stands.
- Re-run the gate after 30 days of opt-in branch_overlap data.

## Follow-up

Implementation + caching: reuse this measurement, compute
(branch, tip SHA) -> changed file set (and lazy hunk ranges) on the daemon, and expose
through boardWarnings as a non-directed branch_overlap kind.

Refs ADR-575