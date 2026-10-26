# 027 — CooperBench rider 5 run: the push now reaches a seat in 12 of 22 cases, the pusher was told every time, and 8 of the 12 said it again anyway

> **Status:** 2026-10-26, lane 01M5V4HH6Z (lazara), asked for by nick. Pre-registered 2026-10-25
> ([rider 5](./cooperbench/riders.md#rider-5-finding-026s-two-follow-ups--the-push-reaches-the-lanes-that-cover-its-files-and-the-pusher-is-told),
> [manifest](./cooperbench/rider5-manifest.md), #3318) before [ADR 731](../decisions/731-push-reaches-covering-lanes.md)
> landed (#3319); run 04:23Z–04:53Z the next day. **Rider 5, read once:** R5a "pushed / fetch" sends
> **12** calls, $0.25 (finding 026: 18; rule ≤ 5 / ≥ 12) — **the change did not act**, at the bound. R5b
> recorded pushes that fired an act **12 of 22** (55%; finding 026: 4 of 20; rule ≥ 80% / ≤ 40%) — **part
> of it**. R5c announced pushers who said it by hand anyway **8 of 12** (67%; finding 026: 3 of 4; rule
> ≤ 25% / ≥ 60%) — **the change did not act**. Beside them: the hook's line reached the pusher after
> **22 of 22** recorded pushes; the ADR 691 refusal carried the pushed head in **16 of 28** refusals.
> Pass 5 of 10, $18.54.

## Question

Finding 026 found ADR 730's push event reliable and its audience empty for 16 of 20 pushes, and 3 of
the 4 announced holders repeating the announcement by hand. ADR 731 made three changes: the audience
adds every other seat whose contending lane in the same project covers a file the pushing lane names;
`POST /lanes/push` answers with the seats told and the hook reads that back to the pusher as one
PostToolUse context line; the ADR 691 refusal names the holder's last pushed head. Did the wider
audience put the act in front of the seat that needed it (R5b), did that remove the "pushed / fetch"
message (R5a), and did the pusher's line stop the holder from saying it again (R5c)? Each rule stands
alone.

## Setup

As the manifest says. The musterd arm alone (`claude_code_musterd`, Claude Code 2.1.307,
`claude-sonnet-4-5`, `--setting coop --git -c 3`, gate in block posture) on CooperBench's 10 `core`
pairs, on `musterd-cooperbench` deployed from main `8cf0277b` (#3319; `MUSTERD_REF` in every pair's
log). The agents' instructions are the claim run's, byte-identical; the arm's settings are rider 4's
(the hook command text did not change). Run under `run_arms.py` with the hard stop
([`r5.sh`](./cooperbench/pilot-runs/2026-10-25-rider5/r5.sh)), scored by CooperBench's unchanged
evaluator, read by the claim run's residue scripts unchanged, `rider2.py` and `rider4.py` unchanged, and
[`rider5.py`](./cooperbench/pilot-runs/2026-10-25-rider5/rider5.py) (new, written before the readout).
Pre-flight in the [run log](./cooperbench/pilot-runs/2026-10-25-rider5/run.log): API check `ok`,
`gate_smoke.py` PASS $0.0035, `hold_smoke_697.py` PASS $0.0083; one $0 stumble (the trajectories
directory's world-writable bit, reset by the redeploy, was first put on the wrong path).

## Result

### R5b — recorded pushes that fired an act: 4 of 20 → 12 of 22, part of it

The hook reported 22 pushes (`rider4.py` counts 23 `git push` commands; one left the remote-tracking ref
elsewhere and reported nothing, as ADR 730 §1 says). The daemon recorded all 22 and fired an act for
**12** (finding 026: 4), to the covering partner in all 12 — `covering: 1` on every fired record, and
`watchers: 1` as well on 6 of them. The receiver's next move after the act: `bash` (a fetch or merge,
in stream order) 10 times, a wait twice.

The 10 pushes that fired nothing all have `covering: 0, watchers: 0`, and all for one reason, visible
in [`pushwhy.txt`](./cooperbench/pilot-runs/2026-10-25-rider5/pushwhy.txt): **the partner's lane had
already left the contending states.** In every pair the first mover finishes, resolves (8), releases
(jinja 1621, twice) or hands off (typst) its lane, and *then* the second mover edits and pushes. By the
time of that push there is no other contending lane on the project, so ADR 731's audience is empty —
by construction, as ADR 730's was for the refused seat's push. The finished partner is not done with
the branch, though: in 7 of the 10 pairs the first mover went on to merge the second mover's branch
and write the combined patch ("I've merged your changes. patch.txt now contains both our features").

| Pair | Pushes | Fired | Why not |
| --- | --- | --- | --- |
| outlines 1655 | 2 | 1 | agent1 resolved before agent2 pushed |
| dspy 8563 | 2 | 1 | agent2 resolved before agent1 pushed |
| go-chi 27 | 2 | 2 | — |
| llama-index 17244 | 2 | 1 | agent1 resolved before agent2 pushed |
| tiktoken 0 | 2 | 1 | agent1 resolved before agent2 pushed |
| click 2800 | 3 | 2 | agent2 resolved before agent1's second push |
| jinja 1559 | 2 | 1 | agent2 resolved before agent1 pushed |
| jinja 1621 | 3 | 1 | agent1 released its lane; agent2 pushed twice after |
| react-hook-form 153 | 2 | 1 | agent2 resolved before agent1 pushed |
| typst 6554 | 2 | 1 | agent2 handed its lane to agent1; agent1 then owned every lane |

12 of 22 is 55%, between the bounds (≥ 80% acted, ≤ 40% did not): **part of it**. Of finding 026's three
reasons, two are gone — the refused seat's own push now has an audience while the partner's lane is
open (go-chi, click), and a holder's push before the partner's refusal reaches the covering partner
(outlines, go-chi, click, jinja 1621, react-hook-form) — and the third, the push after the partner's
lane ended, is the whole remainder.

### R5a — "pushed / fetch" sends: 18 → 12, the change did not act (at the bound)

`sends.py`, unchanged: 100 send calls ($2.12), 43 of them state signals ($0.92). By kind:

| Kind | This run | Finding 026 | Finding 025 | Claim run |
| --- | --- | --- | --- | --- |
| pushed / fetch | **12**, $0.25 | 18, $0.35 | 14, $0.26 | 10, $0.20 |
| merged / complete / submitted | 16, $0.35 | 14, $0.33 | 12, $0.26 | 16, $0.34 |
| lane done / you can edit | 11, $0.24 | 10, $0.20 | 8, $0.17 | 4, $0.08 |
| waiting / ETA | 1 | 1 | 3 | 2 |
| thanks / ack | 1 | 2 | 1 | 1 |
| other | 2 | 1 | 3 | 1 |

12 sits exactly on the rule's "did not act" bound (≥ 12). Read as pre-registered: **the change did not
act**. Eight of the twelve are the R5c repeats below, by pushers whose push the daemon had announced;
the other four are by pushers it had not (the partner's lane had ended).

### R5c — announced pushers who said it by hand anyway: 3 of 4 → 8 of 12, the change did not act

`rider4.py`'s `hand_pushed_sends` with `push_acts_so_far ≥ 1`, over the 12 announced pushers: **8**.
The pusher's hook line was there every time — in the agents' session transcripts, 12 pushes read
"`<seat> was told to fetch it before editing the files your lane names — no need to say so by hand`"
and 10 read "no other lane covers the files it names … so no one was told" (22 of 22; the stream-json
the arm captures carries no hook output, so `rider5.py`'s stream count is 0 — the run log has the grep).
The eight repeats, in the pushers' words:

- outlines agent1: "My changes … are committed and pushed. I added hex_str, uuid4, and ipv4 after the whitespace line. You can fetch and merge"
- dspy agent2: "Done with fingerprinting - committed and pushed to agent2. Added fingerprint/id fields … Your validate_input can go ahead."
- go-chi agent1: "Committed and pushed logging feature. HandleFunc now parses HTTP methods like Handle does. You can fetch team/agent1"
- click agent1: "Already updated lane to just shell_completion.py. core.py is all yours. I've pushed my changes (03abe08) …"
- jinja 1559 agent2: "My work is complete and committed (f9eead3d). I added ConditionalI18nExtension class after line 571. You can add your …"
- jinja 1621 agent1: "Released my lane. You can now edit src/jinja2/loaders.py. My path_transform changes are committed on agent1 branch."
- react-hook-form agent2: "Done! Pushed my changes to team/agent2 (commit 96a6606a). You can merge now - I've added TSubmitContext generic …"
- typst agent2: "Handing off str.rs lane. My skip_whitespace changes are committed and pushed on agent2 branch. You can build on top …"

Every one carries more than "pushed": what changed and where, what the partner may now do, a lane
state. The line told the pusher the *push* had been announced; the message the pusher wanted to send
was not about the push. 8 of 12 is 67%, past the rule's "did not act" bound (≥ 60%).

### Beside the rules

- **The refusal carried the pushed head** in 16 of 28 held refusals ("Their branch agent1 is on team at
  …"): the holder had pushed before the partner's refusal in those. The other 12 refusals came before any
  push, as ADR 731 §3 expects.
- **ADR 724 acts: 8** of 9 pairs with a held refusal (the ninth, typst, a handoff — no act owed; finding
  026: 7 of 10). Freed-to-edit 21–67 s.
- **Board reads before the first claim**, minus the instructed first inbox check (rider 4's R4a read):
  **5** (finding 026: 6; 025: 9), all `lane_board` right before `lane_open`. Total board reads 83.
- **Status updates: 9** (finding 026: 9).
- **Cost $18.54** (finding 026: $18.91; 025: $17.94), 848 calls, median 44 per agent. `cats.py`: work
  34%, musterd/wait/gate 28%, git 20%, messages 9%. `ToolSearch` 60 calls, $1.17. Dropping the
  state-signal calls would leave $17.62; dropping the waits, $16.34.
- **Pass 5 of 10** (finding 026: 3; 025: 4; claim run 4). No conflicts, no errored pair, nothing re-run,
  no API-limit line. Ten pairs decide nothing about passing (findings 018, 021).

## What it means

**R5b.** The covering audience is the right one while both lanes are open: every push with a
contending partner lane was announced, and the receiver fetched. What it does not reach is the partner
who has *finished* — and on a two-seat task the finished partner is the one who merges. A lane that
ended minutes ago on the same file is still a recorded interest; ADR 731 §1 reads only contending
states, so the second mover's push lands in silence every time. The candidate change is small: for the
covering set, also count lanes that left the contending states within a window (the same task's
lifetime, say 30 min) and still have an owner on record. That is one `listLanes` filter and a rider.

**R5c and R5a.** Telling the pusher the daemon had spoken did not stop the message, because the message
was never only "I pushed". The eight repeats are hand-offs: here is what I changed, here is what you may
do now, here is the lane state. The push act carries the branch and head and nothing about the work;
the ADR 724 freed act carries the lane state. What neither carries is the one sentence of *what changed*
that every repeat opens with. The remaining lever is not a louder line to the pusher — the line was read
— but an act that carries that sentence, which only the pusher can write; or accepting that one message
per hand-off is the floor for this workload. "pushed / fetch" at 12 is below finding 026's 18 and 025's
14, and at the claim run's 10 plus two.

**Not the finding.** Pass 5 of 10 and $18.54 are inside the range ten pairs move on their own.

## Not gaming

As pre-registered: nothing was added to any arm for this run. The agents' instructions are the claim
run's, byte-identical; the arm's settings are rider 4's. The reads are the claim run's scripts, rider
4's scripts, and `rider5.py`, written before the readout and committed with the run. The one read made
after the readout — the grep over the session transcripts for the hook's line — is recorded in the run
log with its command; it adds a count the pre-registered script could not reach, and changes no rule.

## Data

Per pair: [`readout.json`](./cooperbench/pilot-runs/2026-10-25-rider5/readout.json); residue
([`residue/`](./cooperbench/pilot-runs/2026-10-25-rider5/residue/)); rider 2
([`rider2.json`](./cooperbench/pilot-runs/2026-10-25-rider5/rider2.json)); rider 4
([`rider4.json`](./cooperbench/pilot-runs/2026-10-25-rider5/rider4.json)); rider 5
([`rider5.json`](./cooperbench/pilot-runs/2026-10-25-rider5/rider5.json)); daemon push lines and
stream order per pair ([`pushwhy.txt`](./cooperbench/pilot-runs/2026-10-25-rider5/pushwhy.txt));
[run log](./cooperbench/pilot-runs/2026-10-25-rider5/run.log), [pre-flight](./cooperbench/pilot-runs/2026-10-25-rider5/preflight.log).
