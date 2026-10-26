# CooperBench rider 6 run: pre-registration

**Lanes:** `01M5WJGW3H` (this page), `01M5WJJAMF` (the product change), `01M5WJJGNJ` (the run), goal
`coordination-cost`, asked by nick. **Status:** pre-registered 2026-10-26, before the product change has
landed and before any pair ran; run 2026-10-26 17:35–18:07Z → [finding 028](../028-cooperbench-rider6-run.md). Nothing below changes once a measured pair has run; what the run teaches
goes in the finding, not here. **CooperBench:** `63b9d44`. **Before this:** [rider 5
run](./rider5-manifest.md) → [finding 027](../027-cooperbench-rider5-run.md), whose remainder this run
reads.

## Why

Finding 027 found ADR 731's audience right while both lanes were open and empty once the partner had
finished: 12 of 22 recorded pushes fired an act; the 10 that did not all came after the partner's lane
had resolved, been released or handed off, and in 7 of those 10 pairs that partner then merged the
pusher's branch by hand. The pusher's hook line reached the pusher 22 of 22 times and 8 of 12 announced
pushers still said it again, every one opening with what they had changed. Nick chose the product
change on 2026-10-26 after a read of where rider 5's $18.54 went: 128 `team_inbox_check` calls ($2.90, 82
in wait mode), 60 `ToolSearch` calls ($1.17), 28 edit refusals ($0.78), against $0.25 of "pushed /
fetch" sends.

| What finding 027 found | Product change (one ADR, lane `01M5WJJAMF`) |
| --- | --- |
| 10 of 10 silent pushes came after the partner's lane left the contending states; that partner merges | The covering audience also counts another owner's lane on a named file that left the contending states within a window (30 min, a team policy key) and still has an owner on record |
| 8 of 12 announced pushers repeated by hand, each opening with what changed | The push report carries the commit subjects and changed files since the remote-tracking ref's previous value (reflog; on a first push, the pushed commits), capped; the push act body carries them |

[Rider 6](./riders.md#rider-6-finding-027s-remainder--the-push-reaches-the-partner-whose-lane-just-ended-and-carries-what-changed)
pre-registers the reads and their verdict rules the same day, before the change lands. The rules are
quoted here so the two documents cannot drift:

| | Count | Finding 027 (`core`) | Acted | Did not |
| --- | --- | --- | --- | --- |
| R6a | recorded pushes that fired at least one push act | 12 of 22 | **≥ 90%** | **≤ 70%** |
| R6b | `team_inbox_check` calls in wait mode | 82 calls, $1.52 | **≤ 55** | **≥ 75** |
| R6c | announced pushers who then sent a hand pushed / fetch message anyway | 8 of 12 | **≤ 25%** | **≥ 60%** |

Between the bounds: "part of it", with each silent push's reason from the daemon log (R6a), each wait's
position relative to the partner's push (R6b), or the bodies (R6c). Each rule stands alone. Beside them,
with no rule: plain `team_inbox_check` calls, `ToolSearch` calls, "pushed / fetch" sends, the receiver's
next move after each push act, ADR 724 acts, board reads, status updates, pass, cost.

## Question

On the 10 `core` pairs, with the same agents and instructions as the claim run, did the push reach the
partner who had finished and was waiting to merge, did that partner stop polling the inbox for it, and
did what-changed in the act stop the pusher from writing it by hand? Cost per pair and the earlier
counts are reported beside them, with no rule.

**This run makes no pass-rate claim** (findings 018 and 021).

## Arm

One arm, musterd only:

```
cooperbench run -n r6-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval
```

`claude_code_musterd`, Claude Code **2.1.307**, `claude-sonnet-4-5`, gate in `block` posture over `**`,
ADR 691 + 693 + 697 + 724 + 730 + 731 and the rider 6 ADR in force. The image is deployed from `main` at
or after lane `01M5WJJAMF`'s merge; `MUSTERD_REF` records the commit. The agents' instructions are the
claim run's (#3177), byte-identical. The arm's `claude_settings` are rider 4's: the hook command text
does not change, so `config.py` and its pinning test are untouched. Nothing is added to the arm.

## Tasks

CooperBench's 10 `core` pairs ([pilot manifest](./pilot-manifest.md#tasks)), the pairs findings 022,
025, 026 and 027 read, so the comparison is pair for pair.

## Reads

Each count is read once, from the first complete run, over the 10 `core` pairs, with the claim run's
residue scripts (`boardreads.py`, `sends.py`, `mtools.py`, `cats.py`), `rider2.py`, rider 4's `rider4.py`
and rider 5's `rider5.py` (its 2026-10-26 amended form, which carries `recorded_pushes`) unchanged. R6a
is `rider5.json`'s `announced_pushes` over `recorded_pushes`; R6b is the call count on `mtools.py`'s
`musterd:team_inbox_check (wait)` line; R6c is `holders_repeating_by_hand` over `announced_holders`.
"Part of it" on R6b is read by hand from the streams and the daemon log: for each wait-mode check,
whether the partner's push act was already waiting, arrived during the wait, or had not happened.

## Errors

As in the rider 5 run: an error (container or MCP startup failure, evaluator error, API outage or usage
limit, a musterd agent whose shared remote did not work) is re-run once under a new run name with its
reason recorded; a failed score is never re-run. Three errors in the first three pairs stop the arm. An
API usage limit `spend_guard.py` detects stops the run; the pairs that ran are reported as a partial run
with that stated.

## Procedure

On `musterd-cooperbench`, in one session, under `run_arms.py` with the hard stop below.

1. **Deploy** from `main` at or after lane `01M5WJJAMF`'s merge, Claude Code pinned to 2.1.307 for the
   host and every agent container. After the deploy: `useradd smoke`, `chmod 1777` the swe_agent
   `trajectories` directory, and the `dataset` symlink (README).
2. **API check:** one one-word `claude -p` call returns without error.
3. **Smokes, under $0.05, as the `smoke` user, host `musterd` on `PATH`:** `gate_smoke.py` and
   `hold_smoke_697.py` both PASS, no deaf warning.
4. **No smoke pair.**
5. **Pull** the ten images, then **run the arm** `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under `run_arms.py --cap 24.80`.
6. **Re-run errors once,** then copy `readout.json`, the run log, the residue scripts' output,
   `rider2.json`, `rider4.json` and `rider5.json` into `docs/research/cooperbench/pilot-runs/<date>-rider6/`
   (`git status` must show the `.log` files staged), and `fly machine stop`.
7. **Read R6a, R6b and R6c** under the rules above, then write finding 028.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smokes | under $0.10 |
| musterd arm, 10 `core` pairs (finding 025 $17.94; 026 $18.91; 027 $18.54) | $17–21 |
| Fly, about 1 h | under $3 |
| **Total model spend** | **about $19 (range $17–23)** |

**Hard stop: $25 of model spend**, counted from step 2, including error re-runs.

## Decisions

| Decision | Answer |
| --- | --- |
| Rider 6 = ended-lane audience + one run, with the derived hand-off folded in; no "what changed" act the pusher writes | nick, 2026-10-26, in session ("Option 2 sounds good") |
| Ended-lane window 30 min | lazara's proposal in the same session, not objected to; a team policy key so it is not fixed |
| Stop reading the "pushed / fetch" send count as a rule; R6b aims at the wait bucket | lazara, same session; nick's "limited time and money" |
| Spend | ~$19, hard stop $25 (this manifest; no new figure asked) |
| Pass rate | reported, no claim (this manifest) |
| Finding number | 028 |
