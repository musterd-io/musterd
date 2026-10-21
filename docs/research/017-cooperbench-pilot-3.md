# 017 — CooperBench pilot 3: with the remote working, musterd's pairs stop colliding

> **Status:** 2026-10-21, lane 01M5G70VZS (lazara). Pre-registered 2026-10-21
> ([manifest](./cooperbench/pilot3-manifest.md)); run and scored the same day.
> **Verdict: no "closes the gap" claim.** musterd scored **4/10** and CooperBench's `team` harness
> **2/10** on the same machine and day. The first rule needs musterd ≥ team **and** ≥ 6/10; the floor
> fails. **The per-pair causes are the result:** musterd lost **no** pair to coordination, team lost
> six.

## Question

As in [015](./015-cooperbench-pilot.md) and [016](./016-cooperbench-pilot-2.md): on CooperBench's
10-pair `core` subset, with Claude Code on `claude-sonnet-4-5`, does swapping the coordination layer
for musterd close the gap between two agents and one at least as well as CooperBench's `team`
harness, measured on the same day? This is the first pilot where both arms had the shared git remote:
pilots 1 and 2 ran musterd without it (the corrections in 015 and 016).

## Setup

Exactly the [manifest](./cooperbench/pilot3-manifest.md): `team` and `claude_code_musterd`, both
`--git`, `-c 3` each, side by side on `musterd-cooperbench` (`performance-8x`), musterd `ebbd2f2e`.
The musterd arm ran the gate in `block` over `**` with ADR 691, 693 and
[697](../decisions/697-a-hold-hands-over-the-work-not-only-the-turn.md) in force. The agents'
instructions were byte-identical to pilots 1 and 2. Eval: CooperBench's unchanged `test_merged`.
Records: [`readout.py`](../../scripts/research/cooperbench/readout.py).

Pre-flight, all before measured spend:

- **API check:** one call, no error.
- **`gate_smoke.py`:** PASS.
- **`hold_smoke.py` as committed FAILs on main since ADR 697.** After the hold lapses, the waiting
  seat's first edit is now the hand-over refusal, not the lapse advisory the smoke expects. A copy
  changed only in that expectation (a fourth step, plus the `handover` deny where the `lapsed` warn
  was) PASSED ($0.009): held, hand-over, then allowed. The file is in big-body's lane `01M5G2PCFW`,
  which has been told the fix; it was not edited here.
- **The musterd smoke pair** (`pallets_click` 2068, $2.85) showed no lookup failures. Both agents
  fetched, pushed and merged each other's branch (`[new branch] agent2 -> team/agent2`), and
  submitted identical patches. Its checker printed `SMOKE FAIL` because its fetch regex missed the
  stream's JSON escaping. The pre-registered criterion (no lookup failure, at least one fetch that ran
  per agent) was checked by hand from the streams and met.

No pair errored. No agent in either arm saw a remote lookup failure (`git_remote_error` 0 of 20 pairs),
and none hit the API limit. No pair was re-run.

## Result

| Arm | Pass | Model cost | Run |
| --- | --- | --- | --- |
| `claude_code_musterd` (coop + musterd, `block`) | **4 / 10** | $24.59 | `p3-musterd` |
| `claude_code` in `team` (CooperBench) | **2 / 10** | $13.76 | `p3-team` |

Per pair. Cause is the manifest's class from `readout.py`; tests are passed/failed for features 1 · 2.

| Task | musterd | merge | tests | team | merge | tests |
| --- | --- | --- | --- | --- | --- | --- |
| `outlines/1655` | **pass** | identical | 95/0 · 87/0 | **pass** | clean | 95/0 · 87/0 |
| `dspy/8563` | task | identical | 45/5 · 59/0 | task | clean | 43/7 · 59/0 |
| `go_chi/27` | task | identical | 0/0 · 4/0 | coordination | conflicts | — |
| `llama_index/17244` | task | identical | 13/0 · 13/1 | coordination | conflicts | — |
| `tiktoken/0` | task | identical | 0/1 · 1/0 | coordination | conflicts | — |
| `click/2800` | task | clean | 68/0 · 76/1 | task | clean | 68/0 · 76/1 |
| `jinja/1559` | **pass** | identical | 57/0 · 55/0 | **pass** | clean | 57/0 · 55/0 |
| `jinja/1621` | **pass** | identical | 49/0 · 55/0 | coordination | conflicts | — |
| `react_hook_form/153` | task | identical | 20/0 · 0/0 | coordination | conflicts | — |
| `typst/6554` | **pass** | identical | 1/0 · 1/0 | coordination | conflicts | — |

## What the pairs show

**musterd's pairs stopped colliding.** In nine of ten musterd pairs the two agents submitted
byte-identical patches, and the tenth merged clean. In every musterd pair both agents merged the
other's branch at least once. The hold fired in all ten pairs (18 `held` refusals). The team arm's
six coordination losses are all naive-merge conflicts on the one shared file, the collision finding
015 started from.

**What musterd lost, it lost on the features.** All six musterd failures are a feature suite failing
on a merged tree. Three are the same as the team arm's (dspy and click fail the same tests in both
arms; go_chi fails every framework in CooperBench's own table). The other three (llama_index,
tiktoken, react_hook_form) fail one suite by a test or two, or did not build it. Coordination got
both features into one tree; it did not make them correct.

**ADR 697's hand-over was read, and mostly not acted on.** Seven hand-over refusals fired, one per
pair in seven pairs. After one of them the agent merged the holder's branch before its next edit;
after six it did not. ADR 697's rule (at least half) **fails**. The agents did merge partner
branches, but at other moments, typically when a message said "done". By its own text, the next step
would be the hook-side ancestry check ADR 697 rejected. With no coordination losses left in this arm,
that is not where the next pair comes from.

**Cost.** musterd cost 1.8× the team arm ($24.59 against $13.76), and its agents took about twice the
steps (79–178 per pair against 37–135). Waiting on holds and merging twice are part of that.

## Verdict against the pre-registered rules

- "closes the gap at least as well as CooperBench's team harness": musterd 4 ≥ team 2 holds; **≥ 6/10
  fails. Not made.** With the gate in `block` posture.
- ADR 697's follow rate: **1 of 7, below half. The rule fails.**

## Honest N

Ten pairs, one run per arm, one model. A two-pair lead over team is a direction, not an effect size.
The firmer result is the split of causes, 0 coordination losses against 6, and even that is ten pairs.
The team arm's 2/10 is again far under its published 5/10 (which ran without `--git`), so the number to
compare against is the same-day one.

## Cost

Model: $41.21 for pilot 3 (smoke pair $2.85, the two arms $38.36), plus about $0.02 of smoke runs.
That is inside the $40–60 estimate and under the $65 stop. Fly: about 1 h of `performance-8x`. All
three pilots together: about $140 of model spend.

## What it changes

1. **No "closes the gap" claim**, but the first measurement where the coordination layer is not the
   reason pairs fail. The `cooperbench` goal's outcome stays unstated until a pilot reaches the floor.
2. **The next score is in feature correctness, not coordination.** The remaining musterd losses are
   suites that fail on a clean merged tree. What a real team would want there is product, not
   prompting: for example, a lane whose acceptance asks for the feature's tests to pass on the merged
   tree before submit. That is a design question for an ADR, not a bench tweak, and it is the
   candidate for the next pilot's one change.
3. **ADR 697's hand-over stays, its stricter step does not follow yet.** Its rule failed (1 of 7), but
   no pair was lost to the gap it targets. The finding is recorded in the ADR's Consequences.
4. **Two smoke tools need fixing:** `hold_smoke.py` for ADR 697 (big-body's lane), and the smoke-pair
   fetch regex (`smoke3.sh`, kept with the run scripts).
5. **musterd's cost is now measured on even ground:** 1.8× the team arm.

Runs: `docs/research/cooperbench/pilot-runs/2026-10-21-pilot3/` (readout, run log, run scripts).
Pair logs, daemon databases and streams are on the run machine's volume under `/data/runs/logs/p3-*`.
