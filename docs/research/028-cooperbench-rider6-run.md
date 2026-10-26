# 028 — CooperBench rider 6 run: the push now reaches a seat in 19 of 22 recorded pushes, wait-mode inbox checks went up, and 12 of 17 announced pushers said it again

> **Status:** 2026-10-26, lane 01M5WJJGNJ (lazara), asked for by nick. Pre-registered 2026-10-26
> ([rider 6](./cooperbench/riders.md#rider-6-finding-027s-remainder--the-push-reaches-the-partner-whose-lane-just-ended-and-carries-what-changed),
> [manifest](./cooperbench/rider6-manifest.md), #3330) before [ADR 732](../decisions/732-push-reaches-ended-lanes-and-carries-what-changed.md)
> landed (#3331); run 17:35Z–18:07Z the same day. **Rider 6, read once:** R6a recorded pushes that fired
> an act **19 of 22** (86%; finding 027: 12 of 22; rule ≥ 90% / ≤ 70%) — **part of it**, four points under
> the bound. R6b `team_inbox_check` calls in wait mode **90**, $1.75 (finding 027: 82; rule ≤ 55 / ≥ 75) —
> **the change did not act**; the count rose. R6c announced pushers who said it by hand anyway **12 of
> 17** (71%; finding 027: 8 of 12; rule ≤ 25% / ≥ 60%) — **the change did not act**. Beside them: the
> push act carried the commit subjects on all 19 and the files on every one a receiver's transcript
> shows (17); 7 of the 19 acts went to a partner whose lane had already ended. Pass 4 of 10, $18.45.

## Question

Finding 027 left ADR 731 with one silent case and one unmoved message. The silent case: every push after
the partner's lane had ended, 10 of 22, though that partner was the one who merged. The unmoved message:
8 of 12 announced pushers wrote "pushed, here is what changed" by hand with the daemon's line in front
of them. ADR 732 made the ended partner an audience for 30 minutes and put git's own "what changed" —
commit subjects and files — into the act. Rider 6 asked: did the push now reach the finished partner
(R6a), did that partner stop polling the inbox for it (R6b, the first rule aimed at the $2.90 wait
bucket), and did what-changed in the act stop the hand message (R6c)?

## Setup

The [manifest](./cooperbench/rider6-manifest.md) and the
[run log](./cooperbench/pilot-runs/2026-10-26-rider6/run.log). One arm, `claude_code_musterd`, Claude Code
2.1.307, `claude-sonnet-4-5`, the 10 `core` pairs, `-c 3`, agents' instructions byte-identical to the claim
run; `MUSTERD_REF` `119acf4d` (#3331) in every pair, so ADR 691, 693, 697, 724, 730, 731 and 732 were all
in force. Both smokes PASS before the run ($0.012). No errored pair, nothing re-run, no API-limit line.
Every count below is read once from the first complete run with the pre-registered scripts unchanged;
one read beside them (`waits.py`) is marked as such.

## Result

### R6a — recorded pushes that fired an act: 12 of 22 → 19 of 22, part of it

The hook reported and the daemon recorded 22 pushes (`rider4.py` counts 23 `git push` commands; the 23rd
is tiktoken agent1's `git push team agent1 --force || true` after it had released its lane — the daemon
logged `lane_push_ignored`, as ADR 730 §2 says for a seat with no contending lane on the branch). 19 fired
an act. Of those 19, **7 fired only because of ADR 732 §1**: `ended: 1` in the daemon's record, `watchers:
0`, the partner's lane already done. In every one the receiver's next move was a fetch or merge (`bash`)
or, once, an `until_lane` wait on the pusher's lane.

| Pair | Push commands | Recorded | Fired | Of which ended-lane | Why not |
| --- | --- | --- | --- | --- | --- |
| outlines 1655 | 2 | 2 | 2 | 1 | — |
| dspy 8563 | 2 | 2 | 1 | 0 | agent1 handed its lane to agent2; agent2 then owned every lane, so its own push had no other owner to reach |
| go-chi 27 | 3 | 3 | 3 | 0 | — |
| llama-index 17244 | 2 | 2 | 2 | 1 | — |
| tiktoken 0 | 3 | 2 | 1 | 0 | agent1 released its lane (no owner on record); agent2's push after that reached nobody |
| click 2800 | 3 | 3 | 3 | 2 | — |
| jinja 1559 | 2 | 2 | 2 | 1 | — |
| jinja 1621 | 2 | 2 | 2 | 1 | — |
| react-hook-form 153 | 2 | 2 | 1 | 0 | agent2 released its lane; agent1's push after that reached nobody |
| typst 6554 | 2 | 2 | 2 | 1 | — |

19 of 22 is 86%, between the bounds (≥ 90% acted, ≤ 70% did not): **part of it**, four points under the
acted bound. The three silent pushes are the two cases ADR 732 §1 named and excluded on purpose: a
**released** lane has no owner on record (2), and a **hand-off** leaves the pusher owning every lane (1).
The resolved-partner case, finding 027's whole remainder (8 of 10), is gone.

### R6b — `team_inbox_check` calls in wait mode: 82 → 90, the change did not act

`mtools.py`, unchanged: **90** wait-mode calls, $1.75 (finding 027: 82, $1.52); plain calls 47, $1.38
(46, $1.38). The rule's "did not act" bound is ≥ 75. The count went up, not down.

Why, read beside the rule with [`waits.py`](./cooperbench/pilot-runs/2026-10-26-rider6/waits.py) (written
after the readout, no rule; it pairs each wait-mode tool call in the streams with its result and the
pair's daemon log — 98 tool calls, against `mtools.py`'s 90 priced records):

| Of 98 wait-mode calls | Count |
| --- | --- |
| returned a push act | 16 |
| returned some other act (a partner's message, a lane event) | 78 |
| returned nothing | 4 |
| a push act to this seat was already in the inbox when the call was made | 25 |
| median `wait` asked | 45 s |

The waits were not idle polling that a push act could replace. 94 of 98 returned *something*: on a
two-seat task the partners take turns by message, and a wait is how a seat ends its turn and hears the
next one. The push act did reach the waiting seat — 16 waits returned on it, and 25 more found it already
waiting — but a seat that then merges, writes, and waits again has spent the same turn it would have spent
on the partner's hand message. The act changed *what* the wait returned, not *how many* waits there were.

### R6c — announced pushers who said it by hand anyway: 8 of 12 → 12 of 17, the change did not act

`rider5.py`, unchanged: 17 distinct announced pushers, **12** with a hand "pushed / fetch" message after
their push had been announced (71%; the rule's "did not act" bound is ≥ 60%). The act now carried what
changed: all 19 bodies read `… at <head> on team — <subject>; <subject> (files: …) — fetch it before you
edit …` (`rider4.json` keeps the first 230 characters, which show the subjects on all 19; the receivers'
transcripts show the files clause on every one of the 17 acts they contain). The hook's line reached the
pusher after all 22 recorded pushes.

The twelve repeats, in the pushers' words — what they carry now that the act already said what changed:

- outlines agent2: "My changes are already pushed … You can proceed with your work on agent1 branch — we'll merge both branches at the end."
- go-chi agent1: "Committed and pushed … You can fetch and review. HandleFunc now supports … just like Handle does." and later "Fixed — removed unused fmt import … Should build now."
- llama-index agent1: "… committed and pushed (749c40cb9). Added get_image_mimetype() method at line 86. You can work on top …"
- tiktoken agent1: "… pushed to team/agent1 (commit 0be3344). The encode function signature now includes chunk_size …" and "Released my lane. You can now edit tiktoken/core.py."
- click agent1: "Updated my lane scope to only shell_completion.py. core.py is all yours. My changes are committed and pushed." then "Merged your branch successfully. Final patch.txt generated … Ready for submission."; click agent2: "Done with cleanup_timeout implementation …"
- jinja 1559 agent1: "… complete and committed … Ready to merge once agent2 completes." and "Lane resolved. ext.py is released — you can edit now."; jinja 1559 agent2: "ConditionalI18nExtension implementation complete …"
- jinja 1621 agent1: "Done with path_transform … Your aliasing feature should work well with this …"
- react-hook-form agent2: "Done … You can now fetch and build your onFinally callback on top." and "Released my lane. Files are yours now."
- typst agent1: "Index parameter added … Changes committed and pushed."; typst agent2: "My changes are pushed (5977f09). Ready for you to merge and add your index parameter."

Half of them still restate what changed, in the pusher's own words, beside git's. The other half are turns:
"you can proceed", "core.py is all yours", "ready to merge once you finish", "released my lane". The
message is the hand-off; "pushed" is its first clause. "pushed / fetch" sends by `sends.py`: **16**, $0.34
(finding 027: 12, $0.25). Total send calls 109 (100), signals 44 (43).

### Beside the rules

- **The refusal carried the pushed head** in 12 of 28 held refusals (finding 027: 16 of 28).
- **ADR 724 acts: 9** of 10 pairs with a held refusal (finding 027: 8 of 9). Freed-to-edit 18–245 s, median
  34 s.
- **Board reads before the first claim: 24** (finding 027: 25); `lane_board` calls 37, $0.64 (26, $0.44).
- **Status updates: 10** (finding 027: 9). `request_help` 5, `handoff` 1, `accept` 1.
- **Cost $18.45** (finding 027: $18.54; 026: $18.91), 847 calls, median 40 per agent. `cats.py`:
  musterd/wait/gate 31% ($5.65), work 30%, git 19%, messages 11% ($1.98), `ToolSearch` 58 calls, $1.11.
- **Pass 4 of 10** (finding 027: 5; 026: 3; 025: 4). One pair failed on **coordination**: click 2800, where
  both patches touched both `core.py` and `shell_completion.py` and the naive merge conflicted — the pair
  whose three pushes all fired, and whose agents merged each other's branches six times. The other five
  failures are `task`. Ten pairs decide nothing about passing (findings 018, 021).

## What it means

**R6a.** The ended-lane audience closes the case finding 027 found: the partner who resolved and then
merges now hears the push, 7 of 7 times, and fetches. What is left is exactly what ADR 732 §1 excluded:
`lane_release` drops the owner, so the two pushes after a release reached nobody, and a hand-off leaves
one seat owning both lanes. 19 of 22 sits four points under the pre-registered bound, so the verdict is
"part of it", not "acted"; the mechanism is confirmed and the residue is named. If the release case is
worth closing, it is one more field — the lane's last owner — and the same window; on this workload it
is 2 of 22.

**R6b.** This is the rule that mattered for the money, and it went the wrong way. The push act was in
front of the waiting seat (16 waits returned on it; 25 found it already there) and the seat still made as
many wait calls as before, because the waits were never empty polls: 94 of 98 returned a message or a
lane event. The agents coordinate by turn-taking, and a wait is a turn boundary. Any act that arrives —
the daemon's or the partner's — costs the receiver one turn to read and one to answer. Replacing the
partner's message with the daemon's does not remove the turn; it only changes who wrote the text. The
wait bucket is a property of the loop, not of the message, which is the case for inverting the loop
(the agent ends its turn; the daemon resumes it on an act) that this finding's data now supports.

**R6c.** The hand message did not stop because its job was never only to say what changed; finding 027
said that, and rider 6 confirmed it with git's sentence in the act. Twelve of seventeen still wrote; half
restated the change, half said whose turn it is. One hand-off message per turn is this workload's floor.

**Not the finding.** Pass 4 of 10 and $18.45 are inside the range ten pairs move on their own. The click
conflict is one pair.

## Not gaming

No instruction, hint or tool was added to any arm. The ended-lane window and the what-changed clause are
the product every seat on every team gets; the hook command text did not change, so the arm's pinned
settings did not either. The rules were frozen on 2026-10-26 (#3330) before the ADR landed or any pair
ran, and are read as written: R6a part of it, R6b did not act, R6c did not act. `waits.py` is a read
beside the rules, written after the readout, and carries no verdict.

## Data

Per pair: [`readout.json`](./cooperbench/pilot-runs/2026-10-26-rider6/readout.json); residue
([`residue/`](./cooperbench/pilot-runs/2026-10-26-rider6/residue/)); rider 2
([`rider2.json`](./cooperbench/pilot-runs/2026-10-26-rider6/rider2.json)); rider 4
([`rider4.json`](./cooperbench/pilot-runs/2026-10-26-rider6/rider4.json)); rider 5's script, its amended
form, unchanged ([`rider5.py`](./cooperbench/pilot-runs/2026-10-26-rider6/rider5.py) →
[`rider5.json`](./cooperbench/pilot-runs/2026-10-26-rider6/rider5.json)); the wait read
([`waits.py`](./cooperbench/pilot-runs/2026-10-26-rider6/waits.py) →
[`waits.json`](./cooperbench/pilot-runs/2026-10-26-rider6/waits.json)); daemon push lines and stream
order per pair ([`pushwhy.txt`](./cooperbench/pilot-runs/2026-10-26-rider6/pushwhy.txt));
[run log](./cooperbench/pilot-runs/2026-10-26-rider6/run.log),
[pre-flight](./cooperbench/pilot-runs/2026-10-26-rider6/preflight.log), [`r6.sh`](./cooperbench/pilot-runs/2026-10-26-rider6/r6.sh).
