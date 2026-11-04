# 805 — A resume has a price bound, not only a byte bound

- Status: accepted
- Date: 2026-11-04
- Lane: `01M6M956WS` (goal `coordination-cost`), opened by lazara on
  [finding 031](../research/031-cooperbench-rider7-smoke.md); nick asked for the build in session
- Amends: [131](131-harness-residency-wake-ledger-host.md) §5 (the resume ladder gains a rung);
  builds on [427](427-resume-bound-gates-on-message-bytes.md) (conversation weight), [583](583-metering-gateway-not-a-loop.md) (one
  price table, never a guess), [735](735-act-lane-the-seat-ends-its-turn.md) (the act lane)

## Context

The ADR 131 ladder decides `claude --resume` against one bound: `transcript_max_bytes`, 256 KiB by
default, recalibrated on 2026-07-29 as a *cost* crossover — past it a resume re-ingests more history
than a fresh boot costs. The bound is bytes because bytes were what the host could read. A team may
raise it to 256 MiB (`residency policy --transcript-max`), and the rider 7 design note did, so that an
act-lane seat would keep its working context across wakes.

Finding 031 then measured fourteen resumed wakes on one seat in twenty minutes: $0.17, 0.26, 0.42,
0.53, 0.89, 1.01, 1.07, 1.19, 1.30, 1.37, 1.43, 1.50, 1.57, 1.64 — about $0.10 more each time, for
15–30 s of work each, $14.34 in all against $3.15 for the two first calls. Nothing was wrong with any
one wake; the transcript grew, every resume paid for all of it, and no knob spoke in dollars.
`budget_usd` is a per-seat report bound; the hourly cap counts wakes, not what they cost.

## Problem

Bound what a resume may cost, in the unit a person sets budgets in, without guessing a price the
host does not have, and without touching the fresh path, which is always valid.

## Decision

1. **A policy knob, `resume_max_usd`.** `ResidencyPolicySchema` gains an optional positive number
   (at most 10), set like every other residency knob (`residency policy --resume-max <USD>` for the
   team, `residency on … --resume-max` for a seat); the status line shows `resume ≤ $N` when set.
   Unset, the ladder is as before: bytes alone decide.
2. **It rides the order.** The daemon puts the effective value on the wake order's `bounds` as
   `resume_max_usd`, beside `budget_usd`. A host that does not know the field ignores it and stays
   correct.
3. **The price rung.** When the order carries the bound and the ladder has admitted a resume target
   on bytes, the host prices it before spawning: the conversation weight where the ladder weighed it
   (ADR 427), else the transcript's bytes as an upper bound, at bytes ÷ 4 tokens × the model's input
   price from the one table (ADR 583). The model is the seat's attested one (`binding.model`, ADR 158),
   else the harness's own model variable. Over the bound the wake is fresh and the host log says
   `resume would re-ingest <bytes> on <model> for about $X (bound $Y)`.
4. **Unpriceable is over.** No transcript size, no attested model, or no price row for it: the rung
   cannot show the bound holds, so it refuses the resume — the conservative direction the ladder
   already takes when it cannot weigh a file — and the log says which. The table is never guessed
   from.
5. **Nothing else moves.** The byte bound, the exact-match rung (ADR 210), the portable/fresh order
   (ADR 209), the ADR 427 weighing, and what a wake reports are unchanged. The rung only ever turns a
   resume into a fresh spawn.

### Rejected

- **A per-wake dollar cap enforced mid-run.** No CLI can stop a run on dollars (the `budget_usd`
  decision, 2026-07-14); the gateway can refuse the next call (ADR 583), but a resume's cost is paid
  in its first call. The bound has to act before the spawn.
- **Lowering `transcript_max_bytes`'s ceiling instead.** Bytes are the wrong unit for the person
  setting the bound, and a byte cap does not know whether the seat runs on a $2 or a $10 model.
- **Compacting the transcript on resume.** The right long-term answer for continuity, and a bigger
  change than this gap needs; it can land behind the same knob later.

## Consequences

- On the act lane with a sensible bound (say $0.25 on Sonnet, about 125k tokens), a seat's wakes
  stop climbing: past the bound each wake is a fresh boot at the seat-primer price, and loses the
  working context the resume carried. That trade is now the team's to set, not the ladder's to hide.
- The CooperBench act-lane arm sets the bound in its pair-team policy (`team.py`, `ACT_LANE_POLICY`:
  `--resume-max 0.25`), from this ADR on; the 2026-11-04 smoke pair ran without it.
- A model absent from the price table resumes only with the bound unset: the table (`host/prices.ts`)
  has to carry the models teams run, and a missing row is read as "cannot show it is under", never
  priced by analogy.

## Observability & Evaluation

- **Traces:** the host log line per refused resume (`resume would re-ingest …` / `resume price
  unknown: …`); the wake report's `session: fresh` with the ADR 209 delivery metadata
  (`transcript_bytes`, `resume_weight_bytes`) says what was judged.
- **Eval:** the next act-lane read with the bound set (rider 7's re-run, or finding 030's seats):
  per-wake `cost_usd` on `report residency` should plateau at the bound plus the run's own work
  instead of climbing by the transcript. Falsifier: wakes still priced above the bound with the knob
  set means the estimate under-counts (cache writes, tool results outside the conversation weight)
  and the divisor or the weight source needs the measurement, not a feel.
- **Experiment:** none; before/after on the same seats.
