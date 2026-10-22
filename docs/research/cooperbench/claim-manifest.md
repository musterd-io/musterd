# CooperBench claim run: pre-registration

**Lane:** `01M5GWBB17` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-22; not yet run.
Nothing below changes once a measured pair has run; what the run teaches goes in the
finding, not here. **CooperBench:** `63b9d44`. **Before this:** [pilot 3](./pilot3-manifest.md) →
[finding 017](../017-cooperbench-pilot-3.md), [solo reference](./solo-manifest.md) →
[finding 018](../018-cooperbench-solo-reference.md), [finding 019](../019-cooperbench-cost-attribution.md).

## Why

Finding 018 left a direction and no claim: solo 5/10 against musterd 4/10, every musterd pass also
a solo pass, and one pair between them is inside the noise at N = 10. It named more pairs as what
would turn the direction into a claim, either way. Finding 019 then traced most of musterd's extra cost
to two things in our own product, and asked that the next measured run use the build with both fixed,
so the cost it reports still holds after publication. Both fixes are on `main`:

| Change | Kind | PR |
| --- | --- | --- |
| A seat joins at session start, so tool search stays on and only the hot tools load up front ([ADR 707](../../decisions/707-join-at-session-start.md)) | product | #3173 |
| A blocking wait on the MCP surface ([ADR 705](../../decisions/705-mcp-inbox-blocking-wait.md)) | product | #3169 |
| The wait also wakes when a hold it was refused is released or a lane it named resolves | product | #3172 |
| The harness turns tool search back on and names the blocking wait in the agents' instructions | harness | #3177 |

The agents' instructions changed in exactly one way since pilot 3: they name the blocking wait
(#3177). CooperBench's solo prompt is unchanged.

## Question

On 20 CooperBench pairs, with Claude Code on `claude-sonnet-4-5`, do musterd's two agents (one
feature each) pass as many pairs as one agent given both features? And on the 10 `core` pairs, what
does musterd cost now, compared with pilot 3 and with finding 019's estimate?

## Arms

| Arm | Command | |
| --- | --- | --- |
| **musterd** | `cooperbench run -s claim20 --setting coop -a claude_code_musterd --git -c 3` | gate in `block` posture over `**`, ADR 691 + 693 + 697 in force, as in pilot 3 |
| **solo** | `cooperbench run -s claim20 --setting solo -a claude_code -c 3` | CooperBench's own solo arm, as in finding 018 |

The two arms run side by side, on the same machine and on the same day. The `team` arm does not run:
pilot 3's team 2/10 on `core` is reported beside the results, with its date, and no rule reads it.

## Tasks

**20 pairs**: CooperBench's 10 `core` pairs (listed in the [pilot manifest](./pilot-manifest.md#tasks)),
plus **10 new pairs** drawn before any run and listed below (nick's choice, 2026-10-22: core keeps
the link to pilot 3 and finding 018, and the new ten keep the claim from resting on one subset).

**How the ten are drawn:** CooperBench's `all.json` at `63b9d44` has 652 pairs over 30 tasks, and
`core` uses 10 of the tasks. From the 20 tasks `core` does not use, `random.Random(20261022)` samples
10 (sorted), then one pair from each. That gives one pair per task, as `core` is built. The draw is
[`claim_pairs.py`](../../../scripts/research/cooperbench/claim_pairs.py), and its output,
[`claim20.json`](./claim20.json), is committed here and is the `-s claim20` subset both arms run.

The draw was settled before any run, in three steps that happened, and all three are recorded. A
uniform draw over pairs put three of the ten on `openai_tiktoken` task 0, which alone has 45
pairs. A draw of one pair per task, excluding only `core`'s pairs, still put four on tasks `core`
uses. Pairs on one task share a codebase and a feature set, so they are not independent. Neither
earlier list was run.

| Task | Features |
| --- | --- |
| `dottxt_ai_outlines/1371` | 3, 4 |
| `dottxt_ai_outlines/1706` | 1, 8 |
| `dspy/8587` | 1, 6 |
| `go_chi/26` | 1, 2 |
| `huggingface_datasets/7309` | 1, 2 |
| `llama_index/18813` | 3, 6 |
| `pallets_click/2068` | 2, 5 |
| `pallets_click/2956` | 1, 8 |
| `pallets_jinja/1465` | 7, 9 |
| `react_hook_form/85` | 3, 5 |

`pallets_click/2068` is the task every smoke pair has used, with features 1 and 2. Pair 2 + 5 has
never run. It stays in: redrawing it would be choosing pairs by hand.

## Scoring

As in pilots 1–3 and the solo reference: CooperBench's own evaluator, unchanged. For musterd,
`test_merged` (`cooperbench eval --backend docker`). For solo, `test_solo`. A pair passes when both
features' suites pass. Nothing is re-scored under a different policy after the fact.

## Measures

Primary, per arm, over all 20 pairs and separately over `core` and the new ten: pass count, model
cost, and wall time.

Secondary:

- **Per-pair overlap:** pairs both arms pass, pairs only solo passes, and pairs only musterd passes.
  The discordant pairs are what the claim rests on.
- **Cost against prediction:** musterd's model cost on the 10 `core` pairs, beside pilot 3's $24.59
  and finding 019's A+B estimate of $16.29.
- **Did the fixes act:** per musterd agent, from `readout.py` and the copied daemon databases: first-call
  input tokens (tool search on, so the 16k of schemas should be absent), blocking-wait calls,
  polling calls (`team_inbox_check` / `lane_board` / `team_status` / `sleep … git fetch` while
  waiting), and `team_send` acts that carry state the product already has (019's labels, unchanged).
- Pilot 3's secondary measures, unchanged: merge outcome, per-pair cause, shared-remote lookups and
  partner merges, and `lane.gate` rows by hold.

## Verdict rules, fixed before any run

Read once from the first complete run of each arm. `M` is musterd's pass count over 20, and `S` is solo's.

- **`M ≥ S`: "on these 20 pairs, musterd's two agents pass as many pairs as one agent doing both
  features"** may be stated, with the setting (`block` posture, Claude Code, `claude-sonnet-4-5`) and
  N = 20.
- **`S ≥ M + 3`: "a gap remains."** The finding names the pairs only solo passes and aims the next
  product change at them.
- **`S = M + 1` or `S = M + 2`: inconclusive at this N.** The finding reports the per-pair overlap
  and makes no claim.

The `core` ten alone are reported beside 018's numbers and decide nothing.

**Cost**, read on the 10 `core` pairs only (the pairs 019's estimate was made on):

- musterd model cost **≤ $19.55** (019's $16.29 estimate plus 20%): "the two fixes delivered the
  saving finding 019 predicted."
- **≥ $22.13** (90% of pilot 3's $24.59): "the fixes did not reduce the cost." The finding then
  reads the per-agent measures above to say which of A and B did not act.
- Between the two: "part of the predicted saving." Reported with the per-agent measures.

The cost verdict is independent of the pass verdict. Neither one is softened to match the other.

## Errors

An **error** is re-run once, under a new run name, with its reason recorded. A failed score is never
re-run. An error is a container or MCP startup failure, an evaluator error, an API outage or usage
limit, or a musterd agent whose shared remote did not work (the adapter raises, and the readout counts
`unable to look up`). An arm with errors in three of its first three pairs is stopped, the cause fixed,
and the arm re-run whole.

## Procedure

On `musterd-cooperbench` (`performance-8x`, 16 GB, 80 GB volume), in one session. A failed check
stops the procedure before measured spend.

1. **Deploy** from `main` at or after #3177, with `MUSTERD_REF` = that commit, and Claude Code
   pinned to **2.1.307** for the host and every agent container (`CLAUDE_CODE_VERSION` in the
   Dockerfile). CooperBench's `setup.sh` installs `latest` in each container, and pilot 3's and the
   solo reference's streams all record 2.1.307. By 2026-10-22, `latest` was 2.1.308, and its first
   smoke refused to start as root on the host. Pinning keeps the comparison with 017 and 018 on one
   Claude Code, and both arms here install the same version.
2. **API check:** one one-word `claude -p` call returns without error.
3. **Smokes, under $0.05:** `gate_smoke.py` and `hold_smoke.py` both PASS, with tool search on (the
   pre-flight the harness lane owed, README "Tool search").
4. **One musterd smoke pair, about $1:** `pallets_click` 2068, features 1 and 2, `--git`, scored. It
   passes only if both agents submit, the pair scores, each agent's stream shows zero lookup
   failures and at least one `git fetch team` that ran, and the first model call's input carries no
   deferred musterd tool schemas.
5. **Pull** the ten new pairs' images, so neither arm pays for pulls in its wall time.
6. **Run both arms side by side,** `-c 3` each, `--no-auto-eval`, then `cooperbench eval --backend
   docker` for each, under a spend watcher.
7. **Re-run errors once** (above), then copy the readout, run log and scripts into
   `docs/research/cooperbench/pilot-runs/`, and `fly machine stop`.

## Spend

| Item | Estimate |
| --- | --- |
| API check, smokes, musterd smoke pair | ~$1.50 |
| musterd arm, 20 pairs (019's A+B: ~$1.63 a pair; pilot 3: $2.46) | $33–49 |
| solo arm, 20 pairs (018: $0.61 a pair) | $12–15 |
| Fly `performance-8x`, about 2 h | under $6 |
| **Total model spend** | **about $47 (range $46–66)** |

**Hard stop: $60 of model spend**, counted from step 2, including error re-runs. A run that reaches it
is stopped and reported. The top of the range is musterd at pilot 3's cost, which is the cost verdict's
"did not reduce" case. If that happens the stop may cut the run short, and that would itself be the
finding.

## Decisions

| Decision | Answer |
| --- | --- |
| Make finding 018's direction a claim, on the build with 019's fixes | **yes**: nick, 2026-10-21 (finding 018 option 1, sequenced after option 2) |
| Spend | **~$47 approved**: nick, 2026-10-22 (ask `01M5GZN12B`). Hard stop $60 is this manifest's. |
| Which 20 pairs | **`core` + 10 new, seeded draw**: nick, 2026-10-22 |
| Arms | **musterd + solo**; team not re-run (lane brief: team optional) |
| Posture | **block**, as in pilot 3 |
