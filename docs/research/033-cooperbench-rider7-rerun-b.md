# 033 — CooperBench rider 7 re-run B: every wake carried a compacted brief, the first-wake hold went to zero, and the ten pairs cost $22.50 against $25.04 — part of it

> **Status:** 2026-11-05, lane 01M6PGAP73 (lazara), spend approved by nick in session ("i approve",
> ~19:05Z). Pre-registered as the [rider 7 re-run manifest](./cooperbench/rider7-rerun-manifest.md)'s
> dated "Second run" section (#3919, written before any pair ran), under
> [rider 7](./cooperbench/riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act)'s
> rules unchanged; run 2026-11-05 19:20–20:15Z on main `26f50b39` ([ADR 809](../decisions/809-harness-exit-releases-the-reclaim-hold.md)
> + [ADR 810](../decisions/810-compacted-continuation.md)) after one smoke pair ([run
> log](./cooperbench/pilot-runs/2026-11-05-rider7c/run.log)). No errors, no re-runs, neither guard fired.
> **Read once over the ten pairs.** **R7c** act→wake wait, median **6.7 s** over 25 wakes (rule ≤ 2 min /
> ≥ 15 min) — **acted**. **R7d** (ADR 809) each seat's first-wake `reclaimable` hold, median **0.0 s**
> over 13 seats (rule < 10 s acted / ≥ 30 s did not; finding 032 read ~40 s) — **acted**. **R7b**
> (ADR 810) model dollars **$22.50** = $18.06 first calls + $4.44 wakes, every one of the 25 wakes
> `compacted` (finding 032: $25.04 = $20.32 + $4.72 over 26; rule ≤ $18 acted / ≥ $25 did not) —
> **part of it**; under rider 7's original rule (≤ $15 / ≥ $18) it still **did not**. **R7a** turns
> spent waiting: **46** wait-mode `team_inbox_check` calls **+ 25 wakes = 71** (finding 032: 78; rule
> ≤ 55 / ≥ 75) — **part of it**. Pass **3 of 10**, one merge conflict, no claim.

## Question

Finding 032 left two gaps and a verdict: the act lane wakes a seat quickly but does not make a pair
cheaper, because every wake past the price bound spawned fresh with no context, and every seat's first
wake waited out its own first session's 45 s grace. [ADR 809](../decisions/809-harness-exit-releases-the-reclaim-hold.md)
and [ADR 810](../decisions/810-compacted-continuation.md) are those two gaps built. This run asks, on
the same ten pairs under the same rules, whether they moved the numbers they were built to move.

## Setup

As finding 032 ([manifest](./cooperbench/rider7-rerun-manifest.md), "Second run"): one arm
`claude_code_musterd`, Claude Code 2.1.307, `claude-sonnet-4-5`, the 10 `core` pairs, `-c 3`,
`MUSTERD_ARM_LANE=act`, the pair policy with `resume_max_usd 0.25`, `MUSTERD_REF` `26f50b39` in every
pair. The image was rebuilt from that commit and `cb-run-2` swapped onto it; pre-flight (api check, both
host smokes PASS) and one smoke pair (`pallets_click` 2068, 12 min, $0.26 of wakes) met the amended
gate — one wake, `session=compacted`, first-wake `reclaimable` 0.0 s — before the ten pairs ran.
`run_arms.py --cap 110` and `wake_guard.py --pair-cap 6 --total-cap 110` beside it; neither stopped
anything. Every count below is read once from the ten pairs with the pre-registered scripts
(`mtools.py`, `sends.py`, `boardreads.py`, `rider7.py`; `firstwake.py` for R7d, in the run folder)
unchanged; the per-wait holds come from each pair daemon's `report residency` at teardown.

## Results

### R7c — act→wake wait: median 6.7 s, acted

25 wakes carried a `waited_ms`: median **6.7 s**, p75 10.8 s, range 0.3–191 s (finding 032: median
90.9 s, range 0–387 s). What held them, over all 25 waits: `present` 82.6%, `passed` (the host's 10 s
poll) 17.4%, `reclaimable` **0**. The two long waits (dspy 191 s, click 173 s) are `present`: an act
that arrived while the seat's first call was still running, which no lane can shorten.

| Pair | Wakes | Waits (s) |
| --- | --- | --- |
| outlines 1655 | 4 | 2.2, 8.9, 13.3, 14.0 |
| dspy 8563 | 3 | 8.5, 40.9, 191.1 |
| go-chi 27 | 1 | 0.9 |
| llama-index 17244 | 3 | 6.6, 1.9, 5.8 |
| tiktoken 0 | 4 | 5.3, 10.8, 0.3, 4.9 |
| click 2800 | 3 | 8.6, 173.4, 2.6 |
| jinja 1559 | 0 | — |
| jinja 1621 | 3 | 2.7, 6.7, 9.5 |
| react-hook-form 153 | 0 | — |
| typst 6554 | 4 | 5.0, 38.7, 3.4, 7.1 |

### R7d — the first-wake reclaimable hold: 0.0 s, ADR 809 acted

`firstwake.py` over the ten pairs' residency reports: 13 seats were woken at least once; the
`reclaimable` share of each seat's first wake was **0.0 s on all 13** (`r7d.json`). The same reader over
finding 032's pairs gives a median of 40.1 s, the grace ADR 809 releases. Later wakes: 12, all 0.0 s
(ADR 804, as before).

### R7b — dollars: $22.50, part of it

| | Finding 028 | Finding 032 (composite) | This run |
| --- | --- | --- | --- |
| First calls | $18.45 (whole pairs) | $20.32 | **$18.06** |
| Wakes | — | $4.72 (26; 24 fresh, median $0.19) | **$4.44** (25, all `compacted`) |
| Total | **$18.45** | **$25.04** | **$22.50** |

Every wake was a compacted continuation: the host refused 25 resumes of 366 KiB–1.2 MiB transcripts
priced at $0.28–0.91 and spawned each with a brief of 9–96 turns, 1.3–12.1 KiB, nothing dropped
(every brief fit the 48 KiB budget). Per pair the wakes averaged $0.10–0.16 each; jinja 1621's three
averaged $0.53. The wakes cost a little less than finding 032's fresh ones for the same count, and the
first calls came in $2.26 lower; the total sits inside the "part of it" band and above finding 028's
whole-pair $18.45, which rider 7's original rule reads as "did not". The brief did what ADR 810 says
— a wake with context at a fresh wake's price — and it does not make the pair cheaper than the loop
it replaced, because the first calls are the pair: $18.06 of $22.50.

### R7a — turns spent waiting: 46 + 25 = 71, part of it

`mtools.py`: wait-mode `team_inbox_check` **46** calls, $0.91 (finding 032: 52; 028: 90); plain
`team_inbox_check` 83, $2.26 (032: 79); wakes **25**. 46 + 25 = **71**, between the bounds (032 read
78; its first run alone 67). New beside it: **22 `bash sleep` waits** ($0.48), agents waiting in a
shell instead of the inbox call — the same turn-taking by another route. The wait calls still sit
inside the first calls, as in finding 032; a seat that has not ended its turn is not on the lane.

### Beside the rules

- **Pass 3 of 10** (outlines 1655, llama-index 17244, tiktoken 0); 7 `identical` merges, 2 `clean`, 1
  conflict (jinja 1559, `cause: coordination`). jinja 1621 reads `cause: setup` (f2 fails 15 tests on a
  clean merge) — a scoring cause, not an arm error, so no re-run. Findings 025–032 passed 3–5 of 10 on
  these pairs. No claim.
- **Errors: none.** Every agent `Submitted`; no evaluator error; no MCP server absent at session
  start (finding 032's one arm error did not recur). Two pairs woke nobody (jinja 1559,
  react-hook-form 153): both first calls ran to their end with every act arriving inside them.
- **Sends:** 108 (`sends.py`), 93 `message`, 11 `status_update`, 2 `request_help`, 1 `handoff`, 1
  `accept`; 38 state signals ($0.85: 18 "pushed/fetch", 12 "lane done / you can edit", 6
  "merged/complete"). **Board reads:** `lane_board` 38, `team_status` 15, 25 of them before the first
  claim (`boardreads.py`; finding 032: 47 / 12 / 25). **Edit refusals:** 28 ($0.78; 032: 38).
  `ToolSearch` 6.
- **Spend:** $22.50 model for the ten pairs, $0.26 of wakes plus two first calls for the smoke pair,
  neither guard near its cap ($20.19 finished at the run's end as the guard counted it); Fly about
  1.5 h of a performance-8x on `cb-run-2`; the deploy token nick minted stays on the box for the next
  riders by nick's decision (run log, 22:05Z) and expires on its own ~2026-11-07 07:00Z.

## How far it reaches

- R7d is a clean read of ADR 809: the seat's own first session no longer holds its first wake, on
  13 of 13 seats. With ADR 804 covering every later wake, `reclaimable` is gone from the act lane's
  waits altogether; what remains of a wait is `present` (the seat is still in a call) and the poll.
- R7c with it: the lane's own speed is now a median 6.7 s, which is the host's poll plus the spawn.
  Finding 032's 91 s was the grace and the first calls; this run shows the lane itself.
- R7b is ADR 810's read, and it reads "part of it" on the bound and "did not" on the original rule.
  The brief is cheap and carried, and every wake had one; the pair is still dearer than finding 028's
  loop because the loop's cost is the first calls. The act lane's wakes are no longer where the money
  goes — they were $4.44 of $22.50.
- One run, ten pairs, one model, no re-runs; the first-call total moved $2.26 between finding 032 and
  this run with no product change in the first calls, so a difference of that size is the run's own
  noise. Pass rate makes no claim here.

## Decision for nick

Both fixes did what they were built to do: ADR 809 acted (R7d), and ADR 810's wakes carried context at
the fresh price (R7b, part of it). The act lane is now fast and continuous and still does not pay for
itself on CooperBench, for the reason finding 032 named and this run confirms: a two-seat pair spends
its money and its waiting in the two first calls, which the lane never touches (46 wait calls, 22
shell sleeps, and every act that arrived during a first call rode the interrupt line). The remaining
lever is the first call itself — a seat that ends its turn when it has nothing to do instead of
waiting inside the call — and that is a guidance and arm question, not a host one. The manifest leaves
what follows to nick; the numbers say: keep ADR 809 and ADR 810 (they cost nothing and the lane is
now a 7 s wake), and stop expecting the lane to cut a benchmark's bill without changing when a seat
ends its turn.
