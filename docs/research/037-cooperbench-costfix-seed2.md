# 037 — CooperBench cost-fix run: the lean package could not be tested on CooperBench, and the second seed reads "no detectable difference" again — musterd 35, solo 39 of 50

> **Status:** 2026-11-06, lane 01M6S2NP0X (lazara). Pre-registered as the [cost-fix
> manifest](./cooperbench/costfix-manifest.md) (#4004, before any pair), amended after stage 1 and
> before any stage-2 pair (#4026, committed 20:07:42Z; the stage-2 run started 20:08:36Z). Decisions
> by nick in session: the "Lean package" (question `01M6S3EXTZ`), spend up to $135 (`01M6S3X1MV`),
> "Seed 2 only" after stage 1 (`01M6S786PJ`). Run 2026-11-06 19:21–23:06Z on `cb-run-2`, image from
> main `4a1422cc`, Claude Code 2.1.307, `claude-opus-5-5` ([run
> log](./cooperbench/pilot-runs/2026-11-06-costfix/run.log)). **Stage 1:** gates G1 and G2 failed;
> the lean arm stopped. **K3** (seed 2 of [finding 035](./035-cooperbench-flash-comparison.md)'s C1,
> read once under C1's rule): musterd **35**, solo **39** of 50, discordant **1 vs 5**, exact McNemar
> **p = 0.22** — **no detectable difference at N = 50**. K1 and K2 were withdrawn by the amendment.
> Recorded spend **$45.06**.

## Question

Two questions, pre-registered together. Could [finding 036](./036-cooperbench-flash-cost-split.md)'s
"lean package" — no join call, six unused always-loaded tools removed, one integrator — cut
musterd's cost on CooperBench without losing passes? And does finding 035's C1 (musterd 38, solo 37
of 50; no detectable difference) hold on a second seed?

## Stage 1 — the lean package did not engage

The 10 `core` pairs, baseline and lean concurrently, read only for whether the three changes took
effect ([`gates1.json`](./cooperbench/pilot-runs/2026-11-06-costfix/gates1.json)):

| Gate | Read | Result |
| --- | --- | --- |
| G1 join call gone | 13 of 20 lean sessions still opened with `team_inbox_check` | **failed** |
| G2 one integrator | 0 of 10 pairs had only one agent fetch or merge | **failed** |
| G3 six tools absent | none present (26 musterd tools loaded vs 32) | passed |
| G4 nothing broke | passes lean 5, baseline 6; no merge conflicts | passed |

- **G2 failed because of a design error in the manifest.** CooperBench's own git block, which every
  two-agent arm receives, is headed "MERGE IS REQUIRED BEFORE SUBMITTING" and tells each agent to
  fetch and merge every partner's branch before exiting, because the bench scores each agent's patch
  against every feature. The lean paragraph contradicted the benchmark's submission rule and the
  agents followed the benchmark. One integrator cannot be tested on CooperBench without overriding
  its rule; that should have been caught before pre-registration.
- **G1 failed because musterd's own MCP guidance** tells a seat to start with `team_inbox_check`;
  the arm's prompt alone did not override it in 13 of 20 sessions.
- With the integrator gone, finding 036's illustrative estimates put what was left at roughly 5% —
  too small for K1 to detect at N = 50 (its power was ≈ 0.6–0.85 for a 10% saving). nick chose to
  stop the lean arm and run the second seed only. Stage 1's `core` costs (lean $4.79, baseline $5.47)
  carry no verdict. The lean sessions' first-call context was 1.1k tokens smaller (median 24.4k vs
  25.5k), about what the six schemas weigh.

## K3 — second seed of C1

The 50 `flash` pairs, baseline (finding 035's musterd arm, unchanged) and solo, read once:

| | musterd | solo | musterd-only / solo-only | exact McNemar | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Seed 2 (K3)** | **35** (Wilson 95%: 56–81%) | **39** (65–87%) | **1 / 5** | p = 0.22 | no detectable difference at N = 50 |
| Seed 1 (finding 035 C1) | 38 (63–86%) | 37 (60–84%) | 2 / 1 | p = 1.0 | no detectable difference at N = 50 |

Read by [`k3read.py`](./cooperbench/pilot-runs/2026-11-06-costfix/scripts/k3read.py) →
[`k3.json`](./cooperbench/pilot-runs/2026-11-06-costfix/k3.json), from CooperBench's `eval.json` per
pair; seed 1 is re-read with the same code and matches finding 035.

- **The verdict is the same; the point estimate moved.** Seed 1 had musterd one pair ahead, seed 2
  has solo four ahead. Between seeds, musterd's result flipped on 3 pairs and solo's on 4: single
  pairs move between runs, as finding 021 recorded. Summed over both seeds (descriptive, no rule):
  musterd 73 of 100, solo 76 of 100; discordant 3 vs 6.
- musterd's five seed-2 losses that solo passed: outlines 1655 f6,f7, dspy 8394 f3,f5, click 2068
  f7,f10, jinja 1621 f4,f5, dirty_equals 43 f2,f3. Each failed one feature, mostly by one or two
  tests, with identical patches from both agents (merge `identical`). These records show where the
  arm lost, not why; no coordination cause is read from them.
- **Merges:** 48 identical, 2 `conflicts` (click 2800 f6,f7 and typst 6554 f1,f9, both passed on the
  integrated patch). Seed 1 had 50 identical.

## Cost

| | Model $ | $ / pair | $ / pass | calls / pair |
| --- | --- | --- | --- | --- |
| musterd seed 2 | $24.50 | $0.49 | $0.70 | 24.5 |
| solo seed 2 | $8.95 | $0.18 | $0.23 | 6.3 |
| musterd seed 1 | $24.64 | $0.49 | $0.65 | 25.0 |

musterd costs **2.74×** solo per pair on seed 2 (2.82× on seed 1). Finding 036's split reproduces:
calls issuing musterd tools $9.79 (seed 1: $9.59), integration $2.56 ($2.57), first-call context
median 25.4k tokens ([`costsplit.json`](./cooperbench/pilot-runs/2026-11-06-costfix/costsplit.json)).

## Errors and process

- **The baseline arm's process was OOM-killed** at ~20:26Z after 8 of 50 pairs. The waiter watched
  only for a done marker and stop lines, which a killed process does not write, so it went unnoticed
  for about an hour. The arm was re-run once under the manifest's error rule, alone on the machine,
  with CooperBench skipping pairs that already had results. No eval had been read when this was decided.
- **One stale evaluation caught before the read.** dspy 8394 f3,f4 had errored at start (an npm
  `ETARGET` installing musterd in the container); CooperBench evaluated that empty attempt, and its
  eval skips any pair that already has `eval.json`, so the resumed run's patches were never scored.
  Every eval in all four arms was checked against its run's end time; this was the only stale one.
  Re-evaluated once: it passes. **The count above includes that correction** (34 → 35). The stale
  eval is kept beside the run.
- go_chi 56 f1,f5 failed in the resume on CooperBench's shared git-server race (as finding 035) and
  was re-run once.
- **Spend:** $45.06 recorded across every `costfix*` pair (smoke $1.36, stage 1 $10.26, stage 2
  $33.44 incl. re-runs). The agents of the pairs in flight at the OOM kill ran on in orphaned
  containers until 21:45Z; their spend was never recorded and no figure is claimed.
- The board's dispatcher asked three times during the run whether the lane was still owned: a seat
  waiting on a remote job looks idle from the board. Recorded as product friction, not fixed here.

## What it says

- **C1 holds as a verdict on two seeds: no detectable difference between musterd's two agents and
  one agent, on each seed at N = 50.** It does not hold as a direction: musterd was one pair ahead on
  seed 1 and four behind on seed 2. Finding 035's claim wording — "38 vs 37 of 50" — reports only the
  seed that favoured musterd. **Any public claim should cite both seeds** ("no detectable difference
  on either of two seeds; 73 vs 76 of 100 summed") and keep the cost caveat (2.7–2.8×).
- **The lean package is not a CooperBench experiment.** Its largest piece contradicts the benchmark's
  submission rule, and its second needs a product change to musterd's own guidance. Both are product
  questions now: lane 01M6S7NNK3 (the join call in the MCP guidance) and lane 01M6S7NS8S (the
  always-loaded tool set, which needs revive's own call data and an ADR).
- Cost per pass remains the open problem; this run found no lever inside the arm that CooperBench
  can measure. The remaining coordination is mostly load-bearing (finding 036).

## Limits

One model, one harness, two seeds of 50 pairs. The seed-2 baseline ran in two segments (8 pairs
alongside solo, the other 42 alone after the kill); pass rates are not compared across those
segments. The second seed's flips are within what single-run variation produced before (finding 021).
