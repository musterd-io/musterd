# 034 — CooperBench rider 8: told to end its turn when it waits, the pair deadlocks — 0 of 10 pass, 16 of 20 patches empty, and the loop cost $23.58

> **Status:** 2026-11-06, lane 01M6Q09SR6 (lazara), spend approved by nick in session (2026-11-05 ~23:10Z,
> "lets go with your recommendation" — the arm-guidance option from finding 033). Pre-registered as the
> [rider 8 manifest](./cooperbench/rider8-manifest.md) (#3952, before any pair ran) under
> [rider 8](./cooperbench/riders.md#rider-8-finding-033s-lever--the-act-lane-seat-ends-its-turn-when-it-waits-said-first-and-plainly-and-sleep-denied);
> run 2026-11-06 00:22–01:38Z on main `40866276` after one smoke pair ([run
> log](./cooperbench/pilot-runs/2026-11-05-rider8/run.log)). Neither guard fired. **Read once over the
> ten pairs.** **R8a** waiting turns: **7** wait-mode calls **+ 0 shell sleeps + 46 wakes = 53** (finding
> 033: 93; rule ≤ 55 acted / ≥ 85 did not) — **acted**. **R8b** model dollars **$23.58** = $6.68 first
> calls + $16.90 wakes (finding 033: $22.50; 028: $18.45; rule ≤ $18 / ≥ $22) — **did not**. **R8c**
> first-call dollars **$6.68** (finding 033: $18.06; rule ≤ $12 / ≥ $17) — **acted**. **And the task
> broke:** pass **0 of 10**, **16 of 20 patches empty** — nine pairs ended by the 10-minute idle rule with
> both seats having ended their turns "waiting for" each other and no act in flight. That is a **final
> deadlock after wakes**, not the manifest's registered loss class (a seat never woken at all, patch
> missing): under the registered definition the count is **0 pairs** and its stop rule was never
> triggered, so the run went to ten by the rules; the class that happened was not pre-registered. See
> *What I got wrong*.

## Question

Finding 033 left the act lane fast and continuous and the pair dearer than the loop it replaced,
because the two first calls were the pair and the seats waited inside them. Rider 8 asked whether
telling an act-lane seat, first and plainly, to end its turn the moment it waits on its partner moves
the waiting out of the first calls (R8a, R8c) and the cost with it (R8b).

## Setup

The [manifest](./cooperbench/rider8-manifest.md). Finding 033's arm and build plus three arm changes
(#3952): the turn rule leads the act-lane protocol, the workflow's check step says "if the inbox is
empty and you cannot proceed without your partner, end your turn", and `Bash(sleep:*)` is denied.
`MUSTERD_REF` `40866276`, `resume_max_usd 0.25`, the ten `core` pairs, `-c 3`, `run_arms.py --cap 110`
and `wake_guard.py --pair-cap 6 --total-cap 110`. Pre-flight PASS; one smoke pair met the gate as
written (both seats ended their first call "Waiting for …", six compacted wakes, no `sleep`). Every count
below is read once from the ten pairs with the pre-registered scripts unchanged.

## Results

### What the seats did

Every first call ended early and on purpose. The twenty first calls ran 25–471 s (median ~90 s) and
cost $0.09–1.02 (`firstcalls.txt`); eighteen of twenty ended with a result text beginning "Waiting for
agent…" or "The file is held by agent…'s lane. Waiting …"; the other two were a seat that had finished
its own feature and said so before waiting for the merge. The host then woke the seats **46** times
(2–9 a pair), every wake `compacted` (briefs 8–39 turns, 1–3 KiB, from transcripts the $0.25 bound
refused at $0.27–0.59), median act→wake wait **7.7 s**, first-wake `reclaimable` **0.0 s** on 19 seats.
The wakes were triggered by the partner's message 38 times and by a lane push (`board`) 12 times.

### R8a — waiting turns: 7 + 0 + 46 = 53, acted

`mtools.py`: wait-mode `team_inbox_check` **7** ($0.12; finding 033: 46), `bash sleep` **0** (033:
22), plain `team_inbox_check` 45 (033: 83), `lane_board` 13 (033: 38), edit refusals 5 (033: 28).
Wakes **46**. The waiting left the first calls, as the rule asked.

### R8c — first-call dollars: $6.68, acted

Down from $18.06. The first calls stopped being the pair.

### R8b — model dollars: $23.58, did not

| | Finding 028 | Finding 033 | This run |
| --- | --- | --- | --- |
| First calls | $18.45 (whole pairs) | $18.06 | **$6.68** |
| Wakes | — | $4.72 (26) | **$16.90** (46; $0.37 median, $0.07–2.16) |
| Total | **$18.45** | $22.50 | **$23.58** |

The money moved with the work: the wakes now do what the first calls did, at a fresh boot each, and
there were almost twice as many of them. The brief kept each wake cheap to start ($0.25 of history at
most) and could not make a turn of work free. The pair cost $1.08 more than finding 033's and $5.13
more than finding 028's.

### The task broke: 0 of 10, 16 of 20 patches empty

| Pair | Patches | Duration | Wakes | Cause |
| --- | --- | --- | --- | --- |
| outlines 1655 | 0 B, 0 B | 17m50s | 5 | setup |
| dspy 8563 | 0 B, 0 B | 18m20s | 4 | setup |
| go-chi 27 | 0 B, 0 B | 18m14s | 6 | setup |
| llama-index 17244 | 0 B, 0 B | 18m05s | 5 | setup |
| tiktoken 0 | 0 B, 0 B | 17m19s | 2 | setup |
| click 2800 | 0 B, 4.5 KB | 22m03s | 5 | setup |
| jinja 1559 | 9.5 KB, 0 B | 23m11s | 3 | setup |
| jinja 1621 | 0 B, 0 B | 21m41s | 4 | setup |
| react-hook-form 153 | 0 B, 0 B | 31m58s | 9 | setup |
| typst 6554 | 3.7 KB, 3.7 KB | 14m46s | 3 | task (identical merge, tests fail) |

`cause: setup` is CooperBench's word for "nothing to apply". No pair reached the 7,200 s cap or the
quiet rule (patch written, nothing unread for 5 min); every one of the nine ended by the **idle rule**
(finding 032's: both seats with no harness process and nothing unread for 10 minutes), 15–32 minutes
in. The shape is the same on every one: each seat ends its turn "waiting for" the other; the partner's
next message wakes it; it does a turn of work and ends again "waiting"; and at some point both have
ended waiting on each other with **no act in flight** — nobody has sent anything, so the host, which
wakes on acts, has nothing to wake either seat with. Ten minutes later the pair is over with
`patch.txt` never written. Where one seat finished its own feature before waiting (click's agent4,
jinja 1559's agent5, both of typst), its patch exists; the merge step that needs both never happened.

**Which class this is.** The manifest registered one loss class: "a seat that ends its turn and is
never woken because its partner never sends it an act — a pair that ends with one patch missing and
no wake on that seat", with a stop at three such pairs in the first five. Read literally against
`musterd-residency.json` and the patch sizes, that class occurred on **0 pairs**: every seat whose
patch is empty was woken at least once (1–5 times), and the one seat with no wake at all (typst's
agent1) finished its feature inside its first call and left a 3.7 KB patch. What happened instead is
a **final deadlock after wakes**: both seats woken earlier by each other's messages, then both ended
"waiting for" the other with no act in flight, the pair idle for ten minutes, the patches never
written — on **9 pairs** (7 with both patches empty, 2 with one). That class was not pre-registered
and had no stop rule, so the run ran to ten pairs by the rules as written; the registered class's
stop would not have fired. Sends fell to 39 (033: 108), 37 of them `message`; the seats talked less
because each turn was one exchange long.

### Beside the rules

- **Neither guard fired, and neither saw the whole spend.** `wake_guard.py`'s total is the live pairs'
  priced wakes plus the finished pairs' `result.json` `cost` — which is the first call's cost only;
  a pair's wakes leave the count when its daemon workdir is torn down. Its last line reads $7.18
  (= $6.68 first calls + $0.50 smoke-pair first calls), against $23.58 actually spent; `run_arms.py
  --cap` reads the same `result.json` field. The $110 stop was never near on either number, so this
  run did not test the hard stop and "neither fired" is not evidence it works. For a next run the
  guard must carry a finished pair's wake total forward (read it at teardown, before the workdir
  goes). Wake dollars per pair $1.04–2.62. Spend: $23.58 model for the ten pairs, $3.18 for the smoke
  pair, about 1.7 h of Fly.
- `ToolSearch` 1, `team_status` 1, `lane_board` 13 (28 board reads before the first claim, as before).
- The `Bash(sleep:*)` deny was never tested by a seat: no seat tried to sleep.

## What I got wrong

- **The smoke-pair gate checked that patch files existed, not that they held anything.** Both of the
  smoke pair's patches were 0 bytes — the smoke pair had already shown the deadlock — and the gate as
  I scripted it read "both patches written". The manifest's gate did not say "non-empty" either; it
  should have, and the next manifest's will.
- **The registered loss class was the wrong class, and I first read it as triggered.** The manifest
  defined the loss as a seat *never woken*; what happened was seats woken and then deadlocked at the
  end. Under the registered definition the count is 0 and the three-in-five stop was never due, so
  the run went to ten by its rules — my first draft of this finding said the stop "was not enforced"
  on five pairs, which was the wrong class counted (big-body's acceptance read). There was also no
  live check for either class; a next manifest registers the deadlock class (both seats ended
  waiting, no act in flight, no non-empty patch) with a live check in the guard.
- **The guards under-count.** See *Beside the rules*: both caps read first-call cost for finished
  pairs, so the $110 stop was judged on $7.18 of $23.58.

## How far it reaches

- R8a and R8c answer their question cleanly: the instruction works. Seats end their turns when told
  to, the waiting disappears from the first calls, and the lane carries the turns at 7.7 s each.
- R8b is the verdict on the lever, and it is "did not", for a reason finding 033 did not foresee: a
  turn of work costs what it costs wherever it runs, and splitting the pair into 46 short turns made
  the whole thing dearer, not cheaper, even with every wake briefed.
- The deadlock is the finding, and it is an observed class, not the pre-registered one. On the act lane the host wakes a seat on an act. Two seats that both
  end their turn waiting for the other produce no act, and the lane has no other reason to wake
  anyone. The arm's old guidance ("wait in one call") avoided this by never ending the turn; finding
  033's build avoided it by accident, because the seats mostly did not end their turns. Told to, they
  did, and the pair stopped. This is a property of the loop, not of the prompt: any seat-ends-turn
  protocol needs a wake reason other than "my partner sent something" — a timer, an idle nudge
  (ADR 558's idle-at-prompt wake is the product's nearest piece), or a rule that a seat may not end its
  turn until its own patch is on disk.
- One run, ten pairs, one model, one prompt wording. The pass rate is zero because the task never
  reached scoring on nine pairs; it says nothing about code quality.

## Decision for nick

The rider series on "can the act lane make a CooperBench pair cheaper" is answered three ways: with
the seats waiting inside their first calls it costs more (033); with them ending their turns it costs
more and deadlocks (034); the only run that cost $18.45 was the one with no act lane (028). The lane is
a good mechanism for a seat whose acts come from people or from other seats that are working; it is not
a cheaper way to run two agents against each other. If the loop is to be tried again, the lever is
product, not prompt: a wake reason for a seat whose partner is also waiting — the ADR 558 idle wake
on the act lane, or a "both idle" nudge from the host — and the arm must refuse to end a turn before
`patch.txt` exists. My recommendation is to stop here, keep ADR 809 and 810, and record the result.
