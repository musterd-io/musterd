# CooperBench solo reference: pre-registration

**Lane:** `01M5GCF88Z` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-21,
not yet run. Nothing below changes once a measured pair has run; what the run teaches goes in the
finding, not here. **CooperBench:** `63b9d44`. **Reads with:** [finding 017](../017-cooperbench-pilot-3.md).

## Why

CooperBench measures the gap between **two agents** each given one feature and **one agent** given
both. Three pilots measured the two-agent side (musterd and CooperBench's `team` harness). None
measured the one-agent side: the 6/10 floor in the verdict rules came from beating `team`'s published
5/10, not from a solo number. Pilot 3 ended with musterd at 4/10 and no pair lost to coordination,
every loss a feature failing its tests on a merged tree. Whether those are coordination's cost or the
model's limit is what a solo run says, and it decides the next product change.

## Question

On the same 10-pair `core` subset, with Claude Code on `claude-sonnet-4-5`, how many pairs does **one**
agent pass when it implements both features itself, and how does that compare with pilot 3's musterd
arm (4/10)?

## Arm

One: `cooperbench run -s core --setting solo -a claude_code -m claude-sonnet-4-5`, concurrency 3, on
`musterd-cooperbench` with the same image and machine as pilot 3 (musterd `ebbd2f2e` or later; the
solo arm runs no musterd). Scored with CooperBench's own `test_solo`: the agent's one patch is tested
against each feature's suite, and a pair passes when both pass. `--git` does not apply to one agent.
The agent's instruction is CooperBench's own solo prompt, unchanged.

## Measures

Primary: pass count out of 10, model cost, wall time.

Per pair, beside pilot 3's two arms: did solo pass a pair musterd failed, or fail one musterd passed?
For each of musterd's six task losses, whether solo passes that pair.

## Verdict rules, fixed before the run

All three compare the solo count `S` with pilot 3's musterd count `M = 4` (same subset, model, harness
and machine, but a different day; the finding reports that).

- **`M ≥ S`: "on this subset, musterd's two agents match one agent doing both features"** may be
  stated, with the setting (`block` posture) and the honest N. The next lever is then the model's
  feature correctness, which a coordination product does not own. Feature-correctness work is not
  started on CooperBench's account.
- **`S ≥ M + 2`: "a gap remains."** The finding names, from the per-pair table, the pairs solo passes
  and musterd does not, and the next product change is aimed at those pairs: the feature-correctness
  ADR finding 017 proposed.
- **`S = M + 1`: inconclusive at this N.** The finding reports the per-pair overlap and makes no claim.

The `team` arm's 2/10 is reported beside these, and no rule reads it.

## Errors

An error (container startup, evaluator error, API outage or usage limit) is re-run once, with its reason
recorded; a failed score is never re-run.

## Procedure

1. Start the run machine (no redeploy: it carries `ebbd2f2e`). One `claude -p` API check.
2. **One solo smoke pair** (`pallets_click` 2068, features 1 and 2, about $0.70), scored with the
   evaluator. It passes if the agent submits and the pair scores without an error: solo has never run
   on this machine.
3. Pull no images (all ten are cached). Run the arm, `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under a spend watcher.
4. Re-run errors once, then copy the run records to `docs/research/cooperbench/pilot-runs/` and stop
   the machine.

## Spend

| Item | Estimate |
| --- | --- |
| API check and solo smoke pair | ~$0.70 |
| Solo arm, ten pairs (one agent per pair; pilot 3's team arm was $13.76 for two) | $8–15 |
| Fly `performance-8x`, under an hour | under $3 |
| **Total model spend** | **about $9–16** |

**Hard stop: $25 of model spend**, counted from step 1, re-runs included.

## Decisions

| Decision | Answer |
| --- | --- |
| Run a solo reference before any feature-correctness ADR | **yes**: nick, 2026-10-21 |
| Compare with pilot 3's arms rather than re-running them the same day | **compare with pilot 3**: nick, 2026-10-21 (saves ~$38; the different day is reported) |
| Spend | **$9–16, hard stop $25**: nick, 2026-10-21 |
