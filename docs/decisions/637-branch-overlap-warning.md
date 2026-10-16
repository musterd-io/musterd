# 637 - branch_overlap is a board-only, non-directed warning, computed from changed files

- Status: accepted
- Date: 2026-10-16
- Deciders: sloane (resident seat pilot, pass 3)
- Lane: 01M531R914FQVS0HHDK8CRVCQR

Amends: ADR 575 (decision 3).

## Context

ADR 575 decision 3 deferred the useful overlap signal until it is computed from what
contending lanes pushed branches actually change, and measured against merge history
before any directed message is sent. The spike (docs/design/branch-overlap-spike.md
plus scripts/research/branch-overlap-measure.ts) measured, on this daemon:
146 merged lanes, 4381 concurrently-open pairs, 470 sharing a file (10.73%), 56 of
those also overlapping at a hunk range (11.9%). File-level git diff takes 8.5 ms per
commit; the hunk parse adds ~1.14x.

A file-level branch comparison warns only where two lanes truly touched a common file,
so its precision against actual changed files is 100% by construction (no glob
false positives). The hunk level is tighter still.

This follow-up ships the annotation the measurement anticipated, and nothing more.

## Problem

Today laneWarnings surfaces only surface_overlap, which compares declared globs. It
cannot say whether two lanes really edited the same file. The board's job is to show
the stronger signal once it is cheap and safe; today it does not.

## Decision

1. A new warning kind, branch_overlap, joins LaneWarning.kind. It is advisory only,
   board-level, and never a directed act. ADR 575 section 1 (warnings are not
   messages) is restated for this kind and unchanged.
2. File level first. branch_overlap compares the changed file sets of the two lanes
   branch values against the same origin/main merge-base. It does not require matching
   hunk ranges; the hunk-level variant stays deferred behind the precision gate in the
   spike (hunk precision at least 60% at recall within 5 points of file-level
   recall). The gate has not been met, so hunk ranges are a future increment.
3. Guarded by environment. Branch resolution runs only when a repository root is
   available to the daemon (MUSTERD_REPO_ROOT, or the daemon's own checkout when it
   carries both lane.branch refs). A lane with branch null, or a host without git
   access, simply yields no branch_overlap. The existing surface_overlap warning
   continues to ship in all cases.
4. Computed lazily, cached per lane. Each laneWarnings call for a branch-backed pair
   computes the shared changed-file set at most once per (lane.id, branch, tip SHA)
   triple and reuses it for the board read that follows.
5. Opt-in for v1. The kind is defined in the protocol now, and is emitted only when
   MUSTERD_BRANCH_OVERLAP=1 is set in the daemon environment. Default off. With the
   flag on, every emitted branch_overlap is keyed the same way as surface_overlap so
   the board dedupes a pair once per kind.

## Consequences

- The protocol gains one enum value (branch_overlap). Consumers that switch on
  LaneWarning.kind and do not handle it fall through to render the detail, which is
  the safe default.
- A second, tighter signal is available on the board without waking anyone. It cannot
  add noise to the inbox, since there is no directed act.
- Defaults are unchanged: teams that do not set the flag see no behaviour difference.
- A daemon without git (for example a pure-Postgres Cloud runner with no checkout)
  gets surface_overlap only. That is a documented, non-fatal degradation.

## Observability & Evaluation

Traces: none new. branch_overlap is an ordinary LaneWarning already returned by
laneWarnings / boardWarnings and already rendered on the board. Counts land in the
existing per-board metrics.

Eval: the precision gate from the spike, hunk-level at least 60% at recall within 5
points of file-level recall before hunk ranges replace file sets. The 30-day opt-in
window is the collection period.

Experiment: ADR 575's falsifier applies unchanged. If work was lost to overlaps the
messages would have prevented, it shows as a merged lane that redid or reverted a
same-time lane's change. Count those in the 30 days after this ships against the 30
days before. A rise means the message was earning its noise.