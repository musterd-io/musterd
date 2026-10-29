# 031 — Family correlation, run once: inconclusive, because the two hit rules disagree

> **Status:** 2026-10-28, lane 01M62K20XC (dolly), asked for by nick. Pre-registered 2026-10-27
> ([manifest](./family-correlation-manifest.md), #3423; reviewed by lazara). The operator set was
> changed once under the kill rule after pilot 1 (#3452). Pilot 2 and the main run were on 2026-10-28.
> **Verdict: inconclusive.** Under the primary rule, `D` = **0.044**, 95% interval **[−0.039, 0.136]**,
> which is under the 0.15 bound ("no family excess worth routing on"). Under the coarse rule, `D` =
> **0.153**, interval **[−0.011, 0.324]**, which is neither verdict. The manifest gives a verdict only
> when both rules agree, so **this finding makes no claim** about ADR 314's presumption. N = 100
> seeded items on 67 features, 25 controls, six reviewers, $16.18 of model spend against the $200 stop.

## Question

The manifest asks: on code changes with one known, test-verified defect each, do two reviewers from
the **same family** miss the defect together more often than two reviewers from **different
families**, beyond what item difficulty alone explains? ADR 314 §2 and §4 presume that they do, and
route acceptance across families on that presumption.

## Setup

The [manifest](./family-correlation-manifest.md) is the setup. It was not changed after the first
measured item, except for the one operator change that its kill rule allows (dated note, #3452).

- **Items:** CooperBench reference `feature.patch` files, each with one defect seeded by
  `scripts/research/family-correlation/mutate.py`. An item was kept only if CooperBench's own
  evaluator then failed at least one test for that feature (`keep.py`, on the Fly machine
  `musterd-cooperbench`). The operators were the four absence classes (dropped statement, dropped
  clause, dropped guard, dropped `elif`), at seed `20261028`. Of the 434 candidates, 215 failed a test
  and were kept. `items.py draw` took 8 pilot items, 100 main items and 27 controls, with at most three
  items per feature and at most two of one class.
- **Reviewers:** two per family, through OpenRouter, by the ids in `models.json`. Each reviewer got the
  manifest's prompt and the numbered diff, at most 2,000 output tokens, and the provider's default
  reasoning settings.

  | Reviewer | Served as | Temperature |
  | --- | --- | --- |
  | claude-opus-5-5 | anthropic/claude-opus-5.5 | provider default |
  | claude-sonnet-5-5 | anthropic/claude-sonnet-5.5 | provider default |
  | gpt-6-sol | openai/gpt-6-sol | provider default |
  | gpt-6.1-terra | openai/gpt-6.1-terra | provider default |
  | grok-4.7 | x-ai/grok-4.7 | 0 |
  | grok-4.3 | x-ai/grok-4.3 | 0 |

- **Scoring:** by script, with no judge (`analyze.py`). The primary hit is a finding within 3 lines of
  the seeded site. The coarse hit is a finding inside the seeded hunk. `D` is the mean phi of the miss
  indicators over the three within-family pairs, minus the mean over the twelve cross-family pairs.
  The interval resamples features 10,000 times (seed 314).

## Pilots

**Pilot 1 failed the miss-rate gate.** It used the first operator set (off-by-one, missed branch,
wrong default, swallowed error). The miss rate was 12.5% under the primary rule and 2% under the
coarse rule, against a band of 20–80%. Six of the eight defects were found by all six reviewers. The
only real miss was a removed `elif` arm, found by 1 of 6 reviewers. Single-token mutants leave an odd
token in the diff, and every family pointed at it. The manifest's dated note records the one operator
change to absence defects. The replies are in [`family-correlation/pilot1/`](./family-correlation/pilot1/).
Spend was $1.05.

**Pilot 2 passed the gate.** It used the absence operators on new items. Every reviewer returned valid
JSON on at least 9 of 10 items. The miss rate was 33.3% under the primary rule and 14.6% under the
coarse rule. The projected total was $19. Spend was $1.41.

## Result

### `D` under both rules

| Rule | Pooled miss rate | Within-family mean phi | Cross-family mean phi | `D` | 95% interval | Rule's reading |
| --- | --- | --- | --- | --- | --- | --- |
| Primary (±3 lines of the site) | 18.2% | 0.570 | 0.526 | **0.044** | [−0.039, 0.136] | upper < 0.15: no excess worth routing on |
| Coarse (inside the hunk) | 8.5% | 0.488 | 0.336 | **0.153** | [−0.011, 0.324] | neither bound: inconclusive |

No reviewer was dropped for zero variance under either rule. The verdict rules give "no excess worth
routing on" under one rule and "inconclusive" under the other. **The run is inconclusive** (`analyze.py`:
`inconclusive (rules disagree)`).

Within-family phi by pair:

| Pair | Primary | Coarse |
| --- | --- | --- |
| Claude (Opus, Sonnet) | 0.537 | 0.382 |
| GPT (6-sol, 6.1-terra) | 0.790 | 0.693 |
| Grok (4.7, 4.3) | 0.382 | 0.390 |

### What the manifest asked the finding to report

- **Seeded hunk spans:** median 30 lines, 75th percentile 69, largest 240. Under the coarse rule, a
  finding anywhere in a 30-line hunk counts as a hit, and in a 240-line hunk almost any finding in the
  file does.
- **Coarse minus primary hit rate, per family:** Claude 0.850 → 0.925 (+0.075). GPT 0.830 → 0.930
  (+0.100). Grok 0.775 → 0.890 (+0.115). The coarse rule was the most lenient for Grok and the least
  for Claude, but the spread is 4 points.
- **Clustering:** 67 features. 43 features have one item, 15 have two, and 9 have three. The largest
  count on one feature is 3.

### Secondary, no verdict rule reads them

**Misses per reviewer (of 100):**

| Reviewer | Primary | Coarse | Valid JSON (of 125) | Controls with a finding (of 25) | Model $ |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 | 13 | 5 | 125 | 11 (44%) | 2.58 |
| claude-sonnet-5-5 | 17 | 10 | 118 | 13 (52%) | 1.44 |
| gpt-6-sol | 18 | 7 | 124 | 19 (76%) | 1.22 |
| gpt-6.1-terra | 16 | 7 | 124 | 21 (84%) | 0.74 |
| grok-4.3 | 29 | 12 | 125 | 12 (48%) | 0.52 |
| grok-4.7 | 16 | 10 | 118 | 13 (52%) | 7.22 |

**By class (pooled over the six reviewers):**

| Class | N | Miss, primary | `D`, primary | Miss, coarse | `D`, coarse |
| --- | --- | --- | --- | --- | --- |
| dropped statement | 30 | 27.8% | 0.043 | 15.6% | 0.207 |
| dropped guard | 30 | 18.3% | −0.064 | 6.7% | −0.049 |
| dropped clause | 23 | 6.5% | 0.565 ¹ | 5.8% | 0.578 ¹ |
| dropped `elif` | 17 | 16.7% | 0.082 | 2.9% | — ² |

¹ claude-opus-5-5 missed no dropped-clause item, so its pairs are dropped. The value rests on the few
misses that the other five reviewers made, so it carries no information.
² Four of the six reviewers missed no dropped-`elif` item under the coarse rule, which leaves no
within-family pair.

Five seeded items were missed by all six reviewers under the primary rule. No item was missed by all
six under the coarse rule.

## Deviations and things the run did not control

- **Grok 4.7's reasoning ran past the output cap.** `max_tokens: 2000` was sent to every reviewer.
  Grok 4.7's billed output had a median of 6,428 tokens and a maximum of 50,924, because OpenRouter
  bills its reasoning outside the cap. That is $7.22 of the $13.72 main-run spend. The other five
  stayed near the cap (medians of 342 to 626 tokens). The manifest put reasoning at the provider
  default. Grok 4.7's default spends far more than the others' defaults.
- **Replies that could not be parsed count as misses**, as the manifest's Errors section says: 16 of
  750 (Sonnet 7, Grok 4.7 7, each GPT 1). This adds misses to two reviewers in different families, so
  it moves `D` very little, but it is in the counts above.
- **The keep pass took about 12.2 machine-hours on Fly**, including an 8-hour hang in the first set's
  pass before `keep.py` got its timeout fix (#3439). The manifest estimated the seeding cost at "under
  $5".

## How far it reaches

- **No claim.** The run does not show that same-family reviewers miss together more often, and it does
  not show that they do not. The finding does not propose an ADR on ADR 314 §4. ADR 314 §4 stays as it
  is, on the same presumption that it had before.
- **Why the two rules disagree.** The coarse rule cuts the cross-family mean phi (0.526 → 0.336) more
  than the within-family mean phi (0.570 → 0.488). Under the coarse rule there are only 51 misses in 600 reviews, so phi is computed on few
  events and its interval is wide. The upper bound of 0.324 is wider than the primary rule's 0.136.
  The manifest chose the both-rules gate to stop a lenient rule from creating a verdict. Here it
  stopped the lenient rule from confirming one.
- **The GPT pair is the most correlated pair under both rules** (0.79 and 0.69). The Claude and Grok
  pairs are near the cross-family mean. This is one pair. The study's statistic is the mean over the
  families, and no rule reads per-family values.
- **Most reviewers flag something on clean code.** From 44% (Opus) to 84% (6.1-terra) of the 25
  controls drew at least one finding. A located hit rule handles this. But this means that a review
  that reports nothing is rare, and that a lenient location rule partly rewards a reviewer for
  reporting more.
- **The items are one kind of defect.** All are absence defects in Python CooperBench features,
  seeded by four operators and checked by tests. Pilot 1 showed that single-token defects are too easy
  for every family. The result does not reach review of real, unseeded changes, or of other
  languages.

## Decision for nick

The manifest ends the study here: the run has been done once and the verdict rules are fixed. A
second, separately pre-registered study could use one hit rule chosen in advance and more items, or
items whose defects are harder to locate. Nothing in this finding asks for that study.

## Reproduce

```bash
S=docs/research/family-correlation
python3 scripts/research/family-correlation/analyze.py --run $S/run2 --stage pilot --cap-usd 200
python3 scripts/research/family-correlation/analyze.py --run $S/run2 --stage main
python3 $S/secondary.py $S/run2          # spans, per-family gaps, clustering, per-class D, pair phi
python3 scripts/research/family-correlation/analyze.py --run $S/pilot1 --stage pilot --cap-usd 200
```

`run2/` holds the keep results for the absence set (`kept.jsonl`), the drawn items and their run order
(`items.jsonl`), and every reply with its tokens and cost (`reviews.jsonl`), for pilot 2 and the main
run. `pilot1/` holds the same files for the first operator set. The candidate patches are not
committed. `items.py seed --dataset <cooperbench>/dataset` at seed `20261028` (or `FIRST_SEED`,
with the `FIRST_CLASSES` operators, for pilot 1) regenerates them byte for byte.
