# CooperBench flash comparison: pre-registration

**Lane:** `01M6QK11BG` (this page), goal `cooperbench`, asked by nick (2026-11-06 ~05:35Z in session:
"lets do all of this", after the recommendation to stop the act-lane cost series and place musterd on
the benchmark authors' own ground). The run is its own lane. **Status:** pre-registered 2026-11-06,
before any pair of this comparison ran. **Run 2026-11-06 05:23–07:48Z → [finding
035](../035-cooperbench-flash-comparison.md):** C1 musterd vs solo 38 vs 37, no detectable difference;
C2 musterd vs team 38 vs 19, musterd better (p = 4 × 10⁻⁶); C3 team vs solo 19 vs 37, solo better; $54.08.
Attempt 1 aborted on a full disk before any eval and fully re-run; concurrency lowered to 1/2/2 for
attempt 2. Nothing below changes once a measured pair has run.
**CooperBench:** `63b9d44` (upstream `main` on 2026-11-06). Finding **035**.

## Why

Our CooperBench work so far measured musterd against one agent doing both features (`solo`) on the 10
`core` pairs and the claim run's 20, always in CooperBench's `coop` shape (one feature per agent, no
lead): musterd 4/10 against solo 5/10 (finding 018), 5/20 against 6/20 (finding 021), every musterd
loss a task loss, no merge collisions (finding 023: CooperBench's own harnesses collided on 6 and 7 of
10). The paper's claim is that two agents pass about half as often as one; with musterd they pass
about as often as one, one pair short of a claim.

Since then the authors published a **team** harness that beats solo outright: with Codex on GPT-5.5
over the 50-pair `flash` subset, solo 48%, coop 26%, coop + git 56%, team (shared task list, shared
scratchpad, lead/member roles, lead-side integration) 62%, team without its protocol layer 70%; on
`core`, team 6/10 ([report](https://cooperbench-reports.pages.dev/cooperbench/team_harness_ablation_report.html);
`docs/team_harness_ablation_data/*.csv` in their repo). Removing the scratchpad cost 16 of 50 pairs,
removing the task list 11. So "no coordination loss" is no longer the ceiling, and the open question
is where musterd stands against the harness that beats solo, on the same model.

The act-lane cost series (riders 7 and 8, findings 031–034) is **closed** by nick's decision with this
lane: three runs say the act lane does not make a two-agent pair cheaper; ADR 809 and 810 stay.

## Arms

All three on Claude Code 2.1.307 with **`claude-opus-5-5`** (the frontier model Claude Code prices;
checked on the run machine 2026-11-06: all three candidates reachable, Claude Code's reported cost
matches $4/$20 per MTok for Opus 5.5), the 50 `flash` pairs, the docker backend, each arm in its own
published best configuration:

| Arm | Command (abridged) | Configuration |
| --- | --- | --- |
| **solo** | `cooperbench run -s flash -a claude_code --setting solo` | one agent, both features |
| **team** | `cooperbench run -s flash -a claude_code --setting team` | CooperBench's team harness, all five features on (the authors' baseline: task list, scratchpad, MCP, auto-refresh, protocol), no `--git`, as their ablation ran it |
| **musterd** | `cooperbench run -s flash -a claude_code_musterd --setting coop --git` | the musterd arm on the **launch** lane (finding 028's configuration: lanes, the held-file gate, the push event, wait in one call), `MUSTERD_ARM_LANE` unset, `main` at or after this lane's merge |

The arms run **concurrently** in one window so time-of-day API conditions fall on all three alike:
solo `-c 3`, team `-c 2`, musterd `-c 2`, under one `run_arms.py`. Then `cooperbench eval --backend
docker` per arm.

## Rules

Read once from the three arms' complete runs (errors re-run once, in place), pair for pair. A pair
**passes** when CooperBench's eval says both features pass (`both_passed`).

| | Comparison | Claim rule |
| --- | --- | --- |
| **C1** | musterd vs solo | exact two-sided McNemar on the discordant pairs; **p < 0.05** names the better arm; otherwise "no detectable difference at N = 50", with the point difference reported |
| **C2** | musterd vs team | the same rule |
| **C3** | team vs solo | the same rule — whether the authors' team result reproduces on Claude Code |

C1 is the headline: whether musterd's two agents beat, match or trail one agent on the same model.
C2 says whether musterd trails the harness that has a scratchpad and a lead; if it does, the gap
names the features to build (a shared scratchpad per team and an integration role), which is the
conditional third step nick approved with this lane. Reported beside the rules with no rule: pass
rate per arm with a Wilson 95% interval, model dollars per arm and per pass, median wall time per
pair, merge outcome (`identical` / `clean` / `conflicts`) for the two-agent arms, and for musterd the
readout's coordination residue (board reads, sends, edit refusals).

**Pre-registered expectation** (not a rule): solo ≈ team ≈ musterd within ±5 pairs; the authors'
Codex result suggests team ≥ solo.

## Errors

An arm error (an agent `Error` status, an evaluator error, an MCP server absent at start, an API-limit
line) is re-run once under a new run name with its reason recorded; a failed score never is. Three
errors in an arm's first five pairs stop that arm. A pair with an empty patch from every agent is
scored as CooperBench scores it and counted separately ("nothing to apply").

## Smoke (gate before the 150 measured pair-runs)

One pair per arm, `samuelcolvin_dirty_equals_task` 43, features 2 and 3 (a repo none of our runs has
used): each arm must produce a `result.json` with `total_cost` > 0, an eval with per-feature results,
and **at least one non-empty patch** (`test -s`, the check finding 034's smoke gate lacked). The team
arm must show the task list seeded and the scratchpad mounted in its logs; the musterd arm, both seats
joined and a lane claimed. A smoke pair that fails its gate stops that arm until the cause is fixed.

## Spend

Estimated from our own costs on Sonnet 4.5 scaled by Opus 5.5's price (1.33×): solo ≈ $40, musterd
≈ $125, team ≈ $125 (assumed like musterd; unknown on Claude Code) — **about $290**. **Hard stop $400**:
`run_arms.py --cap 370` over every finished pair across all three arms, leaving room for the pairs in
flight (seven at a time, ≈ $4 each). On the launch lane a pair's `result.json` cost is its whole cost
(no wakes), so the guard's count is complete here, unlike finding 034's. Fly: `cb-run-2`, about seven
hours; the deploy token nick kept is valid until ~2026-11-07 07:00Z.

## Procedure

1. Deploy from `main` at or after this lane's merge; pre-flight (api check on `claude-opus-5-5`, both
   host smokes).
2. The three smoke pairs above, concurrently; the gate per arm.
3. Pull the flash images (eleven repos, three new to our runs).
4. `run_arms.py --cap 370` with the three arms concurrently; `cooperbench eval --backend docker` per arm.
5. Errors re-run once; copy the readouts, results, patches and residue into
   `docs/research/cooperbench/pilot-runs/2026-11-06-flash/`; `fly machine stop`.
6. Read C1–C3, finding 035; if C2 reads "team better", open the scratchpad / integration-role lanes.

## Decisions

| Decision | Answer |
| --- | --- |
| Run the comparison, and its spend | nick, 2026-11-06 ~05:35Z, in session ("lets do all of this") |
| Model | `claude-opus-5-5`, all arms (lazara, under that approval: the frontier model Claude Code prices; one model across arms keeps the comparison internal) |
| Act-lane cost series | closed (the same decision) |
| Finding number | 035 |

## Amendment after the run (2026-11-06, big-body's acceptance read)

Recorded after the run, not before it; nothing above is changed.

- **The run started against an open hold.** big-body declined this lane at 04:55Z (machine clock)
  asking that the run be held until the spend rule was made concrete; lazara started the smoke pairs at
  05:03Z without having read it. The decline is answered here and in finding 035, not retroactively.
- **"Hard stop $400" was a soft threshold.** `run_arms.py` polls finished pairs' `result.json` every
  60 s and stops at $370; a pair in flight is not bounded by it, and the "≈ $4 each" reserve for seven
  in-flight pairs was an assumption, not an enforced ceiling. What the run actually exposed: at most
  five pairs in flight (attempt 2: solo 1, team 2, musterd 2), the costliest single pair
  $0.87 (musterd), $0.65 (team), $0.41 (solo), and $54.08 in all, so the
  overshoot past any poll was at most about $4.36 (five pairs × the costliest). A future manifest states the cap as a polled threshold with its authorised
  overshoot, or adds a live per-pair ceiling.
- **Inference.** A non-significant McNemar result is "no detectable difference at N = 50", not evidence
  the arms match; and a musterd-vs-team difference alone does not identify a missing scratchpad or
  integration as its cause. Finding 035's wording follows both.

