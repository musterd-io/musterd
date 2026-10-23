# CooperBench coordination run: pre-registration

**Lane:** `01M5K1BCVG` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-22; not yet run.
Nothing below changes once a measured pair has run; what the run teaches goes in the finding, not
here. **CooperBench:** `63b9d44`. **Before this:** [claim run](./claim-manifest.md) →
[finding 021](../021-cooperbench-claim-run.md), [finding 022](../022-cooperbench-coordination-residue.md).

## Why

Five runs have asked whether musterd's two agents **pass** as many pairs as one agent, and the answer
stays inside the noise: 5/20 against 6/20, and single pairs flip between runs. Most of the pass rate
is the model's ability to write the feature, which no coordination layer changes. Settling it would
take about 80 pairs (finding 021), which is more than this question is worth (nick, 2026-10-22).

What musterd does control is whether two agents working on one repository **collide**. That is
measured per pair, under the rules pilot 2 pre-registered, and the effect is large:

| Arm | Pairs whose two patches conflicted on a common file | Run |
| --- | --- | --- |
| musterd (`block`) | **0 / 20** (all 20 submitted byte-identical patches) | claim run, 2026-10-22 |
| musterd (`block`) | 0 / 10 | pilot 3, 2026-10-21 |
| CooperBench `team` | **6 / 10** | pilot 3, 2026-10-21 |

On `core`, the comparison is already decided by data in hand, so spending on it again would only
repeat it. The claim is therefore made on **fresh pairs**: the claim run's ten new tasks, which no
team or coop arm has run. On those ten, musterd's patches never conflicted (0/10), and every one of
the ten pairs has the two features changing at least one common file, so a conflict was possible in
each.

## Question

On the ten new tasks (`claimnew`, listed in the [claim manifest](./claim-manifest.md#tasks)), with
Claude Code 2.1.307 on `claude-sonnet-4-5` and `--git`, do CooperBench's own two-agent harnesses
(`team`, and the paper's plain `coop`) end with conflicting patches more often than musterd did?

## Arms

| Arm | Command |
| --- | --- |
| **team** | `cooperbench run -s claimnew --setting team -a claude_code --git -c 3` |
| **coop** | `cooperbench run -s claimnew --setting coop -a claude_code --git -c 3` |
| musterd | not re-run: the claim run's `claim-musterd-new` (2026-10-22, the same image and Claude Code) |

The two arms run side by side on `musterd-cooperbench`, image `7e795fcb`. Neither arm uses
musterd. The agents' instructions are CooperBench's own, unchanged.

## Measures

Every measure comes from [`readout.py`](../../../scripts/research/cooperbench/readout.py), unchanged.

- **Primary: merge conflict.** The pair's naive merge reports `conflicts` and the two patches change
  a common file. This is `readout.py`'s `merge == "conflicts"` together with a non-empty
  `common_files`. A conflict counts whether or not the features would have passed: it measures the
  collision, not the task.
- **Secondary: coordination losses.** Pilot 2's per-pair cause, `coordination`: a conflict on a
  common file, or one agent's patch empty or missing because it was still waiting. Reported overall,
  and **on the pairs the solo arm passed in the claim run** (`huggingface_datasets/7309`,
  `pallets_jinja/1465`), where a coordination loss is a pair one agent can do and two did not.
- Reported, with no rule: pass count, model cost, wall time.

## Verdict rules, fixed before any run

Each arm is compared on its own against musterd's **0/10** on the same ten tasks, with a one-sided
Fisher's exact test.

- **At least 4 of 10 pairs conflicted** (p = 0.043): "on ten fresh CooperBench pairs, musterd's
  agents never produced conflicting patches; CooperBench's `<arm>` harness did in N" may be stated,
  with the setting (`block`, Claude Code 2.1.307, `claude-sonnet-4-5`, `--git`) and the note that
  the musterd arm ran the day before.
- **0 to 3 of 10:** no claim for that arm. The counts are reported.

Pilot 3's `core` result for team (6/10) is reported beside these, and decides nothing.

What the claim does **not** say: that musterd passes more pairs, or as many as one agent. Fewer
collisions is a coordination claim. Pass rates stay reported, with no rule.

## Errors

An error (container startup, evaluator error, API outage or usage limit) is re-run once under a new run
name, with its reason recorded. A failed score is never re-run. An arm with errors in three of its
first three pairs is stopped, the cause fixed, and the arm re-run whole.

## Procedure

1. Start the run machine. No redeploy: it carries `7e795fcb`, Claude Code 2.1.307, and the ten new
   tasks' images from the claim run's second half. One `claude -p` API check.
2. **One coop smoke pair** (`pallets_click` 2068, features 1 and 2, `--git`, about $0.70), scored.
   The coop arm has never run on this machine. It passes if both agents submit and the pair scores
   without an error. Team needs no smoke: it ran in pilots 2 and 3 on this image's predecessor, and
   neither arm touches musterd.
3. Run both arms side by side on `claimnew`, `-c 3` each, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under a spend watcher.
4. Re-run errors once, copy the readout, run log and script to
   `docs/research/cooperbench/pilot-runs/`, and stop the machine.

## Spend

| Item | Estimate |
| --- | --- |
| API check, coop smoke pair | ~$0.70 |
| team, 10 pairs (pilot 3: $13.76 for 10) | $12–16 |
| coop, 10 pairs (no prior on this machine; coop has no lead/member overhead) | $10–16 |
| Fly `performance-8x`, under an hour | under $3 |
| **Total model spend** | **about $29** |

**Hard stop: $35 of model spend**, counted from step 1, re-runs included.

## Decisions

| Decision | Answer |
| --- | --- |
| Measure coordination losses, not passes; keep the cost down | **yes**: nick, 2026-10-22 ("do 1", after declining a ~$190 powered pass-rate run) |
| Claim on fresh pairs, not on `core` | this manifest: `core` is already decided by pilot 3's data |
| Spend | **pending nick's approval**: about $29, hard stop $35 |
