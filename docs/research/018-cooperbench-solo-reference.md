# 018 — CooperBench solo reference: one agent 5/10, one pair ahead of musterd's two

> **Status:** 2026-10-21, lane 01M5GCF88Z (lazara). Pre-registered 2026-10-21
> ([manifest](./cooperbench/solo-manifest.md)); run and scored the same day.
> **Verdict: inconclusive, as pre-registered.** One Claude Code agent doing both features passed
> **5/10**. Pilot 3's musterd arm passed 4/10. Solo = musterd + 1 is the manifest's "no claim at this
> N" case. **The per-pair overlap is the result:** every pair musterd passed, solo passed too, and of
> musterd's six feature losses, solo also fails five.

## Question

CooperBench measures the gap between two agents (one feature each) and one agent (both features).
Pilots 1–3 measured only the two-agent side. On the same 10-pair `core` subset, with Claude Code on
`claude-sonnet-4-5`, how many pairs does one agent pass, and how does that compare with musterd's
4/10 in [finding 017](./017-cooperbench-pilot-3.md)?

## Setup

As the manifest says: `cooperbench run -s core --setting solo -a claude_code -m claude-sonnet-4-5 -c 3`
on `musterd-cooperbench`, the image of pilot 3 (`ebbd2f2e`). Scored with CooperBench's own
`test_solo`, so the one patch is tested against each feature's suite. CooperBench's own solo prompt
was used, unchanged. The comparison is with pilot 3's arms, run the same day about an hour earlier
(nick's choice, to save about $38).

**Two deviations, both in the run script, neither in a measured pair.** (1) The API check's first call
returned empty while the machine was starting; a retry answered normally. (2) The smoke pair
(`pallets_click` 2068, $0.48) submitted and scored with no evaluator error, which meets the
pre-registered criterion. But the script's check read the coop/team result shape (`agents`) where a
solo result has one `agent`, printed nothing, and stopped the run as `SMOKE FAIL`. The check was
fixed, the smoke was not re-run (its pass was confirmed by hand from `result.json` and
`eval_summary.json`), and the ten pairs started at 23:37Z. No measured pair errored, and none was
re-run.

## Result

| Arm | Pass | Model cost | Day |
| --- | --- | --- | --- |
| **solo** (one Claude Code agent, both features) | **5 / 10** | $6.12 | 2026-10-21, 23:37Z |
| musterd (pilot 3, two agents, `block`) | 4 / 10 | $24.59 | 2026-10-21, 22:19Z |
| team (pilot 3, CooperBench's harness) | 2 / 10 | $13.76 | 2026-10-21, 22:19Z |

| Task | solo | musterd | team |
| --- | --- | --- | --- |
| `outlines/1655` | **pass** | **pass** | **pass** |
| `jinja/1559` | **pass** | **pass** | **pass** |
| `jinja/1621` | **pass** | **pass** | coordination |
| `typst/6554` | **pass** | **pass** | coordination |
| `tiktoken/0` | **pass** | task | coordination |
| `dspy/8563` | fail | task | task |
| `go_chi/27` | fail | task | coordination |
| `llama_index/17244` | fail | task | coordination |
| `click/2800` | fail | task | task |
| `react_hook_form/153` | fail | task | coordination |

## What the pairs show

**Where two musterd agents pass, one agent passes.** musterd's four passes are a subset of solo's five.
Coordination did not cost a single pair that one agent could do and musterd could not, with the one
exception below.

**Five of musterd's six losses are pairs one agent fails too.** dspy, go_chi, llama_index, click and
react_hook_form fail in all three arms, and three of them fail every framework in CooperBench's own
table. On these, the agent cannot write a passing feature whether or not it has to coordinate.

**One pair, tiktoken, is a pair one agent gets and two do not.** Solo passes it; musterd's agents
merged to identical patches and failed a feature suite (finding 017: f1 0 passed / 1 failed). That is
the only place on this subset where splitting the work cost a pass. It is one pair, so it is noise
until it repeats.

**The team harness is three pairs behind one agent:** jinja/1621 and typst, which solo and musterd pass,
are merge conflicts in `team`, and so is tiktoken.

**Cost.** One agent cost $6.12 for the ten pairs. musterd's two cost $24.59, four times as much, and
team's $13.76. That ratio is part of the honest picture: on this subset, musterd buys back
coordination losses at four times one agent's cost.

## Verdict against the pre-registered rules

`S = 5`, `M = 4`, so `S = M + 1`. **Inconclusive at this N, no claim.** Neither "musterd's two agents
match one agent" (needs `M ≥ S`) nor "a gap remains" (needs `S ≥ M + 2`) may be stated. The team
arm's 2/10 is reported, and no rule reads it.

## Honest N

Ten pairs and one run per arm. Solo ran an hour after the two-agent arms on the same machine, image and
model, so the comparison is near-same-day, not same-run. One pair separates solo from musterd, and
that pair is the whole of the difference.

## Cost

Model: $6.60 ($0.48 smoke pair, $6.12 for the arm), well under the $25 stop. Fly: about 30 minutes.
The four CooperBench runs together: about $146 of model spend.

## What it changes

1. **The question CooperBench asks now has a near answer on this subset.** musterd's two agents are
   one pair short of one agent, and every musterd pass is a solo pass. It is not a claim. What would
   make it one is more pairs: the full dataset, or pilot 3 and solo re-run for N = 20.
2. **The feature-correctness ADR is not aimed at CooperBench.** Five of musterd's six losses are pairs
   one agent fails too, so no coordination product wins them. It is worth building only if it helps a
   real team, judged on its own; this benchmark does not motivate it.
3. **The open cost is the 4×.** On this subset musterd's coordination is close to free in passes and
   expensive in dollars. Steps per agent (waiting on holds, merging twice) are where to look.
4. **Fix in `solo.sh`:** the smoke check now reads the solo result shape.

Runs: `docs/research/cooperbench/pilot-runs/2026-10-21-solo/` (per-pair readout, run log, script).
