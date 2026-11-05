# CooperBench rider 8: pre-registration

**Lane:** `01M6PZZWKY` (this page and the arm change), goal `coordination-cost`, asked by nick
(2026-11-05 ~23:10Z in session, choosing the arm-guidance option from
[finding 033](../033-cooperbench-rider7-rerun-b.md)'s decision: "lets go with your recommendation").
The run is its own lane. **Status:** pre-registered 2026-11-05, before the arm change has run on any
pair. Nothing below changes once a measured pair has run. **CooperBench:** `63b9d44`. **Before this:**
[rider 7](./riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act)
→ findings 031, 032, 033; [ADR 809](../../decisions/809-harness-exit-releases-the-reclaim-hold.md) and
[ADR 810](../../decisions/810-compacted-continuation.md).

## Why

Finding 033 read the act lane on the ADR 809/810 build: a wake follows an act in a median 6.7 s and
carries a compacted brief for about $0.18, and the ten pairs still cost $22.50 against finding 028's
$18.45 — because the two first calls are the pair ($18.06 of $22.50), and inside them the seats made
46 wait-mode `team_inbox_check` calls and 22 shell sleeps, with every act that arrived during a first
call riding the interrupt line, not the lane. The act lane cannot wake a seat that never ends its
turn. The arm's act-lane protocol already says "when you must wait for a partner, end your turn", one
indented line under a workflow that says "check" before each step. Rider 8 asks whether saying it
first, and plainly, moves the waiting out of the first calls and the cost with it.

## Treatment (arm only; no product change)

Three changes to the arm, each in the lane's scope and pinned by `test_act_lane.py`:

1. **The turn rule leads the protocol** (`prompt.py`, `_TURN_RULE_ACT`): a block before the tool table
   — your turn is short; the host wakes you on your partner's act with your work so far; the moment you
   wait on your partner for anything, end your turn with one line saying what you wait for; no
   wait-mode check, no `sleep`, no re-reading the board.
2. **The workflow's "check" step says it too** (`_CHECK_ACT`): check once after major edits and once
   before submitting; if the inbox is empty and you cannot proceed without your partner, end your turn.
   The launch-lane text is unchanged.
3. **`Bash(sleep:*)` is denied** on the act lane (`config.py`, `ACT_LANE_DENY`, in
   `settings.local.json` beside the permission floor). Claude Code's prefix rule catches a bare
   `sleep N`; a sleep inside a loop is guidance's to prevent and `mtools.py`'s to count.

Everything else is finding 033's: `MUSTERD_ARM_LANE=act`, the pair policy with `resume_max_usd 0.25`,
`claude-sonnet-4-5`, `-c 3`, the ten `core` pairs, `run_arms.py --cap 110` and `wake_guard.py
--pair-cap 6 --total-cap 110`, the idle end and the 7,200 s cap, `main` at or after this lane's merge.

## Rules

Read once from the ten pairs (errors re-run once, in place), with the pre-registered scripts
(`mtools.py`, `sends.py`, `boardreads.py`, `rider7.py`, `firstwake.py`) unchanged.

| | Count | Finding 028 | Finding 033 | Acted | Did not |
| --- | --- | --- | --- | --- | --- |
| R8a | turns spent waiting: wait-mode `team_inbox_check` calls **+ shell sleeps** (`mtools.py` `wait:bash-sleep`) **+ wakes** | 90 + 0 + 0 = 90 | 46 + 22 + 25 = **93** | **≤ 55** | **≥ 85** |
| R8b | model dollars, 10 pairs, first calls plus every wake | **$18.45** | $22.50 | **≤ $18.00** | **≥ $22.00** |
| R8c | first-call dollars (the pair's two first calls, summed over 10 pairs) | $18.45 (whole pairs) | $18.06 | **≤ $12.00** | **≥ $17.00** |

Between the bounds, "part of it". R8b is the decision: it is the question finding 033 left — can the
loop beat the loop it replaced. R8a says whether the waiting moved; R8c says whether it moved out of the
first calls, which is the only place it could come from. Reported beside them with no rule: wakes per
pair and their `compacted` share, median act→wake wait (R7c, expected ≈ 7 s), first-wake `reclaimable`
(R7d, expected 0), plain `team_inbox_check` calls, board reads before the first claim, sends and state
signals, edit refusals, pass, conflicts, pairs that hit the cap.

**A new error class.** A seat that ends its turn and is never woken because its partner never sends
it an act — a pair that ends with one patch missing and no wake on that seat — is a **coordination
loss of the treatment**, counted and named per pair, not re-run. Three such pairs in the first five
stop the run: the rule is ending turns the lane cannot resume.

**Not gaming.** The three changes are the arm's instructions and settings, which every arm sets; the
product is finding 033's build. Nothing is added that exists only for the benchmark.

## Spend

Finding 033's run cost $22.50 model for ten pairs plus a smoke pair; the treatment is meant to lower
it. Hard stop **$110**, guards as before. Fly: `cb-run-2` on a new image; the deploy token nick minted
2026-11-05 ~19:25Z is still on `musterd-joiner-1` (nick's decision, finding 033 run log) and expires
~2026-11-07 07:00Z — the run must start before then or needs a new token.

## Procedure

As the rider 7 re-run's, with the smoke-pair gate changed: 1 deploy from `main` at or after this
lane's merge (`mkdir -p` + `chmod 1777` the swe_agent `trajectories` directory); 2 api check and both
host smokes PASS; 3 one smoke pair (`pallets_click` 2068) under the wake guard that must show **at least
one seat ending its first call with "waiting for" in its last line and being woken afterwards**, and
`wait:bash-sleep` 0 in its host logs; 4 the ten pairs under both guards; 5 errors re-run once, the run
folder, machine stop; 6 read R8a–c, finding 034.

## Decisions

| Decision | Answer |
| --- | --- |
| Which of finding 033's three options | nick, 2026-11-05 ~23:10Z, in session: the arm-guidance option ("lets go with your recommendation") |
| Spend (10 pairs, stop $110) | approved with the option |
| Finding number | 034 |
