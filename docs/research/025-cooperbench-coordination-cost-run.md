# 025 — CooperBench coordination-cost run: the status updates went, the orientation reads did not, and ADR 724's act reached every refused seat

> **Status:** 2026-10-24, lane 01M5QDHJEE (lazara), asked for by nick. Pre-registered 2026-10-24
> ([manifest](./cooperbench/coordination-cost-manifest.md), merged #3300); run 22:22Z–22:49Z the same
> day. **Rider 3, read once:** R3b status updates **6** (claim run 40 by the manifest, 45 by the same code
> today) — **the change acted**. R3a board reads before the first claim **29** (claim run 27) — **the
> change did not act**; 20 of the 29 are the instructed first `team_inbox_check`, which is the one call
> itself, and the reads past it went 7 → 9. R3c state signals **41** calls, $0.85 (claim run 34, $0.69) —
> no kind fell. **Rider 2:** the ADR 724 act was delivered after the refusal in **9 of 10** pairs; holder
> signals 18 (before 23). Pass 5 of 10, no conflicts, $17.94.

## Question

[Rider 3](./cooperbench/riders.md#rider-3-did-findings-022s-product-changes-remove-the-calls-they-were-for-one-call-orientation-adr-726-adr-724):
finding 022 priced three groups of coordination calls on the claim run's 10 `core` pairs and each has
since landed as a product change. On the same pairs, with the same agents and instructions, did the
calls go? Three counts against the claim run, each with its own rule: board reads before an agent's
first claim (R3a), status updates that signal no state (R3b), state-signal sends by kind (R3c). Beside
them, [rider 2](./cooperbench/riders.md#rider-2-after-a-lane-frees-a-held-file-do-holders-stop-announcing-it-adr-724):
did ADR 724's directed act arrive, and did holders stop announcing by hand.

## Setup

As the manifest says. The musterd arm alone (`claude_code_musterd`, Claude Code 2.1.307,
`claude-sonnet-4-5`, `--setting coop --git -c 3`, gate in block posture) on CooperBench's 10 `core`
pairs, on `musterd-cooperbench` deployed from main `c9ac2819` (carries #3289 `071691db`, ADR 726's
four PRs and ADR 724's two; `MUSTERD_REF` in every pair's log). It ran under `run_arms.py` with the hard
stop ([`coordcost.sh`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/coordcost.sh)), was scored
by CooperBench's unchanged evaluator, and was read by the claim run's residue scripts unchanged
(`boardreads.py`, `sends.py`) and by `readout.py`. Rider 2 is read by
[`rider2.py`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/rider2.py), written for this run and
run on the claim run's data first (`rider2-claim.json`), then on this run's.

**Pre-flight** ([run log](./cooperbench/pilot-runs/2026-10-24-coordination-cost/run.log)): nick approved
the spend in session. `claude -p` → ok. `hold_smoke_697.py` PASS ($0.009) as the `smoke` user.
**`gate_smoke.py` as committed cannot pass on this Claude Code:** it gives the model `Edit` and `Write`
with no `Read`, and 2.1.307 refuses to edit a file the session has not read, so neither edit reached the
gate (three FAILs, $0.11 in all, `gate_denies=0`). A copy with `Read` allowed and the prompt reading each
file first ([`smokes/gate_smoke_read.py`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/smokes/gate_smoke_read.py),
gate wiring unchanged) **PASS** ($0.0035): the lane's file edited, the unclaimed file refused by the
gate, one `lane.gate` deny audited, no deaf warning. Smokes came to about $0.135, so the arm's cap was
lowered from $24.95 to $24.80 and the $25 hard stop held. No smoke pair, as pre-registered. No pair
errored, no stop fired.

## Result

**Rider 3**, over the 10 `core` pairs, 20 agents:

| | This run | Claim run (`core`) | Rule | Read |
| --- | --- | --- | --- | --- |
| **R3a** board reads before the agent's first claim | **29** of 85 | 27 of 100 | ≤ 9 acted / ≥ 22 not | **did not act** |
| **R3b** `status_update` calls `is_signal` does not mark | **6** calls, $0.13 | 40, $0.94 (manifest); 45, $1.02 (same code, today) | ≤ 13 acted / ≥ 32 not | **acted** |
| **R3c** state-signal sends, `is_signal` | **41** calls, $0.85 | 34, $0.69 | none | reported by kind below |

**R3a, what the 29 reads were.** `boardreads.py` counts a plain `team_inbox_check` as a board read, and
the agents' instructions (#3177, unchanged) make `team_inbox_check` the first action. So 20 of the 29
(and 20 of the claim run's 27) are that first call, one per agent — the call that now carries the
orientation block. The rule's baseline counted it, so the one-call orientation could never reach ≤ 9;
the rule is read as written, and the number that answers the question is what came after the first
call: **9 reads** before a claim (8 `lane_board`, 1 `team_status`) against **7** (5 `team_status`, 2
`lane_board`). The eight `lane_board` reads are an agent looking at the board before it opens its lane
("Now let me check the board and open a lane for my work"). The orientation reply names the open-lane
count; whether that invites the read is not something ten pairs can say.

**R3b, the six.** All six are a completion note ("Completed … Committed and pushed to team/agent1",
"Final patch.txt created …") sent as `status_update`; the claim run's first ten (in
[`run.log`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/run.log)) begin with "Starting work
on …" posts that no longer appear. `status_update` acts in all: 13 (7 of them state signals) against 57.
No instruction says to post status now, and the agents mostly stopped.

**R3c, by kind** (`sends.py`):

| Kind | This run | Claim run |
| --- | --- | --- |
| pushed / fetch | **14**, $0.26 | 10, $0.20 |
| merged / complete / submitted | **12**, $0.26 | 16, $0.34 |
| lane done / you can edit | **8**, $0.17 | 4, $0.08 |
| waiting / ETA | 3, $0.06 | 2, $0.04 |
| thanks / ack | 1, $0.02 | 1, $0.02 |
| other | 3, $0.08 | 1, $0.01 |

No kind fell. "Lane done / you can edit", the kind ADR 724's act now carries for the holder, doubled;
"merged" fell by four; "pushed", which has no product event, rose by four. All `team_send` calls: 119,
$2.42, against 141, $2.94.

**Rider 2** (`rider2.py`, both runs read with the same code; the claim-run numbers were read first):

| | This run | Claim run (`core`) |
| --- | --- | --- |
| pairs with at least one held refusal | 10 of 10 | 10 of 10 |
| held refusals (`lane.gate` deny, `hold = held`) | 15 | 16 |
| **ADR 724 acts delivered** (`meta.lane_freed`) | **10**, in 9 pairs | 0 (not built) |
| what the refused seat did next, after the act | `git` in Bash 7 · the lane wait 1 · an edit 1 (one pair got two acts) | — |
| holder's state-signal sends, total (per pair) | **18** (3, 1, 1, 0, 3, 3, 3, 0, 1, 3) | 23 (3, 1, 3, 0, 1, 2, 1, 2, 7, 3) |
| how the holder's lane freed the file | released 3 · done, submitted or narrowed, read from the act 6 · ADR 693 takeover 1 | released 4 · takeover 3 · never, before the run ended 3 |
| holder freed the file → refused seat's next gated edit of it, seconds (median) | 7, 20, 24, 27, 30, 43, 45, 50, 70 (**30**); one pair no later gated edit | 20, 25, 30, 35, 36, 43, 99 (**35**); three pairs never freed |

The act arrived in every pair but one (llama_index, where the holder left and the refused seat took
the lane over under ADR 693 instead). Seven of the ten receivers went straight to git — the act names the
holder's branch and head — one waited again on the lane, one edited. Holder signals fell from 23 to 18
with no rule and per-pair counts of 0–3, which is inside the noise; the pair that sent 7 before sent 1.
The time from the file freeing to the refused seat's next gated edit of it is read on nine pairs against
seven, with medians of 30 and 35 seconds: the act did not visibly shorten it, and ten pairs could not show
a change of that size.

Reported beside them, with no rule:

- **Held refusals and the next move** (rider 1's counts, for the record; the rule was read in finding
  024 and is not read again): 15 held refusals; the next musterd move was the one-call lane wait after
  **7**, a `message` to the holder after 7, `request_help` after 1. The claim run on these pairs: the lane
  wait after 2 of 29 held refusals over 20 pairs (finding 022, corrected).
- **Pass rate:** 5 of 10 (outlines 1655, tiktoken 0, jinja 1559, jinja 1621, typst 6554). The claim run
  passed 4 of these 10 by the same `readout.json` (the manifest wrote 3). Ten pairs decide nothing about
  passing (findings 018 and 021).
- **Merge:** all 10 pairs ended with identical patches (no conflict), as in every musterd run since pilot 3.
- **Cost:** $17.94, against $17.29; 988 steps against 1032; 26 min 43 s wall time (agent time 71 min).
  `cats.py`: work $5.36 (was $5.95), musterd / wait / gate $5.34 ($4.77), git $3.57 ($3.01), messages $2.13
  ($2.18). `mtools.py`: blocking waits 86 ($1.56) against 65 ($1.20); plain inbox checks 45 against 39;
  `lane_board` 31 against 33; `lane_resolve` 15 against 8.
- **Errors:** none; no API-limit line in any stream; `MUSTERD_REF` and `claude_code_version` 2.1.307 in
  every pair.

Per pair: [`readout.json`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/readout.json); the
residue tables and the labelled calls in
[`residue/`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/residue/); rider 2 per pair and per
act in [`rider2.json`](./cooperbench/pilot-runs/2026-10-24-coordination-cost/rider2.json).

## What it means

Of the three groups finding 022 named, one went with its instruction: with nothing telling an agent to
post status, the "starting work on …" posts stopped, and what is left of `status_update` is six
completion notes. The orientation reads did not go, and the rule as pre-registered could not have seen
them go, because the baseline counted the one orientation call itself; past that call the reads were
seven and are nine, so the join reply did not replace the agent's look at the board before it opens a
lane. The signals did not fall either: ADR 724's act reached the refused seat in nine of ten pairs and
most of them acted on it at once, but the holders went on announcing as well, and the "pushed" signal,
which has no product event, grew. The cost finding 022 put at $0.5–1 was inside the run-to-run spread
before this run and this run spent $0.65 more, so cost decides nothing, as pre-registered.

What a product change can take from this: the act works as a wake-up (seven of ten receivers went to
git on it), so the next event to carry is the push (finding 022's next step 2), which is now the largest
signal kind by count; and the one-call orientation needs to answer the question the `lane_board` read
asks — what is on the board before I open a lane — or it will not replace it.

## Not gaming

The run added no instruction, hint or tool to the arm. The agents' instructions are the claim run's
(#3177), byte-identical; the solo and team arms did not run. The build moved from `7e795fcb` (claim
run) to `c9ac2819`; what the agents see that the claim run's agents did not is the orientation block
on the first reply, no status-update instruction in the primer or the per-prompt nudge, ADR 724's
directed act, and #3219's refusal text — the product every seat gets. The gate smoke was changed for
this run's pre-flight only (a `Read` tool for the smoke's model); no arm wiring changed, and
`hold_smoke_697.py` ran as committed. Follow-up: `gate_smoke.py` needs `Read` in its tool list, or it
cannot pass on Claude Code 2.1.307.
