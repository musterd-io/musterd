# 014 — Jev as a review queue: keep the confident answers, send the rest to a human

> **Status:** 2026-10-03, lane 01M41QMZT1 (lazara). **Pre-registered; not yet scored.** The bar
> below was committed before any 013 run data was read for this question. Results go in
> §Result, in a later commit on the same lane.

## Question

[Finding 013](./013-jev-offline-judge.md) asked whether Jev's confidence is **calibrated
everywhere**, and it is not. It never asked the narrower question that its outside use rests on:
**keep only the answers at or above a confidence cut-off and send the rest to a human. How much
gets kept, and how accurate is what gets kept?**

That is the pattern MotherDuck recommends for `prompt_jev()`
([Jev for analytics, 2026-09-29](https://motherduck.com/blog/jev-for-analytics/)): route rows
below about 0.8 to a reviewer, keep the rest. Their check is agreement with two frontier models
on 300 rows (96.9% on the 161 rows where both frontier models agreed and Jev was at ≥ 0.8). 013's
check is stricter, because its truth is the outcome a seat actually produced, not another model's
label. This finding re-asks the review-queue question against 013's truth.

The use is still **offline only**. The 2026-09-21 verdict (no System One model in the daemon,
in routing, or in front of a send) is not re-opened. A verifier placed in the action path is
exactly what [Mid-Harness (arXiv 2609.39982)](https://arxiv.org/html/2609.39982v1) studies, and
its own failure cases (plausible wrong picks on command semantics) are the failure that verdict
was written against.

## Setup

- **Data:** 013's items and raw answers, re-scored. **No new calls to TypeSafe.** Same 266
  items, the same 40/60 tune/test split, both framings, both backends (Jev and Laya).
- **Confidence:** the top probability over the answer options. For the reply question, the
  larger of yes/no. This is the same number 013's ECE is computed on.
- **Cut-off:** chosen on the **tune** split. It is the lowest value in
  `{0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99}` whose tune-split accuracy on kept items reaches 0.90
  with at least 10 kept tune items. If none does, the question has no cut-off and is rejected.
- **Measured on the test split** at that cut-off: coverage (the share of test items kept) and
  accuracy on kept items, with a Wilson 95% lower bound beside it.
- **Two guards:**
  - _confidence_: kept when the top probability is at or above the cut-off.
  - _confidence + framing_: also requires the renamed framing to give the same answer. This
    is the guard against 013's strongest failure (16–27% of Jev's answers flip on option names
    alone). It needs both framings, so it doubles the cost per item.
- **Reproduce:** `node scripts/research/jev/score.ts jev` (and `laya`). The review-queue table
  prints after 013's table.

## Pre-registered bar

A question **passes** as a review-queue labeler when, on the test split:

- **accuracy on kept items ≥ 0.90**, and
- **coverage ≥ 0.40** (the reviewer handles at most 60% of items).

Both must hold under the same guard. The Wilson lower bound is reported but is not part of the
bar. With test splits of 22–110 items, it will often sit below 0.90 even when the point estimate
clears it, and that gap is the honest-N caveat, not a second bar.

Why these numbers: both are judgment calls, written down before the data so they cannot move
after it. 0.90 sits below MotherDuck's 96.9% on confident rows, because that figure is measured
on rows two frontier models already agreed on, which are the easy ones. 0.40 means the queue
takes at least two in five items off a human's desk. Below that, the saving is too small to
justify a hosted model that keeps the text it is sent.

## Result

_Pending. 013's run outputs live outside the repo (ADR 184) on dolly's machine. Scoring runs
once they are reachable from this workspace._
