# Branch-overlap spike - reading what pushed branches change (ADR 575 section 3)

Lane 01M4S9AVXF6FMDXTMMKHS1WCM9 (follow-up to ADR 575, decision 3).

## Summary

Decision 3 defers the useful overlap signal until it is computed from what contending
lanes' pushed branches actually change, and measured against merge history before it
sends anything. This document is that measurement and cost spike. It ships no product
behavior and sends no directed act.

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

## Cost spike

- The daemon already runs git in sync/rosterRefresh.ts, so git on the daemon host is
  the zero-new-dependency path.
- Cost is O(contending lanes times diff) on board read and on lane_open/lane_claim/
  lane_update. With about eight contending lanes that is tens of small diffs.
- Cache by (lane.id, branch, branch tip SHA). A pushed commit invalidates one lane.
- Recommendation: keep computation on the daemon, recompute lazily on board read.

## Precision measurement plan

1. For each merged lane with a known squash commit, record the file set it touched.
2. For every pair of lanes open at the same time, label overlapped when their real
   touched-file sets intersect, and warned when the hunk matcher fires.
3. Report precision and recall at file level and hunk-range level.
4. Success gate: hunk-level precision at least 60% with recall within 5 points of
   file-level recall.

## Recommendation

- Keep the board-only surface_overlap warning.
- Add an opt-in branch_overlap annotation only after the precision gate passes.
- Do not deliver a directed act; ADR 575 section 1 stands.
- Implementation follows in a later lane.

Refs ADR-575