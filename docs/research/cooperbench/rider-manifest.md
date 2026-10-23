# CooperBench rider run: rider 1 on the 9 claim-run pairs with held refusals

**Lane:** `01M5MS3PK0` (goal `cooperbench`). **Status:** pre-registered 2026-10-23, before any pair ran.
**Spend:** nick approved about $17 of model spend, hard stop $25 (2026-10-23).

## What it reads

[Rider 1](./riders.md#rider-1-does-the-held-file-refusal-now-lead-agents-to-wait-not-message-3219),
unchanged: of the held-file refusals agents see, the share whose next musterd move is
`team_inbox_check {wait, until_lane}`. Baseline 2/29 (claim run, old refusal text). One-sided
Fisher's exact test, read once, only if `H ≥ 8`, against the threshold table in `riders.md`.

Reported beside it, with no rule: the same nine pairs' baseline in the claim run (1 of 19 held
refusals), the share followed first by a message to the holder, pass rate, and cost.

## Why these pairs

A rider needs held refusals, and most pairs never produce one. These are the claim run's musterd
pairs with two or more held refusals (19 of the run's 29, at $16.47). Choosing pairs that refused
before can only raise `H`; it does not favour either answer, because the rider reads what an agent
does after a refusal, not whether one happens.

| Repo | Task | Features |
| --- | --- | --- |
| llama_index | 18813 | 3, 6 |
| react_hook_form | 153 | 2, 6 |
| pallets_jinja | 1621 | 6, 10 |
| pallets_click | 2800 | 1, 4 |
| openai_tiktoken | 0 | 4, 8 |
| go_chi | 27 | 3, 4 |
| go_chi | 26 | 1, 2 |
| dspy | 8563 | 1, 4 |
| dottxt_ai_outlines | 1371 | 3, 4 |

`riderset.json` beside this page is the subset CooperBench reads.

## How it runs

The musterd arm alone: `claude_code_musterd`, Claude Code 2.1.307, `claude-sonnet-4-5`, `--setting coop
--git -c 3`, gate in block posture, image deployed from main at or after #3260 (it carries #3219's
refusal text, `readout.py`'s `held_refusal_moves`, `spend_guard.py` and `run_arms.py`'s group kill).
`pilot-runs/2026-10-23-rider/rider.sh` runs the host smokes (`gate_smoke.py`,
`hold_smoke_697.py`), pulls the nine images, then the arm under `run_arms.py --cap 24.95`, then
`readout.py`. No smoke pair: the claim run already ran these pairs in this arm, and its $2 goes
nowhere the rider reads.

Nothing here changes what an agent is told or how a pair is scored.
