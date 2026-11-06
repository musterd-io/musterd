# 039 — Outcome quality on our own team: 12% of judged lanes are sent back at acceptance, accepted lanes take 1.15 rounds on average, and no human verdict on record is a send-back

> **Status:** 2026-11-06, lane 01M6S2NYC4 (ryder), asked for by nick. One run of
> `pnpm quality:readout` (`scripts/research/acceptance/outcome-quality.ts`, landed in #4031) over the
> revive team's whole audit history on the laptop daemon's DB: first submit 2026-07-28 → 2026-11-06.
> Not pre-registered. This is a first baseline, and nothing was predicted. **Send-back rate 12%**
> (231 of 1,901 judged lanes). **Mean rounds to accept 1.15** (1,874 accepted lanes). **22% of
> submitted lanes were never judged** (524 of 2,425).

## Question

How often does a lane that has landed get sent back when its outcome is judged (ADR 192)? How many
rounds does it take to get accepted, and does that differ by kind of work? This measures the
quality of musterd's own output, not its speed. It diagnoses the work and never ranks seats
(human-agent-dynamics.md §4). The instrument has no per-owner column, and this finding has none
either.

## Setup

- **Source:** `audit` rows `lane.ready_for_review` (one submit), `lane.review_sent_back` (one
  decline) and `lane.closed` (only `reason = counterpart_confirm` counts as an accept), joined to
  `lanes` for area. The instrument's header lists its definitions and known blind spots.
- **Denominator:** lanes with at least one verdict. A lane nobody judged is reported apart from the
  rest and never counted as an accept.
- **Area:** declared areas (ADR 582), else the first path segment of each scope glob. A lane counts
  once in each of its areas, so the area rows do not sum to the total.
- **Fix made while reading:** the first run failed with `no such column: name`, because `teams` is
  keyed by `slug`. That one-word fix rides in this PR. No number below depends on it, except that
  the run now completes.
- **What was not run:** in this session only the bare `pnpm quality:readout` was allowlisted, so
  the `--json` artifact and a `--since` cut were not taken. Both are one command away for the next
  read.

## Results

### Overall

| | Lanes |
| --- | --- |
| Submitted for acceptance | 2,425 |
| Judged (≥1 accept or send-back) | 1,901 |
| — accepted first round | 1,670 |
| — accepted after a send-back | 204 |
| — sent back, never accepted | 27 |
| Never judged | 524 |

**Send-back rate: 12%** (231 / 1,901). **Rounds to accept:** 1 → 1,643 · 2 → 191 · 3 → 32 · 4+ → 8;
**mean 1.15**.

The two round counts differ by 27: 1,670 lanes were accepted with no send-back, but only 1,643
were accepted on their first submit. The other 27 were submitted again without a send-back on
record, then accepted. That fits blind spot 1 in the instrument: a decline that never moved the
lane out of `awaiting_acceptance` writes no sent-back row. So **12% is a floor**. If every one of
those 27 was an unrecorded decline, the rate would be 13%.

### Why lanes went unjudged (524)

| Close reason | Lanes |
| --- | --- |
| `acceptance_exempt` (ADR 234) | 169 |
| `no_candidate` | 134 |
| `review_unanswered` | 121 |
| `review_swept` | 45 |
| `review_timeout` | 25 |
| `review_cut_short` | 22 |
| still open | 5 |
| `human_review_missed` | 2 |
| `self_close` | 1 |

Exempt lanes are unjudged by design. The other 355 were meant to be judged and were not. The two
largest causes are 134 lanes where no acceptor was eligible and 121 where the acceptor never
answered. Both are coordination failures, not quality signals, and they are a larger share (15% of
submits) than the send-backs (10% of submits).

### By area (areas with ≥ 50 judged lanes)

| Area | Judged | Sent back | Rate | Mean rounds |
| --- | ---: | ---: | ---: | ---: |
| docs | 1,297 | 178 | 14% | 1.17 |
| cli | 536 | 51 | 10% | 1.14 |
| server | 532 | 74 | 14% | 1.19 |
| web | 365 | 37 | 10% | 1.13 |
| protocol | 256 | 30 | 12% | 1.17 |
| scripts | 197 | 28 | 14% | 1.19 |
| mcp | 169 | 15 | 9% | 1.10 |
| unscoped | 76 | 10 | 13% | 1.16 |
| mobile | 54 | 13 | **24%** | 1.25 |

Every area with ≥ 50 judged lanes falls between 9% and 14%, except **mobile at 24%** (13 of 54).
That is about twice the team rate. At n = 54 it is a lead to read, not a conclusion. The smaller
areas, such as `console` 4/13 and `ci` 2/3, are too thin to say anything.

### By who judged

| Judge | Accepts | Send-backs |
| --- | ---: | ---: |
| agent | 1,688 | 280 |
| human | 186 | **0** |

**Not one human verdict on record is a send-back.** Two readings, which this data cannot tell
apart:

1. The humans really did accept everything they judged, perhaps because what reaches a human has
   already passed an agent.
2. **A human decline does not write `lane.review_sent_back`.** Humans mostly answer from the app
   (the `accept` act with `answer.choice`), and a decline on that path may land as a reply or as a
   different close reason rather than the sent-back verb. If so, human send-backs are missing from
   this readout, and the 12% floor is lower than it should be.

Reading 2 is a defect in the measurement, not in the work, and it is cheap to check: find one
known human decline and see which rows it wrote. That is the first follow-up below.

## What this means

- **Most of what lands is accepted first time.** The baseline is that about 1 lane in 8 gets sent
  back. Of the 231 sent-back lanes, 204 were accepted in the end and 27 never were. Only 40 accepted
  lanes needed 3 or more rounds.
- **The bigger loss is lanes nobody judged, not lanes judged bad.** 355 lanes that should have been
  judged were not. That is more than the 231 that were sent back.
- **The quality signal is mostly from agents.** 91% of verdicts came from agents. If the human
  decline path is invisible here (reading 2), the human share of verdicts is undercounted too.

## Follow-ups

- Trace one known human decline from the app through to its audit rows. Either confirm reading 1,
  or make the readout count the human decline verb.
- Re-run with `--since 2026-10-01 --json` and commit the JSON next to this finding, so the recent
  window can be compared with the whole history.
- Read the 13 mobile send-backs to see whether they share a cause.
