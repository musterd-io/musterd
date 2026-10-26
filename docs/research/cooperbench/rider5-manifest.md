# CooperBench rider 5 run: pre-registration

**Lanes:** `01M5V4GEP0` (this page), `01M5V4H40C` (the product change), `01M5V4HH6Z` (the run), goal
`coordination-cost`, asked by nick. **Status:** pre-registered 2026-10-25, before the product change has
landed and before any pair ran; run 2026-10-26 → [finding 027](../027-cooperbench-rider5-run.md). Nothing below changes once a measured pair has run; what the run teaches
goes in the finding, not here. **CooperBench:** `63b9d44`. **Before this:** [rider 4
run](./rider4-manifest.md) → [finding 026](../026-cooperbench-rider4-run.md), whose two follow-ups this
run reads.

## Why

Finding 026 found the push event reliable and its audience wrong for a two-seat workload: 20 of 20
pushes recorded, 4 announced, "pushed / fetch" sends up from 14 to 18, and 3 of the 4 announced
holders repeating the announcement by hand. Nick chose the product change on 2026-10-25, after a read
of the revive board (35 contending owned lanes: 0 pairs name the same file across owners, 2 pairs have
one owner's glob covering a file another owner's lane names, 12 pairs overlap by glob):

| What finding 026 found | Product change (one ADR, lane `01M5V4H40C`) |
| --- | --- |
| 16 of 20 pushes had no open ADR 724 watch on the lane | The audience adds every other seat owning a contending lane in the same project whose scope covers a file the pushing lane names — the gate's own relation (ADR 150 covering, ADR 691 holds); one act per seat per head; the body says whether the path is still held |
| 3 of 4 announced holders said it again by hand; the hook returns nothing to the pusher | `POST /lanes/push` returns the seats told; `gate record-push` emits one PostToolUse `additionalContext` line: who was told, or that no other lane covers this lane's files |
| 4 holders pushed before the partner was refused; the daemon does not replay | The ADR 691 refusal names the lane's last pushed head and remote when one is recorded |

[Rider 5](./riders.md#rider-5-finding-026s-two-follow-ups--the-push-reaches-the-lanes-that-cover-its-files-and-the-pusher-is-told)
pre-registers the reads and their verdict rules the same day, before the change lands. The rules are
quoted here so the two documents cannot drift:

| | Count | Finding 026 (`core`) | Acted | Did not |
| --- | --- | --- | --- | --- |
| R5a | sends `is_signal` marks as pushed / fetch | 18 calls, $0.35 | **≤ 5** | **≥ 12** |
| R5b | recorded pushes that fired at least one push act | 4 of 20 | **≥ 80%** | **≤ 40%** |
| R5c | announced pushers who then sent a hand pushed / fetch message anyway | 3 of 4 | **≤ 25%** | **≥ 60%** |

Between the bounds: "part of it", with the bodies (R5a, R5c) or finding 026's three reasons re-counted
(R5b). Each rule stands alone. Beside them, with no rule: the receiver's next move after each push act,
the ADR 724 acts, status updates, pass, cost, and how many refusals carried a pushed head.

## Question

On the 10 `core` pairs, with the same agents and instructions as the claim run, did the wider audience
put the push act in front of the seat that needed it, did that remove the "pushed / fetch" message, and
did the pusher's line stop the holder from saying it again? Cost per pair and the earlier counts are
reported beside them, with no rule.

**This run makes no pass-rate claim** (findings 018 and 021).

## Arm

One arm, musterd only:

```
cooperbench run -n r5-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval
```

`claude_code_musterd`, Claude Code **2.1.307**, `claude-sonnet-4-5`, gate in `block` posture over `**`,
ADR 691 + 693 + 697 + 724 + 730 and the rider 5 ADR in force. The image is deployed from `main` at or
after lane `01M5V4H40C`'s merge; `MUSTERD_REF` records the commit. The agents' instructions are the claim
run's (#3177), byte-identical. The arm's `claude_settings` are rider 4's: the hook command text does not
change, so `config.py` and its pinning test are untouched. Nothing is added to the arm.

## Tasks

CooperBench's 10 `core` pairs ([pilot manifest](./pilot-manifest.md#tasks)), the pairs findings 022,
025 and 026 read, so the comparison is pair for pair.

## Reads

Each count is read once, from the first complete run, over the 10 `core` pairs, with the claim run's
residue scripts (`boardreads.py`, `sends.py`, `mtools.py`, `cats.py`), `rider2.py` and rider 4's
`rider4.py` unchanged. R5b and R5c are derived from `rider4.json`'s per-pair fields by a short
`rider5.py` (written before the readout, copied into the run folder): R5b counts the `git_pushes` whose
holder and head appear in `push_acts`; R5c counts the holders in `push_acts` with a `hand_pushed_sends`
entry whose `push_acts_so_far ≥ 1`. The count of refusals carrying a pushed head is read from the
agents' streams (the refusal text) by the same script.

## Errors

As in the rider 4 run: an error (container or MCP startup failure, evaluator error, API outage or usage
limit, a musterd agent whose shared remote did not work) is re-run once under a new run name with its
reason recorded; a failed score is never re-run. Three errors in the first three pairs stop the arm. An
API usage limit `spend_guard.py` detects stops the run; the pairs that ran are reported as a partial run
with that stated.

## Procedure

On `musterd-cooperbench`, in one session, under `run_arms.py` with the hard stop below.

1. **Deploy** from `main` at or after lane `01M5V4H40C`'s merge, Claude Code pinned to 2.1.307 for the
   host and every agent container.
2. **API check:** one one-word `claude -p` call returns without error.
3. **Smokes, under $0.05, as the `smoke` user, host `musterd` on `PATH`:** `gate_smoke.py` and
   `hold_smoke_697.py` (the ADR 697 check the README names) both PASS, no deaf warning.
4. **No smoke pair.**
5. **Pull** the ten images, then **run the arm** `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under `run_arms.py --cap 24.80`.
6. **Re-run errors once,** then copy `readout.json`, the run log, the residue scripts' output,
   `rider2.json`, `rider4.json` and `rider5.json` into `docs/research/cooperbench/pilot-runs/<date>-rider5/`,
   and `fly machine stop`.
7. **Read R5a, R5b and R5c** under the rules above, then write finding 027.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smokes | under $0.10 |
| musterd arm, 10 `core` pairs (claim run $17.29; finding 025 $17.94; finding 026 $18.91) | $17–21 |
| Fly, about 1 h | under $3 |
| **Total model spend** | **about $19 (range $17–23)** |

**Hard stop: $25 of model spend**, counted from step 2, including error re-runs.

## Decisions

| Decision | Answer |
| --- | --- |
| Audience: covering lanes (not glob overlap, not named-file-only) | nick, 2026-10-25, in session ("audience 3") |
| The refusal carries the last pushed head | nick, same message ("head addition in") |
| Run rider 5 on `core` with the musterd arm alone, after the change lands | nick, same message ("run it — go ahead") |
| Spend | ~$19, hard stop $25 (this manifest; no new figure asked) |
| Pass rate | reported, no claim (this manifest) |
| Finding number | 027 |
