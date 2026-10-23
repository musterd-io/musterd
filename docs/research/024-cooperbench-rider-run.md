# 024 — CooperBench rider run: the new held-file refusal did not measurably make agents wait

> **Status:** 2026-10-23, lane 01M5MS3PK0 (lazara), asked for by nick. Pre-registered 2026-10-23
> ([manifest](./cooperbench/rider-manifest.md), merged 17:33Z); run 17:40Z–18:07Z the same day.
> **Verdict: no change measured.** After #3219's refusal text, refused agents waited on the
> holder's lane in one call after **2 of 11** held refusals, against 2 of 29 before. Rider 1 needed
> 4 of 11 (one-sided Fisher's exact test, p = 0.30). #3219 stays in place: it reads better for a
> person too.

## Question

[Rider 1](./cooperbench/riders.md#rider-1-does-the-held-file-refusal-now-lead-agents-to-wait-not-message-3219):
after #3219 put the one-call wait on the holder's lane first in the held-file refusal, does an agent's
next musterd move after a held refusal become `team_inbox_check {wait, until_lane}` more often than
the claim run's 2 of 29?

## Setup

As the manifest says. The musterd arm alone (`claude_code_musterd`, Claude Code 2.1.307,
`claude-sonnet-4-5`, `--setting coop --git -c 3`, gate in block posture) on the claim run's 9 musterd
pairs with two or more held refusals, on `musterd-cooperbench` deployed from main `780c236` (carries
#3219, #3254 and #3260). It ran under `run_arms.py` with a $24.95 hard stop
([`rider.sh`](./cooperbench/pilot-runs/2026-10-23-rider/rider.sh)), was scored by CooperBench's
unchanged evaluator, and was read by `readout.py`'s `held_refusal_moves`, unchanged.

**Pre-flight:** nick confirmed the API limit covered $25. `gate_smoke.py` passed ($0.005) and
`hold_smoke_697.py` passed ($0.008), each as the unprivileged `smoke` user. No smoke pair, as
pre-registered. No pair errored and no stop fired.

## Result

| Next move after a held refusal | Rider run (new text) | Claim run, 20 pairs (old text) |
| --- | --- | --- |
| `team_inbox_check {wait, until_lane}` | **2** | **2** |
| `team_inbox_check` (no wait) | 1 | 4 |
| `team_inbox_check {wait}` (no lane) | 0 | 4 |
| a message to the holder (`message`) | 4 | 19 (all messages) |
| `request_help` to the holder | 2 | (in the 19) |
| an edit before any musterd move | 2 | not read then |
| **Held refusals (`H`)** | **11** | **29** |

`H = 11 ≥ 8`, so the rule is read. The threshold at `H = 11` is `k ≥ 4` (computed as the table in
`riders.md` is; it gives the table's values at 8, 10 and 12). `k = 2`, p = 0.30: **no change
measured.**

Reported beside it, with no rule:

- **The same nine pairs before:** 1 of their 19 held refusals was followed by the lane wait. Now 2 of 11.
- **Followed first by asking the holder** (`message` or `request_help`): 6 of 11, against 19 of 29.
- **Where the refusals fell:** 5 of the 9 pairs saw one (outlines 1371, go_chi 26 and 27, tiktoken 0,
  jinja 1621). The other 4 saw none this time, though each had at least two before.
- **Pass rate:** 3 of 9 (go_chi 26, tiktoken 0, jinja 1621). The same pairs passed 2 of 9 in the claim
  run.
- **Merge:** all 9 pairs ended with identical patches (no conflict).
- **Cost:** $17.67, against $16.47 for the same pairs in the claim run. 24 minutes wall time.

Per pair and per move: [`readout.json`](./cooperbench/pilot-runs/2026-10-23-rider/readout.json).

## What it means

Putting the lane wait first in the refusal did not move agents onto it at a rate this run could see.
Asking the holder did fall from about two in three to about one in two, but no rule was set on that
share, and eleven refusals cannot separate it from noise. The micro-test (finding 022's follow-up)
found fresh agents mostly wait already. Agents deep in a real feature still mostly ask, whatever the
refusal leads with.

A larger run would not be the next step for this question. Getting held refusals is the expensive
part: half of these pairs did not produce one this time. If the residue in finding 022 still matters,
the product change is on the holder's side (the push signal in `docs/design/lane-push-signal.md`),
not more wording in the refusal.

## Not gaming

The rider added no instruction, hint or tool to the arm. The agents' instructions are the claim run's
(#3177). The build moved 70 commits, from `7e795fcb` to `780c236`. Besides #3219's refusal text and the
run tooling, which an agent never sees, the one change to the musterd tools is #3214: the blocking wait
arms before its pre-check, so it cannot miss a wake-up. That changes how the wait behaves, not whether an
agent chooses it.
