# 462 — Wasted work is measured per lane from git: the cookoff collector over PR heads, joined by PR number

- Status: proposed
- Date: 2026-09-28
- Lane: `01M3MJ50PHM6BDKEZGQNN2N2JG` (goal `research-corpus`)
- Builds on: [ADR 123](123-cookoff-measurement-protocol.md) (predicate set v1, unchanged here),
  [ADR 106](106-unified-git-workflow.md) (squash-only merges),
  [ADR 109](109-seat-git-attribution.md) (the seat trailer that survives the squash),
  [ADR 445](445-agent-traces-captured-local-first.md) §Observability (the experiment whose
  wasted-work half this answers), [finding 012](../research/012-trace-e2e-check-one-lane.md).

## Context

Finding 001 put wasted work at about 37% of the code produced in the P3 session, and measured it
from git. ADR 445's §Observability experiment asked for the same number to be rebuilt from
`trace_events` alone. Finding 012 ran that on increment 4b (2026-09-28). The coordination-token half
passed within 0.9%. The wasted-work half cannot pass: 13 of the build's 15 file-writing calls went
through Bash (heredoc replaces, `sed -i`, formatters), so the tool column never sees most of what
was produced. nick asked, the same day, for wasted work to be measured from git per lane, if that
is the best approach.

A git collector already exists. `musterd archaeology` implements ADR 123's frozen predicates (W3
duplicated → W1 abandoned → W2 clobbered → W4 conflict churn) for the cookoff. Its population is
every ref after a kickoff SHA, and a cookoff run ends, so anything not delivered at the end is
waste.

## Problem

Pointed at the dogfood repo, the cookoff collector gives a wrong answer slowly:

1. **The population depends on the Workspace.** `rev-list --all` reads every ref in a `.git` that
   all seats' Workspaces share. On a 2.5-day window (2026-09-26 onward) that was 617 commits, 562 of
   them other seats' local branches, so two seats running the same command could get different
   numbers. It had not finished after 20 minutes.
2. **A live repo has no run end.** Open PRs are work in flight. Counted as W1, three open PRs
   (#1756, #1765, #1772) put miley at 5,284 lines, 100% "abandoned".
3. **Nothing joins lines to lanes.** The report groups by actor. A lane's number needs a key that
   both git and the lane record carry.

And the trace-side alternatives do not reach the files:

- **Tool-column line counts** (finding 012) see only `Edit`/`Write`.
- **A file-snapshot tap**, which diffs the Workspace on every hook, would capture Bash writes. But it
  would re-derive what git already records at every commit, add a filesystem walk to each tool call
  (ADR 445's cost line is "what the gate costs now"), and still miss work done outside a traced
  session.

## Decision

Wasted work per lane is ADR 123's predicate set v1, **unchanged**, evaluated over a new population
and rolled up by PR.

1. **Population `pulls`.** The window holds the delivered range (`rev-list <delivered> --not
   <start>`) plus every commit reachable from a remote-retained PR head (`refs/pull/<n>/head`)
   authored at or after `start`, not already delivered. Local branches are never read. The window
   is bounded by commit time, because squash merges never make a branch an ancestor of `main`, so
   `--not <start>` alone admits every PR's whole history. PR-head objects the clone lacks are fetched
   by SHA with `--no-write-fetch-head`; no ref is written, because a ref namespace in the shared
   `.git` would put about 1,700 heads into every seat's `git log --all`. The cookoff's `all`
   population stays the default and is untouched.
2. **An open PR is in flight, not waste.** GitHub keeps `refs/pull/<n>/merge` only while a PR is
   open; on 2026-09-28 the set of merge refs equalled `gh pr list --state open` exactly. A PR with a
   merge ref is left out of the window entirely (neither authored nor wasted), and the report names
   every PR it left out. A PR closed without merging stays in, and its lines are W1.
3. **The join key is the PR number.** A delivered squash commit carries `(#n)` at the end of its
   subject (ADR 106's squash title); a PR-head commit carries the `n` of the head it was reached
   from, the lowest when stacked heads share it. The lane record carries `merged.pr` from
   `lane_submit`/`lane_resolve`. A clobbered line (W2) is charged to the PR that authored it, which
   is the work that was lost, never to the PR that deleted it.
4. **The window of a lane opens at its claim.** `musterd archaeology --lane <id>` starts from the
   delivered tip as it stood at `claimed_at` and runs to the current delivered tip, so later
   clobbering of the lane's lines still counts against it. `--by-lane` reports every PR in the
   window joined to its lane; a PR no lane attests stays visible as `(no lane)`, never dropped.
5. **Performance, not predicates.** The W3 overlap pass now tests for a shared path before it
   spawns `git merge-base`. The classification is identical; this only skips pairs that could never
   match.

## Consequences

- On the dogfood repo, the `pulls` window from 4b's claim holds 173 commits against 617, and runs in
  about 14 seconds. It read **0.9% wasted (37 of 4,214 authored lines)** team-wide, with 4 open PRs
  left out. Lane 4b read **439 authored, 0 wasted**, and 439 is exactly the non-blank added lines
  of its squash `c5edd14`.
- The number answers finding 001's question for the team's current workflow, and the answer is
  small. It is consistent with the cookoff's enforced arm (finding 006: 1.9%). This is one 2.5-day
  window, not a controlled comparison, so it does not show that enforced lanes caused the drop from
  37%.
- **Honest edge — invisible iteration.** A PR head retains only the last push. Commits amended or
  force-pushed away, and work never pushed, are outside the population. By ADR 123's own rule,
  self-rework is not waste, so the loss is mostly iteration. But a seat that discards a whole
  approach locally and never pushes it wastes work this cannot see. The trace store's tool mix is
  the only witness to that, and it is not a line count.
- **Honest edge — the merge-ref signal.** The open-PR rule rests on GitHub behaviour that is
  observed, not documented as a contract. Falsifier: an open PR with no `refs/pull/<n>/merge` (its
  lines would read as W1), or a closed PR that keeps one (its W1 would go missing). Either shows up
  as a disagreement with `gh pr list --state open`.
- **Honest edge — drift inside one PR.** Under v1, a branch commit's lines that the squash does not
  carry are re-land drift (W4) when at least half its lines match, and abandoned (W1) otherwise.
  Revising your own lines inside one PR therefore reads as a few lines of W4, as it did for the
  20 W4 lines in the window above. Changing that is a predicate set v2 and needs its own ADR; this
  one keeps v1 frozen so that lane numbers and cookoff numbers stay comparable.
- ADR 445's §Observability experiment gets its wasted-work half from here, not from `trace_events`.
  Recorded as a dated note on ADR 445.
- The collector still reads the lane board through the daemon only when asked to group by lane;
  the cookoff path stays daemon-free.

## Observability & Evaluation

- **Traces:** n/a — the collector reads git and the lane board once, and emits no spans; its output
  is the report itself.
- **Eval:** `musterd archaeology --by-lane --start <sha> --delivered origin/main` over a window,
  with a per-lane rate and the W-class split. Regression anchor: lane 4b (`01M3FEB12R`, PR #1757)
  reads 439 authored lines and 0 wasted from its claim.
- **Tests:** an integration test builds an origin with a squash-merged two-commit PR, a
  closed-unmerged PR, and an open PR with a merge ref. It clones with `--no-local` so no PR head
  object is present, adds a local non-PR branch, and asserts: the local branch and the open PR are
  absent, `inFlightPrs` is `[3]`, the squash's drift is W4 on #1, and the closed PR's line is W1 on
  #2.
- **Experiment:** run `--by-lane` weekly for four weeks over the research-corpus window and set
  each lane's rate beside finding 001's 37%. Falsifier for the approach: a lane whose hand-counted
  discarded work (a closed PR, a reverted squash) the report misses or misclassifies.
