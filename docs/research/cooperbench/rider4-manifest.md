# CooperBench rider 4 run: pre-registration

**Lane:** `01M5SZXMJX` (goal `coordination-cost`), asked by nick. **Status:** pre-registered 2026-10-25,
before any pair ran. Nothing below changes once a measured pair has run; what the run teaches goes in
the finding, not here. **CooperBench:** `63b9d44`. **Before this:** [coordination-cost
run](./coordination-cost-manifest.md) → [finding 025](../025-cooperbench-coordination-cost-run.md),
whose two follow-ups this run reads.

## Why

Finding 025 read three product changes on the 10 `core` pairs. The status updates went (45 → 0); the
orientation reads did not (27 → 9 board reads after the instructed first call, eight of them an agent
reading `lane_board` right before `lane_open`); ADR 724's act reached every refused seat, but "pushed /
fetch" stayed the largest state-signal kind sent by hand (14 calls, $0.26) with no product event
behind it. Both follow-ups have since landed on `main`:

| What finding 025 found | Product change | PR |
| --- | --- | --- |
| 8 `lane_board` reads right before `lane_open`: the block listed the held lanes, not the open ones, and did not say `lane_open` checks overlap | The one-call orientation lists the open, unowned lanes beside the held ones and closes with "lane_open … checks your scope against every lane here and warns on overlap, so no board read first" | #3309 |
| 14 "pushed / fetch" messages by hand | A push is an event: the Bash PostToolUse hook reports a push of the lane's branch, the daemon records it on the lane and sends one directed act to every seat waiting on that lane ([ADR 730](../../decisions/730-push-is-an-event.md)); the arm's settings carry the hook (#3314); a push of another branch is not reported (#3315) | #3310, #3314, #3315 |

[Rider 4](./riders.md#rider-4-finding-025s-two-follow-ups--the-open-lanes-in-the-orientation-block-and-the-push-as-an-event)
pre-registered the two reads and their verdict rules on 2026-10-24, before either change ran. This run
produces their data. The rules are quoted here so the two documents cannot drift:

| | Count | Finding 025 (`core`) | Acted | Did not |
| --- | --- | --- | --- | --- |
| R4a | board reads with `context = before first claim`, minus the instructed first `team_inbox_check` of each agent | 9 of 85 | **≤ 3** | **≥ 8** |
| R4b | sends `is_signal` marks as pushed / fetch | 14 calls, $0.26 | **≤ 5** | **≥ 12** |

Between the bounds: "part of it", with the labelled rows (R4a) or the bodies (R4b). Each rule stands
alone. Beside them, with no rule: the ADR 724 acts and the ADR 730 push acts delivered, per pair, and
how many push acts had a pushed-branch message by hand after them anyway.

## Question

On the 10 `core` pairs, with the same agents and instructions as the claim run, did the open lanes in
the orientation block remove the pre-open board read, and did the push event remove the "pushed /
fetch" message? Cost per pair and finding 025's other counts (status updates, state signals by kind)
are reported beside them, with no rule.

**This run makes no pass-rate claim** (findings 018 and 021).

## Arm

One arm, musterd only:

```
cooperbench run -n r4-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval
```

`claude_code_musterd`, Claude Code **2.1.307**, `claude-sonnet-4-5`, gate in `block` posture over `**`,
ADR 691 + 693 + 697 + 724 + 730 in force. The image is deployed from `main` at or after **#3315**
(`70d0170a`); `MUSTERD_REF` records the commit. The agents' instructions are the claim run's (#3177),
byte-identical. The arm's `claude_settings` carry one more hook than finding 025's run: ADR 730's
PostToolUse `Bash` push hook, the same text `musterd init` writes for every seat (#3314, pinned by
`test_push_hook_matches_claude_code_ts`). Nothing else is added to the arm.

## Tasks

CooperBench's 10 `core` pairs ([pilot manifest](./pilot-manifest.md#tasks)), the pairs findings 022
and 025 read, so the comparison is pair for pair.

## Reads

Each count is read once, from the first complete run, over the 10 `core` pairs, with the claim run's
residue scripts (`boardreads.py`, `sends.py`, `mtools.py`, `cats.py`) unchanged, and `rider2.py` from the
coordination-cost run for the ADR 724 acts. A new `rider4.py` counts the ADR 730 acts (directed
`message` acts with `meta.lane_pushed`) per pair and pairs each with any later hand-sent pushed / fetch
message from the same holder. It is written before the readout and copied into the run folder.

## Errors

As in the coordination-cost run: an error (container or MCP startup failure, evaluator error, API
outage or usage limit, a musterd agent whose shared remote did not work) is re-run once under a new run
name with its reason recorded; a failed score is never re-run. Three errors in the first three pairs
stop the arm. An API usage limit `spend_guard.py` detects stops the run; the pairs that ran are
reported as a partial run with that stated.

## Procedure

On `musterd-cooperbench`, in one session, under `run_arms.py` with the hard stop below.

1. **Deploy** from `main` at or after #3315, Claude Code pinned to 2.1.307 for the host and every
   agent container.
2. **API check:** one one-word `claude -p` call returns without error.
3. **Smokes, under $0.05, as the `smoke` user:** the committed `gate_smoke.py` (now with `Read`, #3314)
   and `hold_smoke.py` both PASS, no deaf warning.
4. **No smoke pair.**
5. **Pull** the ten images, then **run the arm** `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under `run_arms.py --cap 24.80`.
6. **Re-run errors once,** then copy `readout.json`, the run log, the residue scripts' output, `rider2.json`
   and `rider4.json` into `docs/research/cooperbench/pilot-runs/2026-10-25-rider4/`, and `fly machine stop`.
7. **Read R4a and R4b** under the rules above, then write finding 026.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smokes | under $0.10 |
| musterd arm, 10 `core` pairs (claim run $17.29; coordination-cost run $17.94) | $16–20 |
| Fly, about 1 h | under $3 |
| **Total model spend** | **about $18 (range $16–22)** |

**Hard stop: $25 of model spend**, counted from step 2, including error re-runs.

## Decisions

| Decision | Answer |
| --- | --- |
| Run rider 4 on `core` with the musterd arm alone | nick, 2026-10-25, in session ("lets do rider 4") |
| Spend | the coordination-cost run's: ~$18, hard stop $25 (nick, same message, no new figure asked) |
| Pass rate | reported, no claim (this manifest) |
| Finding number | 026 |
