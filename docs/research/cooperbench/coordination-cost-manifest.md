# CooperBench coordination-cost run: pre-registration

**Lane:** `01M5QDHJEE` (goal `coordination-cost`), asked by nick. **Status:** pre-registered 2026-10-24,
before any pair ran; run the same day → [finding 025](../025-cooperbench-coordination-cost-run.md). Nothing below changes once a measured pair has run; what the run teaches goes in
the finding, not here. **CooperBench:** `63b9d44`. **Before this:** [claim run](./claim-manifest.md) →
[finding 021](../021-cooperbench-claim-run.md), [finding 022](../022-cooperbench-coordination-residue.md)
(the diagnosis this run checks), [rider run](./rider-manifest.md) → [finding 024](../024-cooperbench-rider-run.md).

## Why

Finding 022 priced what was left of musterd's coordination on the claim run's 10 `core` pairs:
about $7.8 of $17.29, after polling was gone. It named three groups an instruction or a missing
product event caused, and each has since landed as a product change on `main`:

| What finding 022 found | Product change | PR |
| --- | --- | --- |
| 27 of 100 board reads on `core` were an agent orienting before its first claim, in separate `team_status` / `lane_board` / inbox calls | One call orients a seat: the join answer carries the held lanes, the open count and directed acts ([ADR 707](../../decisions/707-join-at-session-start.md) note) | #3289 |
| 40 status updates ($0.94) that repeated a direct message, sent because the primer said to report status | A seat reads `working` from its own lane activity ([ADR 726](../../decisions/726-working-from-lane-activity.md)); the status-update instruction is gone from the primer, the per-prompt nudge, the join and send text | #3271, #3280, #3283, #3285 |
| 21 of 100 board reads were "who holds it, is it free" and "is my partner done"; "lane done / you can edit" and "merged" signals were sent by hand | A held-file refusal watches the holder's lane; when the lane frees the file a directed act wakes the refused seat with the holder's branch ([ADR 724](../../decisions/724-held-refusal-watches-the-holders-lane.md)) | #3269, #3279 |
| After a held refusal the agent asked the holder rather than waiting | The refusal leads with the one-call wait (#3219) — measured in finding 024: no change; the repair line names the one call that adds the path to the lane | #3270 |

Finding 024 ended with: a larger run on the refusal wording is not the next step; if the residue still
matters, the product change is on the holder's side. ADR 724 is that change, and
[rider 2](./riders.md#rider-2-after-a-lane-frees-a-held-file-do-holders-stop-announcing-it-adr-724) is
pre-registered to read it, but no run has produced its data. This run does, and reads the other two
groups beside it.

## Question

On the 10 `core` pairs, with the same agents and instructions as the claim run, did the product changes
above remove the coordination calls finding 022 attributed to them? Three counts, read against the
claim run: board reads before an agent's first claim, status updates, and state-signal sends. Cost per
pair is reported beside them.

**This run makes no pass-rate claim.** Ten pairs decide nothing about passing (findings 018 and 021), and
the question here is what the agents did between the edits, not whether the pairs passed.

## Arm

One arm, musterd only:

```
cooperbench run -n cc-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval
```

`claude_code_musterd`, Claude Code **2.1.307**, `claude-sonnet-4-5`, gate in `block` posture over `**`,
ADR 691 + 693 + 697 in force, as in every run since pilot 3. The image is deployed from `main` at or
after **#3289** (`071691db`), which carries every PR in the table above. `MUSTERD_REF` records the
commit. The agents' instructions are the claim run's (#3177), byte-identical; the solo and team arms
do not run.

**What the agents see that the claim run's agents did not:** the orientation block on the first
`team_inbox_check` reply, no status-update instruction in the primer or the per-prompt nudge, the
ADR 724 directed act when a held file frees up, and #3219's refusal text. All four are the product.
Nothing is added to the arm for this run.

## Tasks

CooperBench's 10 `core` pairs, listed in the [pilot manifest](./pilot-manifest.md#tasks). They are
the pairs finding 022's numbers were read from, so the comparison is pair for pair.

## Measures

Read from the agents' own streams and the copied daemon databases, by the claim run's residue scripts,
unchanged and copied into this run's folder:
[`boardreads.py`](./pilot-runs/2026-10-22-claim/residue/boardreads.py) (board reads, with the
structural `context` and the `intent` label) and
[`sends.py`](./pilot-runs/2026-10-22-claim/residue/sends.py) (every `team_send`, finding 019's
`is_signal` and the signal kinds). Per pair, `readout.py` as in the rider run: merge outcome, cause,
`held_refusal_moves`, API-limit errors.

**Rider 3** (added to [`riders.md`](./riders.md) with this manifest) is the primary measure, three
counts on `core`:

| Count | Claim run (`core`, 10 pairs, 20 agents) | How it is counted |
| --- | --- | --- |
| **R3a** board reads before the agent's first claim | **27** of 100 | `boardreads.py`, `context = before first claim` |
| **R3b** status updates that are not a state signal | **40** calls, $0.94 | `sends.py`, act `status_update`, `is_signal` false _(Re-read 2026-10-24 by the same code for [finding 025](../025-cooperbench-coordination-cost-run.md): 45 calls, $1.02. The rule below was read as written; it acts under either baseline.)_ |
| **R3c** state-signal sends (019's `is_signal`), by kind | **34** calls, $0.69 (pushed 10, merged 16, lane done 4, ETA 2, other 2) | `sends.py` |

**Rider 2**, as pre-registered: in the pairs with at least one held refusal, the holder's state-signal
sends per pair, and the time from the holder's lane freeing the file to the refused seat's next edit
of it. Its claim-run baseline is read with the same code before this run's numbers are, and both go
in the finding. No rule.

Reported beside them, no rule: pass count (claim run `core`: 3 of 10 — 4 of 10 by the same `readout.json`, re-read 2026-10-24 for finding 025), merge outcome, model cost
(claim run `core`: $17.29; finding 022 put the reachable saving at $0.5–1, which is inside the
run-to-run spread, so cost decides nothing here), wall time, held refusals and their next moves
(rider 1's counts, reported for the record; its rule was read once, in finding 024, and is not read
again), and whether any ADR 724 directed act was delivered and what the receiving agent did next.

## Verdict rules, fixed before any run

Each count is read once, from the first complete run, over the 10 `core` pairs. The thresholds are
one third and four fifths of the baseline: a change that removed the instructed calls should leave
few, and a count still near the baseline means the change did not reach the agents.

| | "the change acted" | "the change did not act" | between: "part of it" |
| --- | --- | --- | --- |
| **R3a** orientation reads (27) | **≤ 9** | **≥ 22** | reported with the `intent` table |
| **R3b** status updates (40; 45 by the 2026-10-24 re-read) | **≤ 13** | **≥ 32** | reported with the first ten bodies |

**R3c** state signals are reported by kind with no rule: the kinds ADR 724 carries ("lane done / you
can edit" 4, "merged" 16) are too few for a fair test at ten pairs, and "pushed" (10) has no product
event yet (finding 022's next step 2, not built). The finding says which kinds fell and which did not.

Each rule is independent. One acting does not soften another's "did not act".

## Errors

As in the claim run: an **error** (container or MCP startup failure, evaluator error, API outage or
usage limit, a musterd agent whose shared remote did not work) is re-run once under a new run name
with its reason recorded; a failed score is never re-run. Three errors in the first three pairs stop
the arm; the cause is fixed and the arm re-run whole. An API usage limit that `spend_guard.py`
detects stops the run, and the pairs that ran are reported as a partial run with that stated.

## Procedure

On `musterd-cooperbench`, in one session, under `run_arms.py` with the hard stop below. A failed check
stops the procedure before measured spend.

1. **Deploy** from `main` at or after #3289, Claude Code pinned to 2.1.307 for the host and every
   agent container.
2. **API check:** one one-word `claude -p` call returns without error, and nick confirms the account's
   limit covers $25 (finding 023's limit note; the rider run confirmed the same way).
3. **Smokes, under $0.05, as the `smoke` user:** `gate_smoke.py` and `hold_smoke_697.py` both PASS.
4. **No smoke pair:** the claim and rider runs already ran these pairs in this arm.
5. **Pull** the ten images, then **run the arm** `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under `run_arms.py --cap 24.95`.
6. **Re-run errors once,** then copy `readout.json`, the run log, the residue scripts and their output
   into `docs/research/cooperbench/pilot-runs/2026-MM-DD-coordination-cost/`, and `fly machine stop`.
7. **Read rider 2's baseline** from the claim run's data first, then this run's; then read R3a–R3c
   and write the finding.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smokes | under $0.10 |
| musterd arm, 10 `core` pairs (claim run $17.29; rider run $17.67 on 9) | $16–20 |
| Fly, about 1 h | under $3 |
| **Total model spend** | **about $18 (range $16–22)** |

**Hard stop: $25 of model spend**, counted from step 2, including error re-runs. A run that reaches it
is stopped and reported.

## Decisions

| Decision | Answer |
| --- | --- |
| Run the coordination-cost check on `core` with the musterd arm alone | nick, 2026-10-24 ("do 1 and 2") |
| Spend | nick, 2026-10-24, in session ("approved, run it"): ~$18, hard stop $25. Spent $17.94 on the arm, about $0.14 on smokes |
| Pass rate | reported, no claim (this manifest) |
| Finding number | 025 |
