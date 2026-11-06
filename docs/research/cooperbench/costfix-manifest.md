# CooperBench cost fix: pre-registration — the lean arm against the launch-lane arm, and a second seed of finding 035's C1

**Lane:** `01M6S2NP0X` (this page), goal `coordination-cost`, asked by nick (2026-11-06, in answer to
question `01M6S3EXTZ`: "Lean package"). The run is its own lane. **Status:** pre-registered
2026-11-06, before any pair of this run. Spend approved by nick up to $135 (question `01M6S3X1MV`). Nothing below
changes once a measured pair has run.
**CooperBench:** `63b9d44`, as finding 035. Finding number on read: the next free one.

## Why

[Finding 035](../035-cooperbench-flash-comparison.md): on the 50 `flash` pairs with Opus 5.5, musterd's
two agents passed as often as one (38 vs 37) at 2.8× the model dollars. [Finding
036](../036-cooperbench-flash-cost-split.md) split that cost call by call: the feature work is not
duplicated; the gap is turns — coordination calls, a 7.1k-token heavier preamble, a second final
answer, and both agents integrating. It also showed most coordination is load-bearing: 187 of 218
waits returned a partner's act, and 48 of 50 pairs opened overlapping lanes.

Three things in the arm's turns are not load-bearing, and nick chose to test them together as one
package ("Lean package"):

1. **The stale join call.** The prompt makes `team_inbox_check` the first action "which joins you to
   the team"; since ADR 707 the MCP server joins at session start. 100 first calls, about $0.79 of
   reads and output across the arm (their one-time context write moves to the next call, not away).
2. **Six always-loaded tools no seat called** — `team_join`, `team_status`, `team_next`,
   `lane_claim`, `team_memory_read`, `team_memory_save` (≈ 3.1 KB of schema in every call). The arm
   removes them with `--disallowedTools`; this measures what a product change to the up-front set
   would buy before one is designed (ADR 741 chose that set on revive's own sessions).
3. **Two integrators.** In 49 of 49 pairs both agents fetched, merged and pushed ($2.57). The lean
   prompt names one: the agent that finishes second merges the first's pushed branch, leaving the
   first agent's lines unchanged, so CooperBench's merge of the two patches sees identical hunks.

Finding 036's illustrative estimates (not bounds: a descriptive split cannot say what removing a
behaviour saves) put the package at roughly **8–12% of the arm's cost** — not parity with solo.
This run is worth doing because each piece is a fix for every team if it holds, and because the
same window buys the second seed finding 035's C1 needs before a public claim (lane `01M6S2P0T9`).

## Arms

All on Claude Code 2.1.307 with **`claude-opus-5-5`**, the docker backend, `--setting coop --git` for
the two musterd arms:

| Arm | Command (abridged) | What differs |
| --- | --- | --- |
| **baseline** | `cooperbench run -a claude_code_musterd --setting coop --git` | finding 035's musterd arm, unchanged (launch lane) |
| **lean** | the same with `MUSTERD_ARM_LEAN=1` | `musterd_block(lean=True)`: step 1 says the seat already joined; a paragraph names one integrator; `--disallowedTools` adds `config.LEAN_DISALLOWED` |
| **solo** (stage 2 only) | `cooperbench run -a claude_code --setting solo` | as finding 035 |

The lean block keeps the coop block's shape (four steps, one fence, the same last line;
`test_prompt.py`), and the baseline text is byte-identical to finding 035's.

## Stage 1 — `core`, development (not read for cost)

The 10 `core` pairs, baseline and lean concurrently (`-c 2` each). This stage exists so the lean text
is developed away from `flash`; **no cost or pass verdict is read from it.** It gates stage 2 on the
three mechanisms engaging, read from the transcripts:

| Gate | Passes when |
| --- | --- |
| G1 join call gone | ≤ 2 of the lean arm's 20 sessions open with `team_inbox_check` |
| G2 one integrator | in ≥ 7 of 10 lean pairs at most one agent runs `git fetch`/`merge` of its partner's branch |
| G3 tools absent | none of the six tools appears in any lean session's `init` tool list |
| G4 nothing broke | lean passes ≥ baseline − 2 of 10, and lean's merge outcome is `conflicts` in ≤ 2 pairs |

If a gate fails, **one** text revision of the lean block is allowed, recorded here as an amendment
with its reason, and stage 1's lean arm re-runs once on `core`. A second failure stops the run; the
finding reports what did not engage.

## Stage 2 — `flash`, confirmatory (read once)

The 50 `flash` pairs, **baseline, lean and solo concurrently** (`-c 2`, `-c 2`, `-c 1`), so each pair's
three runs share an API window. Errors re-run once under a new run name, as finding 035.

| | Comparison | Rule |
| --- | --- | --- |
| **K1** (primary) | lean vs baseline, model $ per pair | two-sided paired sign-flip permutation test on the per-pair difference (100,000 flips, seed 36); **p < 0.05** names the cheaper arm; the mean % change is reported with a paired bootstrap 95% interval (10,000 resamples, seed 36) |
| **K2** | lean vs baseline, passes | **lean keeps passes** if lean ≥ baseline − 3 of 50; exact McNemar reported beside it, no claim from it alone |
| **K3** | baseline vs solo, passes | finding 035's C1 rule, unchanged: exact two-sided McNemar, p < 0.05 names the better arm, else "no detectable difference at N = 50" — **the second seed of C1** |

**Verdict.** The package is carried into product lanes (an ADR on the up-front tool set; the join
step in the product's own guidance; an integration line) **only if K1 names lean cheaper and K2
holds.** K1 cheaper with K2 failing reads "cheaper by losing passes" and nothing is carried. K3 is
read regardless and reported with finding 035's C1 beside it; the public-claim wording in finding 035
is revisited only if K3 differs from C1.

**Power, stated before the run.** Finding 035's musterd per-pair cost: mean $0.493, sd $0.111. A 10%
saving is $0.049 per pair. If the two arms' per-pair costs correlate at ρ ≈ 0.5, the paired difference
has sd ≈ $0.11 and K1 detects it with power ≈ 0.85; at ρ = 0, power ≈ 0.6. A K1 "no detectable
difference" is therefore weak evidence against a ~10% saving, and the finding says so.

**Pre-registered expectation** (not a rule): lean 8–12% cheaper per pair; passes within ±3; K3 again
within ±3 pairs.

Reported beside the rules, no rule: finding 036's split (`costsplit.py`) for all three arms; calls per
pair; first-call context; the G1–G3 mechanism counts on `flash`; merge outcomes; $ per pass.

## Smoke

One pair per arm, `samuelcolvin_dirty_equals_task` 43 f2,f3 (finding 035's smoke pair): `result.json`
with `total_cost` > 0, an eval with per-feature results, a non-empty patch (`test -s`), both musterd
seats joined and a lane opened; for lean, the six tools absent from the `init` tool list. A failed
smoke stops that arm until fixed.

## Spend

From finding 035's actuals on Opus 5.5 (flash per pair: musterd $0.49, solo $0.17). `core` pairs have
not run on Opus 5.5; assumed up to 2.5× a flash pair.

| Item | Estimate |
| --- | --- |
| Stage 1: baseline + lean on 10 `core` pairs | $10–25 |
| Possible stage-1 lean re-run | $5–12 |
| Smoke, 3 pairs | ~$1.50 |
| Stage 2: baseline $25 + lean ~$22 + solo $9 | ~$56 |
| **Total** | **~$70–95** |

**Spend threshold $110**, polled: `run_arms.py --cap 110` every 60 s over every finished `costfix*` pair
(`result.json` costs; on the launch lane a pair's cost is its whole cost). A pair in flight is not
bounded by the poll; **authorised overshoot past the threshold: $25** (at most five pairs in flight;
finding 035's costliest pair was $0.87, so $25 is a wide margin, not a derived bound). Approval asked
for: **up to $135** in all. Fly `cb-run-2` (`musterd-cooperbench`), about four hours; the deploy token
expires ~2026-11-07 07:00Z — if the run cannot finish before then it waits for a new token.

## Procedure

1. **Wait for nick's spend approval and any review hold on this lane** — read the inbox before the
   first paid pair (finding 035's process lesson).
2. Deploy from `main` at or after this lane's merge; pre-flight (api check on `claude-opus-5-5`).
3. Smoke, three arms concurrently; gate per arm.
4. Stage 1 on `core`; read G1–G4 from the transcripts with `costsplit.py` and a gate script committed
   with the readout; at most one amendment and lean re-run.
5. Stage 2 on `flash` under one `run_arms.py --cap 110`; `cooperbench eval --backend docker` per arm.
6. Copy readouts, results, patches and the split into `pilot-runs/<date>-costfix/`; `fly machine stop`.
7. Read K1–K3 once; write the finding.

## Decisions

| Decision | Answer |
| --- | --- |
| What to test | nick, 2026-11-06, question `01M6S3EXTZ`: "Lean package" (over a hand-off arm and bigger tasks first) |
| Fold in the C1 second seed (baseline + solo on flash) | lazara, proposed here: the baseline arm is needed concurrently for K1 anyway; solo adds ~$9 |
| Model | `claude-opus-5-5`, all arms (as finding 035) |
| Spend | nick, 2026-11-06 ~19:05Z, question `01M6S3X1MV` (verified app answer): "Approve up to $135" |

## Amendment after stage 1 (2026-11-06 20:07Z) — the lean arm stops; stage 2 runs seed 2 only

Recorded after stage 1 and **before any stage-2 pair** (committed 20:07:42Z; the seed-2 run started 20:08:36Z by the run machine's clock); nothing above is changed.

- **Stage 1 ran** 19:25–20:00Z on main `4a1422cc` (smoke 19:21Z: all three arms passed the gate;
  lean sessions loaded 26 musterd tools against baseline's 32). `core`: baseline $5.47, lean $4.79
  (no verdict is read from these). **Gates** (`gates1.json`): **G1 failed** — 13 of 20 lean sessions
  still opened with `team_inbox_check`; **G2 failed** — in 0 of 10 pairs did only one agent fetch or
  merge; G3 passed (none of the six tools present); G4 passed (passes lean 5, baseline 6; no merge
  conflicts). Spend $11.61 including the smoke.
- **Why G2 failed — a design error in this manifest.** CooperBench's own git block (`_git_block`, at
  `63b9d44`), which every two-agent arm receives, is headed "MERGE IS REQUIRED BEFORE SUBMITTING" and
  tells each agent to fetch and merge every partner's branch "verbatim before exiting", because the
  bench scores each agent's patch against every feature. The lean paragraph contradicted the
  benchmark's submission rule; the agents followed the benchmark. One integrator cannot be tested on
  CooperBench without overriding its rule, which would tune the arm to the harness rather than fix
  musterd. It should have been caught before pre-registration.
- **Why G1 failed.** musterd's own MCP server instructions tell a seat to get on the team with
  `team_inbox_check` first; the arm text alone did not override it in 13 of 20 sessions. The fix, if
  any, belongs in the product's guidance, not the arm.
- **Decision (nick, question `01M6S786PJ`, verified app answer, "Seed 2 only"):** the lean arm stops;
  no revision is run. Without the integrator the package is worth roughly 5% by finding 036's
  illustrative estimates, which K1 could not detect at N = 50. **Stage 2 runs baseline and solo only**
  on the 50 `flash` pairs (`costfix2-base`, `costfix2-solo`, `-c 2` / `-c 1`, the threshold unchanged
  at $110 over every `costfix*` pair). **K1 and K2 are withdrawn; K3 is read exactly as written above.**
  The join-call guidance and the up-front tool set go to product lanes, judged on mechanism.
