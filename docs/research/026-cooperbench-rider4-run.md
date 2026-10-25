# 026 — CooperBench rider 4 run: the daemon saw every push and told almost nobody, and the open lanes in the orientation block took three of nine board reads

> **Status:** 2026-10-25, lane 01M5SZXMJX (lazara), asked for by nick. Pre-registered 2026-10-24
> ([rider 4](./cooperbench/riders.md#rider-4-finding-025s-two-follow-ups--the-open-lanes-in-the-orientation-block-and-the-push-as-an-event))
> and 2026-10-25 ([manifest](./cooperbench/rider4-manifest.md), merged #3316); run 17:15Z–17:45Z the
> same day. **Rider 4, read once:** R4a board reads past the first call **6** (finding 025: 9; rule ≤ 3 /
> ≥ 8) — **part of it**. R4b "pushed / fetch" sends **18** calls, $0.35 (finding 025: 14, $0.26; rule
> ≤ 5 / ≥ 12) — **the change did not act**. Beside them: the push hook reported **20 of 20** pushes and
> the daemon recorded every one; it sent **4** push acts, because the other 16 pushes had no seat
> watching the lane. ADR 724 acts **7**. Pass 3 of 10, $18.91.

## Question

Finding 025 left two product changes to make and pre-registered their reads. (R4a) The one-call
orientation lists the open, unowned lanes beside the held ones and says `lane_open` checks overlap, so
the agent has no reason to read `lane_board` before it opens. Did the board reads after the instructed
first call fall from 9? (R4b) A `git push` of a lane's branch is an event: the hook reports it, the
daemon records it on the lane and tells the seats waiting on that lane ([ADR 730](../decisions/730-push-is-an-event.md)).
Did the "pushed / fetch" messages fall from 14? Each rule stands alone. Beside them, with no rule, the
ADR 724 and ADR 730 acts delivered.

## Setup

As the manifest says. The musterd arm alone (`claude_code_musterd`, Claude Code 2.1.307,
`claude-sonnet-4-5`, `--setting coop --git -c 3`, gate in block posture) on CooperBench's 10 `core`
pairs, on `musterd-cooperbench` deployed from main `70d0170a` (#3315; carries #3309, #3310, #3314;
`MUSTERD_REF` in every pair's log). It ran under `run_arms.py` with the hard stop
([`r4.sh`](./cooperbench/pilot-runs/2026-10-25-rider4/r4.sh)), was scored by CooperBench's unchanged
evaluator, and was read by the claim run's residue scripts unchanged (`boardreads.py`, `sends.py`,
`mtools.py`, `cats.py`), by `readout.py`, by the coordination-cost run's `rider2.py` unchanged, and by
[`rider4.py`](./cooperbench/pilot-runs/2026-10-25-rider4/rider4.py) (new: pushes, push acts, hand-sent
pushed messages, per pair). The per-pair daemon logs and stream order are in
[`pushwhy.txt`](./cooperbench/pilot-runs/2026-10-25-rider4/pushwhy.txt).

**Pre-flight** ([run log](./cooperbench/pilot-runs/2026-10-25-rider4/run.log)): API check `ok`;
`gate_smoke.py` (committed, with `Read`) PASS $0.0035; the committed `hold_smoke.py` FAILs on this build
because it predates ADR 697 — agent2's post-lapse retry is refused once as the hand-over, and the smoke
expects it allowed — so `hold_smoke_697.py`, the check the README names, ran instead: PASS $0.0096. A
first smoke attempt failed before any model call because the wrapper put the agent-side packed CLI (no
sqlite binding) first on `PATH`; corrected, $0. Smokes ≈ $0.017. The arm's agents saw one more thing
than finding 025's: the PostToolUse push hook in their settings (#3314). Nothing else changed.

## Result

### R4a — board reads past the first call: 9 → 6, part of it

`boardreads.py`, `context = before_claim`, minus each agent's instructed first `team_inbox_check`
(20 of 26). Six remain, against finding 025's 9 and the claim run's 7:

| Pair | Agent | Read | Next move | What the agent said first |
| --- | --- | --- | --- | --- |
| outlines 1655 | agent2 | `team_status` | read | "joining the team and coordinating with agent1" |
| outlines 1655 | agent2 | `lane_board` | claim | (same turn) |
| tiktoken 0 | agent2 | `lane_board` | claim | "joining the team and coordinating with agent1" |
| click 2800 | agent2 | `lane_board` | claim | "joining the team and coordinating with agent1" |
| jinja 1559 | agent1 | `lane_board` | claim | "joining the team and coordinating with agent2" |
| jinja 1559 | agent2 | `lane_board` | claim | "joining the team and coordinating with agent1" |

Five of the six are the same move finding 025 saw eight times: `lane_board` right before `lane_open`.
The block now tells the agent that `lane_open` checks overlap and that the open lanes are listed, and
15 of 20 agents went straight to `lane_open`; 5 still read the board first. Between the rule's
bounds (≤ 3 acted, ≥ 8 did not): **part of it**. Total board reads 82 (finding 025: 85), `lane_board`
28 (34), `team_status` 8 (6).

### R4b — "pushed / fetch" sends: 14 → 18, the change did not act

`sends.py`, unchanged: 112 send calls ($2.27), 46 of them state signals ($0.95). By kind, against
finding 025's run:

| Kind | This run | Finding 025 | Claim run |
| --- | --- | --- | --- |
| pushed / fetch | **18**, $0.35 | 14, $0.26 | 10, $0.20 |
| merged / complete / submitted | 14, $0.33 | 12, $0.26 | 16, $0.34 |
| lane done / you can edit | 10, $0.20 | 8, $0.17 | 4, $0.08 |
| waiting / ETA | 1 | 3 | 2 |
| thanks / ack | 2 | 1 | 1 |
| other | 1 | 3 | 1 |

18 is past the rule's "did not act" bound (≥ 12). `rider4.py`'s wider regex (any send body naming a
push, fetch, pull or commit) finds 29, 20 of them sent after the sender's own `git push`.

### Why: the push was seen every time, and had an audience four times

The daemon log of every pair has `lane_push_recorded` for every push: **20 of 20** (each agent pushed
once, `git push team agentN [--force]`), all `POST /lanes/push` 200, the hook reporting the right
lane and head each time. So ADR 730 §1 (the hook) and §2 (the record) worked on every push, including
the `--force` and `|| true` spellings. §3 sent **4** acts; the other 16 records say `watchers: 0`.

ADR 730 sends the act to the seats with an open ADR 724 watch on the pushing seat's lane — seats the
gate refused for a file that lane holds, whose watch has not yet fired. On these pairs that set was
empty for 16 of 20 pushes, for three reasons visible in `pushwhy.txt`:

1. **The refused seat's own push has no watcher by construction** (10 of 20). In every pair one seat
   is the holder and the other is refused; the refused seat's push is the one the holder never waits
   on through the gate, so no watch names it. Those are the second push in every pair.
2. **The holder pushed before the partner was refused** (4 of the holders' 10): tiktoken 0, jinja
   1621, react-hook-form 153, typst 6554 — the holder's push landed first, the partner's refusal came
   after, and the watch opened on a lane whose push was already recorded. The daemon does not replay
   a recorded push to a watch that opens later.
3. **The holder pushed after the lane freed the file** (2 of the holders' 10): llama-index 17244
   (released, then the partner's push), jinja 1559 — the ADR 724 act had fired and closed the watch.

In the 4 pairs where the act did fire (outlines 1655, dspy 8563, go-chi 27, click 2800), the receiver's
next move was `bash` three times (a fetch or merge, in stream order) and `wait_until_lane` once. **The
holder announced by hand anyway in 3 of those 4** ("My changes committed and pushed to team/agent1",
"Changes pushed to team/agent1 … You can fetch and build", "Lane handed off. I've pushed my changes"):
the hook that reports the push tells the pusher nothing, so a holder has no way to know the daemon
already said it.

### Beside the rules

- **ADR 724 acts: 7** of 10 pairs with a held refusal (finding 025: 9 of 10). The three without: in
  tiktoken 0, click 2800 and react-hook-form 153 the holder handed the lane off to the refused seat
  (`lane_handoff`), which ADR 724 does not treat as the file freeing (the lane stays contending under a
  new owner) — rider 2 recorded them as "taken over by … (handoff)"; the new owner edits the file as
  its own lane's holder, so no act was owed. Freed-to-edit 13.5–44.6 s where measured.
- **Status updates: 9** (finding 025: 13; claim run 57). The instruction stays gone.
- **Cost $18.91** (finding 025: $17.94; claim run $17.29), 868 calls, median 46 per agent. `cats.py`:
  work 35%, musterd/wait/gate 27%, git 18%, messages 10%. `ToolSearch` 55 calls, $1.12 (finding 025:
  49, $1.00). Dropping the state-signal calls would leave $17.96; dropping the waits, $17.03.
- **Pass 3 of 10** (finding 025: 4 of 10 by the re-read, claim run 4). No conflicts, no errored
  pair, nothing re-run, no API-limit line. Ten pairs decide nothing about passing (findings 018, 021).

## What it means

**R4a.** The block answered the pre-open question for 15 of 20 agents and not for 5. The five read the
board after a reply that said "to start: lane_claim the one above that is your work, else lane_open —
it checks your scope against every lane here and warns on overlap, so no board read first" — and did
the read anyway, then opened. Three of the five are the second agent of its pair (agent2) reading a
board that already showed the partner's lane. The count is at 6 against bounds of 3 and 8; a further
product change here is not obviously worth a run of its own.

**R4b.** The event is real and the hook is reliable; the audience is wrong for this workload. ADR 730
chose the ADR 724 watch set as the audience because it is a recorded interest and not a guess
(Rejected: "tell every seat on the project, or the lane's partners by scope overlap"). On CooperBench
the seat that needs the push is the partner whose lane overlaps the pusher's — and that interest is
recorded too: `lane_open` warned both seats of the overlap (`surface_overlap`, named lanes) in every
pair. The data says the overlap-warned partner is the audience that was missing, for all three of the
reasons above at once: it exists before any refusal, it survives the lane freeing, and the refused
seat's partner is in it. The second gap is on the pusher's side: the push hook returns nothing to the
pusher, so a holder who pushed cannot tell that the daemon has already told the partner, and says it
again. Both are product changes with a pre-registration to write (rider 5), not a re-run of this one.

**Not the finding.** Nothing here says the agents coordinate worse or better than the claim run; cost
and pass rate moved within the range ten pairs move on their own.

## Not gaming

As pre-registered: nothing was added to any arm for this run. The agents' instructions are the claim
run's, byte-identical. The one addition to the arm's settings is the push hook every musterd seat gets
from `musterd init`, pinned to the same text. The reads are the claim run's scripts unchanged plus
`rider4.py`, written before the readout and committed with the run.

## Data

Per pair: [`readout.json`](./cooperbench/pilot-runs/2026-10-25-rider4/readout.json); residue
([`residue/`](./cooperbench/pilot-runs/2026-10-25-rider4/residue/)); rider 2
([`rider2.json`](./cooperbench/pilot-runs/2026-10-25-rider4/rider2.json)); rider 4
([`rider4.json`](./cooperbench/pilot-runs/2026-10-25-rider4/rider4.json)); daemon log lines and stream
order for every push ([`pushwhy.txt`](./cooperbench/pilot-runs/2026-10-25-rider4/pushwhy.txt),
[`pushwhy.py`](./cooperbench/pilot-runs/2026-10-25-rider4/pushwhy.py)); smokes
([`smokes/`](./cooperbench/pilot-runs/2026-10-25-rider4/smokes/)); [run log](./cooperbench/pilot-runs/2026-10-25-rider4/run.log).
