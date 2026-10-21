# CooperBench pilot 3: pre-registration

**Lane:** `01M5G70VZS` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-21,
not yet run. Nothing below changes once a measured pair has run; what the run teaches goes in the
finding, not here. **CooperBench:** `63b9d44`. **Before this:** [pilot 1](./pilot-manifest.md) →
[finding 015](../015-cooperbench-pilot.md), [pilot 2](./pilot2-manifest.md) →
[finding 016](../016-cooperbench-pilot-2.md), both with dated corrections.

## Why a third pilot

Pilots 1 and 2 compared a musterd arm that **could not reach the shared git remote** against arms
that could (the corrections at the top of 015 and 016, lane 01M5G6AGDY). Their scores and verdicts
stand as measured, but neither measured musterd with `--git` working. This pilot is the first in which
both arms have the same remote, checked per pair rather than assumed.

## Question

Unchanged from pilots 1 and 2: on CooperBench's 10-pair `core` subset, with Claude Code on
`claude-sonnet-4-5`, does swapping the coordination layer for musterd close the gap between two agents
and one at least as well as CooperBench's `team` harness, measured on the same machine and day?

## What changed since pilot 2

| Change | Kind | Reaches |
| --- | --- | --- |
| The musterd arm's git URL is the server's bridge IP, and the adapter checks the remote with `git ls-remote` after setup (#3143) | setup | the musterd arm, bringing it to the remote the team arm already had |
| [ADR 697](../../decisions/697-a-hold-hands-over-the-work-not-only-the-turn.md): a lane learns its branch from its edits; the first edit of a file after a hold ends is refused once, naming the holder's branch and commit (#3141) | product | every team |

Because the remote now works, the local `main` pin (#3111) runs in the musterd arm for the first time.
The agents' instructions are **byte-identical to pilots 1 and 2**, and so are CooperBench's prompts
for the team arm.

## Arms, tasks, scoring

As in [pilot 2](./pilot2-manifest.md): **team** and **musterd**, both `--git`, concurrency 3 each,
side by side. The musterd arm runs with the gate in `block` posture over `**`, with ADR 691, 693 and
697 in force. Same ten `core` pairs, CooperBench's unchanged `test_merged` evaluator, one policy for
both arms, nothing re-scored after the fact. The coop arm does not run.

## Measures

Primary, per arm: pass count out of 10, model cost, and wall time.

Secondary, from [`readout.py`](../../../scripts/research/cooperbench/readout.py), with the same rules
as pilot 2:

- merge outcome; whether a pass came from the merged tree or agent1 alone;
- the per-pair cause (setup → coordination → task, the order in the pilot 2 manifest);
- **the shared remote, per agent:** lookup failures and partner-branch merges;
- for the musterd arm: lanes and named common files, `lane.gate` rows by `hold` (`held`, `lapsed`,
  `handover`), what the refused agent did next, shell writes to a named file (a heuristic), and
  **ADR 697's follow rate**: for each hand-over refusal, whether the agent merged a partner branch
  before its next edit;
- cost beside score: musterd cost 2.4× team in pilot 2, and this is reported again.

## Verdict rules, fixed before any run

Unchanged from pilots 1 and 2, read once from the first complete run of each arm:

- **"musterd closes the gap at least as well as CooperBench's team harness"** only if musterd ≥ the
  same-day team arm **and** ≥ 6/10, stated "with the gate in `block` posture".
- Otherwise the two numbers are reported and no such claim is made.
- **ADR 697's own rule** (its Eval): it holds if at least half of hand-overs are followed by a merge
  of the holder's branch before the next edit. It is read only with at least 4 hand-overs.

Either way, the finding names the next product change from the per-pair diagnosis.

## Errors

An **error** is re-run once, with its reason recorded; a failed score is never re-run. In this pilot an
error is any of: container or MCP startup failure, evaluator error, API outage or usage limit, and
**any agent whose shared remote did not work** (the adapter now raises on an unreachable remote, and
the readout also counts any `unable to look up` in a stream). An arm with errors in three of its first
three pairs is stopped, the cause fixed, and the arm re-run whole.

## Procedure

On `musterd-cooperbench` (`performance-8x`, 16 GB, 80 GB volume), in one session. A failed check
stops the procedure before measured spend.

1. **Deploy** from `main` at or after #3143, with `MUSTERD_REF` = that commit.
2. **API check:** one one-word `claude -p` call returns without error, so the account's usage limit
   is not about to cut the run, as it did in pilot 2.
3. **Smoke, under $0.05:** `gate_smoke.py` and `hold_smoke.py` both PASS.
4. **One musterd smoke pair, about $1.30:** `pallets_click` 2068, features 1 and 2, `--git`, scored
   with the evaluator. It passes only if both agents submit, the pair scores, and the readout shows
   **zero lookup failures and at least one `git fetch team` that ran** in each agent's stream. This is
   the check pilots 1 and 2 lacked.
5. **Run both arms side by side,** `-c 3` each, `--no-auto-eval`, then `cooperbench eval --backend
   docker` for each, under a spend watcher.
6. **Re-run errors once** (above), under new run names, so first-run logs stay as recorded.
7. Copy the readout, run log and scripts into `docs/research/cooperbench/pilot-runs/`, then `fly
   machine stop`.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smoke runs | under $0.05 |
| musterd smoke pair | ~$1.30 |
| musterd arm (pilot 2: $32.68) | $25–40 |
| team arm (pilot 2: $13.58) | $10–20 |
| Fly `performance-8x`, about 1.5 h | under $5 |
| **Total model spend** | **about $40–60** |

**Hard stop: $65 of model spend**, counted from step 2, including error re-runs. A run that reaches it
is stopped and reported. The musterd arm may cost more than in pilot 2 now that agents can fetch and
merge; that is measured, not avoided.

## Decisions

| Decision | Answer |
| --- | --- |
| Run a third pilot, after the git remote fix | **yes**: nick, 2026-10-21 ("write it" after the correction) |
| Arms | **team + musterd**, as in pilot 2 (nick, 2026-10-21) |
| Posture | **block**, stated with every result (nick, 2026-10-21) |
| Spend | **$40–60, hard stop $65**: proposed by lazara, to be confirmed by nick before step 1 |
