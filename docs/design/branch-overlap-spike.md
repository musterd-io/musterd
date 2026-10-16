# Branch-overlap spike - reading what pushed branches change (ADR 575 section 3)

Lane 01M4S9AVXF6FMDXTMMKHS1WCM9 (follow-up to ADR 575, decision 3).

## Scope of this increment

This increment ships a measurement report and the script that produced it
(scripts/research/branch-overlap-measure.ts). It does NOT ship the board-level
hunk-overlap annotation; that remains the explicit follow-up in "Follow-up" below.
Scope is deliberately the spike only, so the lane is not closed as if the whole
feature landed.

## Status

Revised 2026-10-16 after big-body's decline (01M530AABE1CH96K4J9RY4FTF5), which
repeated the earlier wanderer review (01M52YRSR6WE93W3RPZXJBYD05). Corrections
applied: (1) cost arithmetic uses each run's own population (8.3 vs 9.7 ms, not
1000x); (2) the 60% hunk gate and 30-day window below are labelled as this lane's
proposals, not ADR 575's own gates, which are separated out; (3) the measurement
script is supplied so the numbers reproduce; (4) 61/492 is stated as an overlap
fraction of concurrent pairs, not as an independent validation of warning
precision/recall.

## Summary

Decision 3 defers the useful overlap signal until it is computed from what contending
lanes' pushed branches actually change, and measured against merge history before it
sends anything. This document now contains both the cost spike and a measurement taken
against this daemon's own lane data (146 merged lanes, 4381 concurrently-open pairs).

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

Command: node --disable-warning=ExperimentalWarning scripts/research/branch-overlap-measure.ts
Measured in this repository's checkout against the daemon's merged lanes (146 commits):

- File-level (git diff --name-only): 8.3 ms/commit (1241 ms total).
- Hunk-level (git diff --unified=0 plus @@ range parse): 9.7 ms/commit (1420 ms
  total).

Parsing hunk ranges adds ~1.2 ms/commit (~1.14x) over names-only, so the cost gap
between the two earlier passes was arithmetic error, not a measurement. The
daemon-host path remains the recommendation, cached per (lane.id, branch, branch tip
SHA); a pushed commit invalidates one lane, not the whole board.

Seat-side (a hook at git push) would still remove daemon reads, but it needs a second
attestation path and cannot see other seats' branches. Recommendation stays: keep
computation on the daemon and recompute lazily on board read.

## Measurement (measured 2026-10-16)

Dataset: 146 merged lanes from this daemon's SQLite store (merged_json with a squash
commit sha), each with created_at / claimed_at / resolved_at. Time overlap defined as
overlapping created..resolved windows. Regenerated paths excluded. Command (pinned population, reproducible):
  node --disable-warning=ExperimentalWarning scripts/research/branch-overlap-measure.ts \
    --resolved-before=1792177618000 --limit=150

Results:
- concurrently-open lane pairs: 4381
- pairs sharing at least one changed file: 470 (10.73% of concurrent pairs)
- pairs whose shared file also has an overlapping hunk range: 56 (1.28% of
  concurrent pairs)
- of the 470 file-sharing pairs, 56 (11.9%) also overlap at hunk range; branch-diff
  warning would skip 414 file-only pairs (88.1%)

Reading: this 56/470 figure is the fraction of file-sharing concurrent pairs that also
clash at hunk range. It is an overlap fraction of the measured population, not an
independent validation of warning precision or recall (those need a ground-truth set of
conflicts/reverts, which merge history does not label here).

The current surface_overlap warns on declared globs at 27-37% precision (ADR 575). A
branch-diff warning at file level can never warn a pair that did not touch a common
file, so its precision against actual changed files is 100% by construction (no glob
false positives), at the cost of ~8.3 ms/commit and dependence on pushed-branch
freshness. Promoting from file level to hunk level would suppress a further 87.7% of
file-sharing warnings.

## Success gate - this lane's proposal (not ADR 575)

Proposed here (not inherited from ADR 575): promote the default warning from file
level to hunk level only if hunk-level precision is at least 60% and recall within 5
points of file-level recall. On this dataset, hunk-level overlap is 11.9% of
file-sharing pairs, which does not clear that proposed 60% bar by itself. That means
the daemon's own squash-commit history does not currently justify tightening the
default warning to hunk range only. The measurement is taken on squash commits that
already integrated all lines, so it under-counts late conflicts; the branch-overlap
annotation therefore ships as an opt-in board note (branch_overlap) first, and the
gate is re-run after the first 30 days of opt-in data.

## What ADR 575 itself requires (separate gates, not this lane's)

- Decision 3: a measurement before any directed message is sent. This note satisfies
  the cost half; the precision half is partial (overlap fractions, not a labelled
  conflict set) and is recorded as such.
- Eval: glob matcher at 33% precision and recall within 5 points of 61%.
- 30-day experiment: counts lost work after stopping directed messages. A rise in
  merged lanes that redid or reverted a same-time lane's change means the message
  was earning its noise.

## Recommendation

- Keep the board-only surface_overlap warning.
- Add an opt-in branch_overlap annotation, file level default with hunk ranges shown
  but not gating, behind the proposed gate in "Success gate - this lane's proposal".
- Do not deliver a directed act for either kind; ADR 575 section 1 stands.
- Re-run the gate after 30 days of opt-in branch_overlap data.

## Follow-up

Implementation lane opened: 01M531R914FQVS0HHDK8CRVCQR ("Overlap from what branches
change: board hunk-overlap annotation (implementation follow-up)"), claimed by sloane
and linked to goal signals-earn-attention.

That lane owns the concrete work this spike deliberately does not: lane-level cache
keyed on (lane.id, branch, tip SHA), integration into boardWarnings as a
non-directed branch_overlap kind (file level default with hunk ranges shown but not
gating), integration behind a flag, and one round of hunk-gate re-measurement on
opt-in data before any default change. Reuse scripts/research/branch-overlap-measure.ts
for every re-measurement; pin the population with --resolved-before so verdicts stay
reproducible.

Refs ADR-575