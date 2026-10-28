# Family correlation: pre-registration

**Lane:** `01M608FCFB` (goal `family-correlation`), asked by nick. **Status:** pre-registered
2026-10-27; not run. Reviewed by lazara (01M608HTZ1), whose points fixed the design below. Nothing
under Verdict rules changes once a measured item has run; what the run teaches goes in the finding,
not here. **Reads with:** [ADR 314](../decisions/314-correlated-models-correlated-mistakes.md),
[finding 004](./004-cross-family-diversity-flag-live.md),
[single-agent loop guidance](../wiki/single-agent-loop-guidance.md).

## Why

ADR 314 presumes that reviewers from the same model family make correlated judgments, and routes
acceptance across families as a proxy for an independent judge (§2, §4). Nothing in
`docs/research/` measures that presumption. Finding 004 shows the diversity flag renders. Finding
020 records reviewer families, but not worker families on 9 close rows, and compares nothing. The
outside results usually cited near this question (Vals on Vibe Code Bench, the 1/10/30/100-agent
table in the Claude Opus 5.5 system card) test copies of one model, so they do not bear on it
either.

## Question

On code changes with one known, test-verified defect each, do two reviewers from the **same family**
miss the defect together more often than two reviewers from **different families**, beyond what item
difficulty alone explains?

## Items

An item is a CooperBench reference `feature.patch` with **one defect seeded by a script**, kept only
if CooperBench's own evaluator then fails at least one of that feature's tests. The defect is then
ground truth with a known location, so a miss and a shared miss need no judgment call.

- **Dataset:** CooperBench at `63b9d44` (`COOPERBENCH_COMMIT` in `deploy/cooperbench/Dockerfile`),
  `dataset/`. **Python features only**: 165 features in 9 repositories (outlines, dspy, datasets,
  llama_index, tiktoken, click, jinja, Pillow, dirty-equals). go-chi, react-hook-form and typst are
  out, because the operators below are written for Python. _Added 2026-10-27, before any item ran._
- **Keep rule:** CooperBench's `run_patch_test` in the solo setting, one patch against the feature's
  own tests (lazara). The unmutated reference must pass. The mutant is kept when it fails at least
  one test **and passes at least one**, so a mutant that breaks import or collection is dropped as
  too obvious. An evaluator error drops the mutant. _Added 2026-10-27._

- **Why seeded, not harvested** (lazara): across the committed CooperBench runs, 2 of 10 eval records
  are a clean merge with a failed feature test. Merge conflicts and patches that failed to apply are
  not defects a reviewer can find, and the agents' patches were not committed.
- **Who seeds:** nobody. A fixed-seed mutation script picks the site and applies the operator, so no
  model family authors a defect that its own family might be better at spotting.
- **Defect classes**, one operator set each, drawn as evenly as the kept pool allows (an even
  split is not possible: at `63b9d44`, wrong default has candidate sites in 23 features, missed
  branch in 63; the finding reports N per class). _Amended 2026-10-27, before any item ran; the
  first text said "drawn evenly"._ Each operator touches only lines the
  feature adds, so the mutant still applies to the task's base commit. Off-by-one: a comparison
  flipped, `<` with `<=` or `>` with `>=`. Missed branch: an added `elif` or `else` arm removed with
  its body. Wrong default: a parameter default changed, `True` with `False` or an integer `n` to
  `n + 1`. Swallowed error: an added one-line `raise` replaced with `pass`. _Narrowed 2026-10-27 to
  the operators `scripts/research/family-correlation/mutate.py` implements; the first text also
  named range bounds and dropped error returns._
- **At most two items per feature**, in different classes. The analysis resamples by feature.
- **Controls:** one clean reference patch for every four seeded items, mixed in, so a reviewer
  cannot assume every item has a defect. Drawn by the same seed from Python features that carry no
  seeded item. Controls count only toward the false-alarm rate.

## Reviewers

Two different models from each of three families, six reviews per item:

| Family | Models |
| --- | --- |
| Claude | `claude-opus-5-5`, `claude-sonnet-5-5` |
| GPT | `gpt-6-sol`, `gpt-6.1-terra` |
| Grok | `grok-4.7`, a second Grok model confirmed before the pilot |

The within-family pairs are **two different models** in a family. That is the primary contrast.
Two runs of the same model measure something else (lazara) and are not in this run. If no second
Grok model is available when the pilot starts, the manifest gets a dated note before any measured
item, and Grok contributes cross-family pairs only. That leaves 2 within-family pairs per item
instead of 3. The power table below assumes 3.

**Blind, one-shot, outside revive.** Each review is one API call with the same prompt: the task
text and the diff, nothing else. There is no seat, no lane, no trailer and no team context, because
a seat on revive can see who wrote the change (lazara). The in-team effect is a different question
and a later arm. The reviewer must answer in JSON: a list of `{file, line, summary}` findings, which
may be empty.

**The diff carries explicit line numbers.** Every added and context line is prefixed with its
new-file line number, so no reviewer has to work numbers out from the hunk headers. How precisely a
model does that is a model trait and probably a family trait, and it would put correlated misses
into `D` where the defect was in fact found (lazara).

**The prompt, fixed here:**

> You are reviewing a code change before it is merged. Below are the task the change implements and
> the diff. Each added or unchanged line is prefixed with its line number in the new file; use that
> number. The change may contain no defect. Report only defects: behaviour that is wrong for the
> task, not style. Answer with JSON only, in the form
> `{"findings": [{"file": "<path>", "line": <new-file line>, "summary": "<one sentence>"}]}`. Return
> `{"findings": []}` if you find no defect.
>
> TASK: {task text}
>
> DIFF: {numbered diff}

**Sampling:** temperature 0 where the model's API accepts it, otherwise the provider default, with
what each model ran at recorded in the finding. At most 2,000 output tokens. Reasoning or effort
settings stay at the provider default, and are recorded. Nothing here changes after the pilot
starts.

## Measures

- **Hit, primary:** a finding in the seeded file whose line is within 3 lines of the seeded hunk.
  Scored by script, with no judge.
- **Hit, coarse:** a finding in the seeded file whose line falls inside the diff hunk that holds the
  seeded site (its new-file range). _Amended 2026-10-27, before any item ran: the first text said
  the same function, but a function's bounds cannot be read from the diff the scorer has, and
  CooperBench's feature hunks mostly add whole functions anyway._ The verdict must hold under
  both rules (see Verdict rules).
- **Location of a deletion** (missed branch, dropped error return): the new-file line where the
  removed lines were, which is the first line after them.
- **Miss:** a seeded item with no hit.
- **A reviewer with no variance:** phi is undefined for a reviewer who misses every seeded item or
  none. That reviewer's pairs are dropped from `D` and reported, with no continuity correction. If
  that leaves no within-family pair, the run is inconclusive.
- **Primary statistic:** `D` = the mean phi coefficient of the miss indicators over within-family
  pairs, minus the mean over cross-family pairs. Phi is computed per reviewer pair across all seeded
  items. Item difficulty raises phi for every pair alike, so it cancels in the difference.
- **Interval:** a 95% bootstrap interval on `D`, resampling features (and every item of a resampled
  feature), 10,000 resamples, fixed seed.
- **Secondary, no verdict rule reads them:** miss rate per model and class; false alarms on
  controls; `D` per defect class.

## Power

Simulated in a latent model: an item difficulty shared by all six reviewers, a family effect shared
within a family, and independent noise, at a 50% miss rate. A "detected" result is a 95% interval
that excludes 0.

| True `D` | N = 20 | N = 40 | N = 60 | N = 80 |
| --- | --- | --- | --- | --- |
| 0.08 | 11% | 12% | 26% | 31% |
| 0.16 | 29% | 39% | 63% | 81% |
| 0.26 | 54% | 75% | 88% | 96% |

The **minimum effect worth acting on is `D = 0.15`**. Below that, a family proxy would buy so little
independence that it should not drive routing. Simulated at that effect itself, **N = 80 seeded
items gives 74% power and N = 100 gives 81%.** The 20 items in the first draft would not have come
close. **N = 100 is the pre-registered size**, chosen by nick on 2026-10-27 over N = 80 for the
extra power, at about $25–35 more. The miss rate matters as much as N: at
a 10% or 90% miss rate, few pairs disagree and power collapses. The pilot sets the rate.

## Verdict rules, fixed before the run

`D` is computed under both hit rules. A verdict is stated only when both rules give it. If they
disagree, the run is inconclusive, and the finding reports both.

- **Lower bound of `D` > 0: "same-family reviewers miss together more than cross-family ones."**
  ADR 314's presumption holds on seeded defects, and the finding states the size with its interval.
- **Upper bound of `D` < 0.15: "no family excess worth routing on."** Same-family reviewers share no
  more misses than cross-family ones by the minimum effect or more. The finding proposes an ADR that
  revisits ADR 314 §4's routing preference. The finding never claims that diversity is useless,
  only that the family proxy did not show the effect.
- **Otherwise: inconclusive.** The finding reports `D` and its interval, and makes no claim.

## Pilot and kill rule

Eight seeded items and two controls, run first and excluded from the 100. The pilot passes if:

- every model answers in the JSON shape on at least 9 of 10 items, and
- the pooled miss rate on seeded items is between 20% and 80%.

If the miss rate is outside that band, the operator set is changed once (subtler sites if almost
nothing is missed, plainer ones if almost everything is), with a dated note here, and the pilot is
re-run once on new items. **If the second pilot also fails, the study stops** and the finding says
why.

## Errors

An API error or timeout is retried once, with the reason recorded. An answer that is not valid JSON
counts as a miss and is reported. A scored review is never re-run.

## Spend

| Item | Estimate |
| --- | --- |
| Seeding: CooperBench eval runs to keep or drop each mutant (no model calls) | Fly machine, under $5 |
| Pilot, 10 items × 6 reviews | $9–14 |
| Main run, 100 seeded + 25 controls × 6 reviews | $112–169 |
| **Total model spend** | **about $121–183** |

Each review is about 10k input and 1k output tokens: $0.225 at Opus-class list rates. The upper
figures price all six models at that rate. The lower figures assume the cheaper models bring the
mean to about $0.15. **Hard stop: $200 of model spend**, retries included.
**nick approves the spend** before the pilot starts. _Approved 2026-10-27 by nick, in dolly's
session, for N = 100 and up to the $200 stop._

**Re-ask after the pilot.** The six models are not priced yet. After the pilot, the mean cost per
review is multiplied by the main run's reviews (750 at N = 100) and added to the pilot's spend. If
that exceeds $200, the run stops there and goes back to nick before any main-run item, so it is
never found out at item 70 (lazara).

## Procedure

1. Write the mutation script and the review runner in `scripts/research/family-correlation/`,
   in their own lane, with tests for the scorer.
2. Seed candidate mutants, run CooperBench's evaluator, keep the failing ones until the pilot set and
   the 100 are drawn. Commit the item list with each item's feature, class, file and hunk.
3. Confirm the six models. Run the pilot. Apply the kill rule.
4. Run the 100 seeded items and 25 controls in a random order fixed by seed.
5. Score, compute `D`, and write the finding.

## Not in this run

- Same-model pairs (two runs of one model).
- The in-team arm: the same items reviewed by seats on revive.
- The live close rows. Reading them later needs a fix for the 9 close rows in finding 020 with no
  `worker_family`. That fix is its own lane and does not block this one.

Follows-up: the tooling lane (procedure step 1) and the `worker_family` fix lane are opened when
this manifest lands, under goal `family-correlation`.
