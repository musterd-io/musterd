# 035 — CooperBench flash comparison: on Opus 5.5, musterd's two agents show no detectable difference from one (38 vs 37 of 50) and beat CooperBench's own team harness (38 vs 19, p < 0.0001)

> **Status:** 2026-11-06, lane 01M6QKA03P (lazara), asked for by nick in session ("lets do all of this",
> 2026-11-06 ~05:35Z). Pre-registered as the [flash comparison manifest](./cooperbench/flash-manifest.md)
> (#3979, before any pair ran). Run 2026-11-06 05:23–07:48Z on `cb-run-2`, image from main `4b52452b`,
> after one smoke pair per arm and one aborted attempt ([run
> log](./cooperbench/pilot-runs/2026-11-06-flash/run.log)). **Read once over the 50 `flash` pairs, all
> three arms on Claude Code 2.1.307 with `claude-opus-5-5`.** **C1** musterd vs solo: **38 vs 37**,
> discordant 2 vs 1, exact McNemar p = 1.0 — **no detectable difference at N = 50**. **C2** musterd vs
> team: **38 vs 19**, discordant 19 vs 0, p = 4 × 10⁻⁶ — **musterd better**. **C3** team vs solo:
> **19 vs 37**, discordant 0 vs 18, p = 8 × 10⁻⁶ — **solo better**. Model dollars: solo $8.74, team
> $16.15, musterd $24.64 ($54.08 with smoke and the aborted attempt, against a $400 stop).

## Question

The paper's headline is that two coding agents pass about half as often as one. Our earlier runs on
the 10 `core` pairs and the claim run's 20 found musterd's two agents one pair behind one agent, every
loss a task loss (findings 018, 021). Since then the authors published a team harness — shared task
list, shared scratchpad, lead and member roles, lead-side integration — that beat solo with Codex on
GPT-5.5 over the 50 `flash` pairs (team 62%, solo 48%). The question: on one model and one harness, where
do musterd's two agents stand against one agent, and against the harness that beat it?

## Setup

The [manifest](./cooperbench/flash-manifest.md): CooperBench `63b9d44` (upstream `main`), the 50 `flash`
pairs, the docker backend, Claude Code 2.1.307, `claude-opus-5-5` in all three arms (checked on the
machine first: reachable, and Claude Code's own `total_cost_usd` prices it at $4/$20 per MTok, so the
spend guard reads real numbers). Three arms run concurrently in one window:

- **solo** — `--setting solo -a claude_code`: one agent does both features.
- **team** — `--setting team -a claude_code`, all five harness features on, no `--git` (the authors'
  baseline configuration).
- **musterd** — `--setting coop --git -a claude_code_musterd` on the launch lane: lanes, the held-file
  gate, the push event, "wait in one call" (finding 028's configuration).

One smoke pair per arm (dirty_equals 43) passed the gate in all three, including a non-empty patch.
**Attempt 1 was aborted** six minutes in: the Docker volume filled, containers failed to install Claude
Code, and the whole attempt — no eval run, no pass result seen — was discarded and every pair re-run
under new names with lower concurrency (solo 1, team 2, musterd 2) and a disk guard; the volume was then
extended online to 120 GB. One musterd pair (outlines 1655 f7,f10) errored at start on a CooperBench
race (its shared git server container was looked up before it existed) and was re-run once, as the
manifest requires; the composite counts the re-run. Every number below is from attempt 2 and is read by
`flashread.py` (in the run folder) from CooperBench's own `eval.json` per pair.

## Results

| Arm | Passed | Rate (Wilson 95%) | Model $ | $ / pair | $ / pass | Median wall / pair | Merge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| solo | **37 / 50** | 74% (60–84%) | $8.74 | $0.17 | $0.24 | 92 s | — |
| team | **19 / 50** | 38% (26–52%) | $16.15 | $0.32 | $0.85 | 122 s | 37 conflicts, 13 clean |
| musterd | **38 / 50** | 76% (63–86%) | $24.64 | $0.49 | $0.65 | 173 s | 50 identical |

### C1 — musterd vs solo: no detectable difference (38 vs 37)

Two pairs pass for musterd and not solo (outlines 1655 f7,f10 — the re-run pair — and dirty_equals 43
f3,f7); one passes for solo and not musterd (huggingface_datasets 3997 f2,f4). Exact McNemar on 2 vs 1:
p = 1.0. Without the re-run pair the count is 37 of 49 against 37 of 50; the verdict is the same. On this
model and these 50 pairs, no difference between musterd's two agents and one agent doing both features
is detectable: the point estimates are one pair apart. That is not evidence the two arms are equal — N =
50 with 3 discordant pairs cannot rule out a gap of several pairs either way — but it is not the halving
the paper reports for two agents, here on the authors' own subset.

### C2 — musterd vs team: musterd better (38 vs 19, p = 4 × 10⁻⁶)

Every one of the team arm's 19 passes is also a musterd pass; musterd passes 19 pairs the team does not.
The team arm's losses have one shape: in **28 of its 50 pairs** CooperBench's eval found the lead's patch
did not carry the member's feature, merged the two agents' patches naively, hit a conflict, and **ran no
tests** (`merge: conflicts, strategy: naive`, both features failed with 0 tests run). In the 9 conflict
pairs that passed, the lead's patch held both features and was scored alone (`strategy: solo-agent1`).
On Claude Code with Opus 5.5 these losses are consistent with the lead not doing the integration the
harness is built around; the eval records show the shape of each loss, not why the lead did not
integrate, and the arm difference alone does not establish that cause. musterd's agents ended all 50 pairs with **identical** patches — each merged the
other's branch through the shared git remote before finishing — so its eval never merged anything.

### C3 — team vs solo: solo better (19 vs 37, p = 8 × 10⁻⁶)

The authors' Codex result (team 62% over solo 48%) does **not** reproduce on Claude Code: the team
harness loses 18 pairs to solo and wins none. Solo itself scores far higher here (74%) than on the
authors' GPT-5.5 run (48%) or the leaderboard's Sonnet 4.5 entry (47%).

### Beside the rules

- **Cost.** musterd costs 2.8× solo per pair ($0.49 vs $0.17) and 2.7× per pass ($0.65 vs $0.24), and
  runs about twice as long per pair (173 s vs 92 s). The coordination is free in passes and not free
  in dollars. The team harness costs 1.9× solo per pair and 3.6× per pass.
- **All three arms failed the same 11 pairs.** These runs show only that; they do not show that some
  other coordination could not have passed them.
- **Errors:** one musterd pair (the git-server race above), re-run once; none in solo or team. No API
  limit line. Spend $54.08 in all — $49.53 for attempt 2 and the re-run, about $3.50 for the aborted
  attempt, $1.07 for the smoke pairs. The manifest's "$400 hard stop" was in fact a threshold polled
  every 60 s over finished pairs ($370); in-flight pairs were not bounded by it, and no bound on the
  overshoot past a poll is claimed. The observed total, $54.08, was far below the threshold.
- **Process.** The run started against an open hold: big-body declined the pre-registration lane at
  04:55Z asking for a concrete spend rule, and lazara started at 05:03Z without having read it. The
  manifest's post-run amendment records it.
- **The readout's `cause:coordination` label on solo is an artifact:** `readout.py` classifies a failed
  pair with no merge as coordination; solo has no partner, so its 13 failures are task failures.

## How far it reaches

- C1 is the strongest result in our CooperBench series: no difference is detectable between two agents
  coordinated by musterd and one agent, on the authors' own 50-pair subset with the model held fixed. It agrees with findings 018 and
  021 (one pair apart on Sonnet 4.5) at a larger N and a higher pass rate. It is a **no-difference**
  result, not a win: 2 vs 1 discordant pairs cannot show musterd is better, and N = 50 cannot rule out a
  difference of a few pairs either way.
- C2 says musterd's arm beat the team harness on this model; the records are consistent with the
  team's lead not integrating (28 naive-merge conflicts with no tests run) while musterd's agents ended
  every pair on the same merged tree. Which harness feature produces that difference is not identified
  by this run. This is one model on one adapter —
  the authors' team harness is tuned on Codex, and this finding does not say it is worse there.
- C3 shows the paper's "curse" is model- and harness-dependent: on Opus 5.5, solo is strong and CooperBench's
  own two-agent harnesses fall well below it, while musterd's does not.
- What remains open is cost: musterd matches solo's passes at 2.8× the price. That is the gap to close
  next, not pass rate. One run, one seed, one model; single pairs flip between runs (finding 021).

## Decision for nick

The conditional third step in the manifest — build a shared scratchpad and an integration role if the
team harness beat musterd — is **not triggered**: musterd beat the team harness by 19 pairs. The numbers
support a public claim of the form "on CooperBench's flash subset, two Claude Code agents coordinated by
musterd showed no detectable difference from one agent (38 vs 37 of 50) and passed twice as often as
CooperBench's own team harness on the same model (38 vs 19, p < 0.0001)", with the cost caveat stated
beside it and no claim of equivalence.
Two things would strengthen it before publishing: a second seed of musterd and solo on flash (about $35)
to show C1 is stable, and the same three arms on a second model (Sonnet 5.5 is cheaper) to show C2 is not
specific to Opus. The open product problem is cost per pass, now 2.7× solo.
