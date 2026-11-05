# 032 — CooperBench rider 7 re-run: the act lane woke a seat in a median 91 s, and the pair did not get cheaper — 78 waiting turns against 90 and $25.04 for ten pairs against $18.45

> **Status:** 2026-11-05, lane 01M6ME0A0N (lazara), asked for by nick (run A, 10 `core` pairs, hard stop
> $110, via the app 2026-11-04 23:02Z). Pre-registered as the [rider 7 re-run
> manifest](./cooperbench/rider7-rerun-manifest.md) under [rider 7](./cooperbench/riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act)'s
> rules, unchanged; run 2026-11-05 02:49–05:11Z on main `ac0dc20d` after four smoke pairs, two errored
> pairs re-run once 05:17–05:32Z as pre-registered ([run
> log](./cooperbench/pilot-runs/2026-11-05-rider7b/run.log)). **Read once, over the ten pairs with the two
> re-runs in place of the errored ones** (`composite/`): **R7c** act→wake wait, median **90.9 s** over 26
> wakes (rule ≤ 2 min acted / ≥ 15 min did not) — **acted**, so R7a and R7b are reads of the lane. **R7a**
> turns spent waiting: **52** wait-mode `team_inbox_check` calls **+ 26 wakes = 78** (finding 028: 90 + 0;
> rule ≤ 55 / ≥ 75) — **did not act**: the wakes replaced the waits one for one and a few more. **R7b**
> model dollars: **$25.04** = $20.32 first calls + $4.72 wakes (finding 028: $18.45; rule ≤ $15 / ≥ $18) —
> **did not act**. The first complete run alone, before the re-runs, read 46 + 21 = 67 (part of it) and
> $21.98; both forms are below. Pass **4 of 10**, one merge conflict, no claim.

## Question

Does the inverted loop — a seat ends its turn and the host wakes it on the next directed act — replace
the turns a two-seat pair spends waiting (R7a), at what cost (R7b), and how fast is a seat woken (R7c)?
Finding 028 measured the waiting: 90 wait-mode calls, 94 of 98 returning an act. Finding 031 stopped the
first attempt at the smoke pair on two product faults (resume cost, the reclaim hold); ADR 804 and ADR 805
fixed them, and four more smoke pairs on 2026-11-05 fixed four arm faults before a measured pair ran.

## Setup

The [manifest](./cooperbench/rider7-rerun-manifest.md), its dated amendment, and the [run
log](./cooperbench/pilot-runs/2026-11-05-rider7b/run.log). One arm, `claude_code_musterd`, Claude Code
2.1.307, `claude-sonnet-4-5`, the 10 `core` pairs, `-c 3`, `MUSTERD_ARM_LANE=act`: the pair team on
`lane act`, `hourly_cap 60`, `timeout 60m`, `transcript_max 256 MiB`, `tool_policy seat-policy`,
`resume_max_usd 0.25`; each seat enrolled from its container, `musterd host` in the container; the two
"wait in one call" sentences removed from the instruction; the `musterd:self-heal` tombstone beside the
binding; a seat ends 5 min after writing its patch with nothing unread, or at the 7,200 s cap.
`MUSTERD_REF` `ac0dc20d` in every pair (ADR 804 with both amendments, ADR 805, ADR 801–803 as on
`main`). Guards: `run_arms.py --cap 110` and `wake_guard.py --pair-cap 6 --total-cap 110`; neither
stopped anything. Pre-flight: both host smokes PASS. Every count below is read once from the first
complete run with the pre-registered scripts (`mtools.py`, `rider5.py`, `rider7.py`) unchanged; the
per-wait holds come from each pair daemon's `report residency` taken at teardown.

## Results

### R7c — act→wake wait: median 91 s, acted

26 wakes carried a `waited_ms` (21 in the first run, 8 in the two re-runs, less the errored pairs' 3);
median **90.9 s**, range 0–387 s. What held them (ADR 753 holds over the first run's 21 waits): `present`
64%, `reclaimable` 30%, `passed` (the host's 10 s poll) 6%.

The `reclaimable` share is **each seat's initial call ending**, once per seat: a wait of `present N +
reclaimable 40` is an act that arrived while the seat's first `claude -p` was still running (`present`),
then the 45 s grace that call's session left when it exited. After a wake's report the seat read `passed`
within 0–9 s on every pair whose timeline was read (ADR 804: 03:15:22 report → 03:15:22 passed; 03:16:52 →
03:16:56; 03:17:49 → 03:17:49; 03:39:16 → 03:39:22). The lane's own gate is gone from the wait; what
remains is the seat's own first session and one grace.

| Pair | Wakes | Waits (s) |
| --- | --- | --- |
| outlines 1655 | 2 | 73, 72 |
| dspy 8563 | 0 | — |
| go-chi 27 | 1 | 99 |
| llama-index 17244 | 2 | 152, 177 |
| tiktoken 0 | 1 | 44 |
| click 2800 | 4 | 75, 3, 169, 351 |
| jinja 1559 (re-run) | 4 | 10, 37, 41, 52 |
| jinja 1621 | 4 | 131, 387, 0, 83 |
| react-hook-form 153 (re-run) | 4 | 99, 144, 162, 181 |
| typst 6554 | 4 | 6, 176, 181, 8 |

### R7a — turns spent waiting: 90 → 52 + 26 = 78, did not act

`mtools.py`, the pre-registered line, over the composite: `team_inbox_check (wait)` **52** calls, $1.05
(finding 028: 90, $1.75); plain `team_inbox_check` 79, $2.31 (028: 46). Wakes **26**, 0 resumed, 2
unpriced. 52 + 26 = **78**, over the "did not" bound of 75. The first complete run read 46 + 21 = 67,
between the bounds; the two re-run pairs took 11 wait calls and 8 wakes where the errored originals had 5
and 3.

The wait calls that remain sit inside the first calls: with the sentence gone, the agents still waited in
one call where the workflow had them "check before submitting", and every act that arrived during a first
call came in on the interrupt line, not a wake. **112 of 130 sends were `message`** (`sends.py`), the same
turn-taking as finding 028; the wakes are the turns that happened after both first calls had ended, and
there were about as many of them as there had been waits.

### R7b — dollars: $25.04, did not act

| | Finding 028 | First run (10 pairs, 2 errored) | Composite (re-runs in place) |
| --- | --- | --- | --- |
| First calls | $18.45 (whole pairs) | $17.54 | **$20.32** |
| Wakes | — | $4.44 (21) | **$4.72** (26, $0.19 median; 24 refused a resume for price and spawned fresh) |
| Total | **$18.45** | $21.98 | **$25.04** |

The first calls alone cost what rider 6's pairs cost in full; the wakes come on top. ADR 805 did what it
says — every resume past about 83k tokens was refused and the wake spawned fresh at $0.12–0.46 — and that
is why the wakes stayed cheap. But a fresh wake re-reads the seat primer and the task to answer one act,
and the act lane added 26 of them without taking the first calls' own cost away. Finding 028's hypothesis
was that the waits were the cost; the waits were $1.75 of $18.45.

### Beside the rules

- **Pass 4 of 10** (outlines 1655, tiktoken 0, jinja 1559 on its re-run, jinja 1621); 8 `identical`
  merges, 1 `clean`, 1 merge conflict (react-hook-form 153 on its re-run, a coordination loss). Findings
  025–028 passed 3–5 of 10 on these pairs. No claim.
- **Errors, re-run once as pre-registered:** jinja 1559 — agent2's musterd MCP server was `absent` at
  session start (an arm error; re-run passed); react-hook-form 153 — the evaluator failed to write agent2's
  40,448-line patch (an evaluator error; re-run scored, a conflict). The errored pairs cost $1.85 and $0
  and are not in the composite.
- **Gate:** 38 edit refusals ($1.08), `held_refusal_moves` 14; `lane_board` 47 and `team_status` 12 reads,
  25 of them before the first claim (`boardreads.py`). **Pushes:** `rider5.py` found none recorded.
- **Bash gate errors: 0** across every first call (smoke pairs 1–3 had 7, 2 and 0; the 11-04 pair 5).
- **Spend:** $25.04 model for the composite, $1.85 for the two errored originals, about $12 for the four
  smoke pairs; Fly about 7 h of a performance-8x on the clone (the original machine's host had no CPU
  headroom for the new image). The $110 stop was never near; neither guard fired.

## How far it reaches

- R7c is the first clean read of the act lane's own speed: with the seat's attended sessions and the grace
  out of the way, a wake follows an act within the host's poll. That holds on CooperBench's unattended
  seats; finding 030 showed it does not help a seat a person is sitting in.
- R7a says where the turns went: a two-seat task still takes turns, and when both seats are in their first
  call the interrupt line, not the lane, carries the act. The lane removed 38 wait calls after the first
  calls and added 26 wakes in their place — one turn for one, with the wake dearer than the call.
- R7b is the verdict that matters for the loop: on this benchmark the act lane does not make the pair
  cheaper. It makes the waiting cheaper per turn and adds turns that each pay the fresh-boot price. A
  resume under the price bound would have carried context but cost more (finding 031); a resume over it
  is what the bound refuses. The cost structure, not a bug, is the result.
- One run, ten pairs, one model; two pairs errored and were re-run once, which moved R7a from "part of
  it" to "did not" — the verdict sits on the bound, and the first run's reading is kept beside it.
  Pass rate makes no claim here.

## Product gaps the run hit

1. **The initial session's grace holds the first wake.** Every seat's first wake waited out the 45 s
   reclaim grace its first call's session left. On the act lane that session is also "a run that ended"
   — the same reasoning as ADR 804 — but no report marks it. Releasing a seat's hold when its enrolled
   workspace's harness exits (the SessionEnd hook could say so) would take 40 s off every first wait.
   Built as [ADR 809](../decisions/809-harness-exit-releases-the-reclaim-hold.md) (lane `01M6PA2G02`).
2. **A fresh wake pays the boot for one act.** 24 of 26 wakes were fresh under the $0.25 bound; each
   re-read the primer and the task. A compacted continuation (ADR 805's rejected third option) is the
   way to keep the lane's wakes cheap *and* continuous. Built as
   [ADR 810](../decisions/810-compacted-continuation.md) (lane `01M6PA2PWX`); its read is this run again.
3. **The arm's own faults found by smoke pairs** (run log): the self-heal rewrote the arm's hooks; the
   idle probe matched itself and then the launcher's environment; an MCP server absent at one session
   start. All but the last fixed on `main` (#3877, #3882, #3886).

## Decision for nick

The act lane is sound as a mechanism and does not pay for itself on CooperBench: R7c acted, R7a and R7b
did not. The manifest leaves what follows to nick. The numbers say: keep the lane for seats that
are unattended and wake rarely (where a wake replaces a person's wait, finding 029/030), and do not expect
it to cut a benchmark's bill; if the loop is to be cheaper, gap 2 is the work.
