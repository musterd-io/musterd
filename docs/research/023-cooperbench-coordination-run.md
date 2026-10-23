# 023 — CooperBench coordination run: musterd's agents never collided; CooperBench's harnesses collided on 6 and 7 of 10

> **Status:** 2026-10-23, lane 01M5K1BCVG (lazara), asked for by nick. Pre-registered 2026-10-22
> ([manifest](./cooperbench/coordination-manifest.md)); run and scored 2026-10-23.
> **Verdict: the claim may be stated, for both arms, as pre-registered.** On ten fresh CooperBench
> pairs, musterd's two agents never produced conflicting patches (0/10, 2026-10-22). CooperBench's
> own `team` harness did in **6** and its plain `coop` setting in **7**. Both clear the
> pre-registered bar of 4/10 (one-sided Fisher's exact test, p = 0.0054 and p = 0.0015). Four pairs
> ended in an API error and could not be re-run. They are counted as no conflict, so the numbers above
> are the lower bound, and the verdict does not depend on them.

## Question

On the claim run's ten new tasks, with Claude Code 2.1.307 on `claude-sonnet-4-5` and `--git`, do
CooperBench's own two-agent harnesses end with conflicting patches more often than musterd did?
(Pass rates are a separate question. Five runs left them inside the noise, and finding 021 has the
detail.)

## Setup

As the manifest says. `team` and `coop` (`cooperbench run -s claimnew -a claude_code --git -c 3`) ran
side by side on `musterd-cooperbench` (image `7e795fcb`, Claude Code pinned to 2.1.307), on
2026-10-23 from 00:29Z to 00:53Z. The musterd arm is the claim run's `claim-musterd-new` from
2026-10-22, on the same image and Claude Code version. Each arm was scored with CooperBench's
unchanged evaluator and labelled per pair by `readout.py`, unchanged.

**Pre-flight:** the API check passed. The coop smoke pair (`pallets_click` 2068, features 1 and 2)
had both agents submit and scored without error, at $2.03 against the $0.70 estimate.

**Errors: four pairs, not re-run.** At 00:44–00:49Z the account reached its API usage limit
(*"You have reached your specified API usage limits. You will regain access on 2026-11-01"*). Agents
still running ended `Error`: team on `pallets_click/2956` (both agents), `pallets_jinja/1465` (agent2)
and `react_hook_form/85` (agent1), and coop on `react_hook_form/85` (agent1). The manifest re-runs an
error once, but with the key limited until 2026-11-01 no re-run was possible. The verdict below
counts each errored pair as **no conflict**, which is the case least favourable to the claim. Two of
the four (team 1465, coop 85) had in fact conflicted.

## Result

| Arm | Merge conflicts on a common file | Of which errored | Pass | Model cost | Day |
| --- | --- | --- | --- | --- | --- |
| **musterd** (`block`) | **0 / 10** (all ten byte-identical) | none | 1 / 10 | $18.70 | 2026-10-22 |
| **CooperBench `team`** | **6 / 10** (7 counting the errored 1465) | 3 pairs | 2 / 10 | $14.17 | 2026-10-23 |
| **CooperBench `coop`** | **7 / 10** (8 counting the errored 85) | 1 pair | 1 / 10 | $14.69 | 2026-10-23 |

| Task | musterd | team | coop |
| --- | --- | --- | --- |
| `outlines/1371` | identical | **conflict** | **conflict** |
| `outlines/1706` | identical | **conflict** | **conflict** |
| `dspy/8587` | identical | **conflict** | **conflict** |
| `go_chi/26` | identical | **conflict** (passed on agent1's patch) | **conflict** |
| `datasets/7309` | identical | **conflict** | **conflict** (passed on agent1's patch) |
| `llama_index/18813` | identical | clean | clean |
| `click/2068` | identical | **conflict** (passed on agent1's patch) | **conflict** |
| `click/2956` | identical | error (both agents) | clean |
| `jinja/1465` | identical, **pass** | error (agent2; patches conflicted) | **conflict** |
| `react_hook_form/85` | identical | error (agent1) | error (agent1; patches conflicted) |

Every one of the ten pairs has the two features changing at least one common file, so a conflict was
possible in each.

## Verdict against the pre-registered rules

- **team: 6/10 ≥ 4/10 → claim.** p = 0.0054 against musterd's 0/10.
- **coop: 7/10 ≥ 4/10 → claim.** p = 0.0015.

Stated as the manifest allows: **on ten fresh CooperBench pairs (Claude Code 2.1.307,
`claude-sonnet-4-5`, `--git`, musterd in `block` posture), musterd's agents never produced
conflicting patches. CooperBench's `team` harness did in 6 pairs and its `coop` setting in 7.** The
musterd arm ran the day before the other two. Pilot 3's `core` result for team (6/10, 2026-10-21) is
the same shape, and decides nothing here.

What this does **not** say: that musterd passes more pairs. It passed 1, team 2 and coop 1. A conflict
does not always cost the pair: the evaluator then tests agent1's patch alone, which passed three
times (team `go_chi/26` and `click/2068`, coop `datasets/7309`). The claim is about collisions.

## Secondary measures

- **Coordination losses on pairs one agent can do.** The solo arm passed two of the ten
  (`datasets/7309`, `jinja/1465`). team lost `datasets/7309` to a conflict, and its `jinja/1465`
  errored. coop lost `jinja/1465` to a conflict and passed `datasets/7309` on agent1's patch. musterd
  passed `jinja/1465` and lost `datasets/7309` as a task failure (identical patches failing a suite).
  That is two pairs, and only reported.
- **The agents did fetch each other's work.** In all ten coop pairs both agents merged a partner
  branch at least once (`readout.py`'s `partner_merges`). In team, every member did, and the lead did
  in 7 of 10. The shared remote had no lookup failures in either arm. They collided anyway: each kept
  editing the common file after the merge and submitted its own version. musterd's agents ended on
  one tree because a named file is held by one lane at a time (ADR 691). The second agent edits only
  after the first is done, and is then handed its branch (ADR 697). On these ten pairs the hold
  refused 13 edits, and 9 hand-overs followed (finding 022's table).
- **Cost.** musterd $1.87 a pair against team $1.42 and coop $1.47. That is about 30% more, for zero
  collisions.

## Honest N

Ten pairs per arm. The musterd arm ran on 2026-10-22 and the others on 2026-10-23, all on the same
machine, image and Claude Code. Four pairs errored on the API limit and were not re-run. The verdict
holds with each counted as no conflict. The effect is large enough that ten pairs decide it, which is
why this run cost about $31 where a pass-rate claim would have cost about $190.

## Cost

Model: **$30.91** ($2.03 coop smoke pair, $14.17 team, $14.69 coop), under the $35 stop. Fly: under
an hour. The six CooperBench runs together: about $226 of model spend.

## What it changes

1. **musterd has a CooperBench claim it can make in public**, about the thing it is for. Two agents on
   one repository, with a held file and a hand-over, never collided in 10 fresh pairs (and 20 of 20 in
   the claim run), where CooperBench's own harnesses collided in 6 and 7 of 10. The setting (`block`,
   the model, Claude Code version, `--git`) and the N go with it every time it is quoted.
2. **No pass-rate claim, still.** Collisions are not what decides passes on this benchmark at this
   model; feature correctness is (findings 017, 018, 021).
3. **The API key is limited until 2026-11-01.** Any further run (including the measurement of #3219)
   waits for it, or for a raised limit.

Runs: `docs/research/cooperbench/pilot-runs/2026-10-23-coordination/` (per-pair readout, run log,
script).
