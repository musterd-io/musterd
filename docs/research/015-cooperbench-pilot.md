# 015 — CooperBench pilot: musterd's lanes on the 10-pair core subset do not close the gap

> **Status:** 2026-10-21, lane 01M5AQEG23 (lazara). Pre-registered 2026-10-20
> ([manifest](./cooperbench/pilot-manifest.md)); stage 1 run and scored 2026-10-21.
> **Verdict: no "closes the gap" claim.** The musterd arm scored **2/10** against a bar of
> 6/10, so the pilot stopped after its first stage, as the manifest said it would. The team and coop
> arms did not run.

## Question

On CooperBench's 10-pair `core` subset ([arXiv 2601.13295](https://arxiv.org/abs/2601.13295),
repo at `63b9d44`), with Claude Code on `claude-sonnet-4-5`, does swapping the coordination layer
for musterd (agent-declared lanes with the ADR 150 gate, `team_send` and the inbox) close the gap
between two agents and one at least as well as CooperBench's own `team` harness, their published
best at **5/10**?

## Setup

Exactly the [manifest](./cooperbench/pilot-manifest.md). One arm ran: `claude_code_musterd`,
CooperBench's `coop` setting with the musterd MCP tools in place of `coop-send`, `--git`,
concurrency 3, on the `musterd-cooperbench` Fly machine (`performance-2x`, docker). musterd
`6fee95a5` in the agent containers (`musterd-ref.txt`); the adapter at
`2be3b5de` (one change during the run, below). Eval: `cooperbench eval --backend docker`, the
unchanged `test_merged` policy (identical → naive merge → agent1 alone). `gate_smoke.py` PASSed
on the machine first ($0.009, one gated deny audited, no deaf warning).

**One error, re-run once, as pre-registered.** `go_chi/27` is an Alpine image; CooperBench's
`setup.sh` installs Node from apk there, which gave v20.15.1, and musterd's CLI refuses Node
under 22. Both agents were refused at seat admission before any model call ($0). The adapter now
puts a pinned musl build of Node 22 in front of apk's on an Alpine image (Debian images already
get Node 22 from nodesource); 35/35 adapter tests pass; the pair was re-run once after the other
nine finished. On the re-run both agents admitted, submitted (64 and 80 steps, $2.76), claimed overlapping lanes on `mux.go`, and the naive merge conflicted: a fail, scored like the other nine.

## Result

| Arm | Pass | Model cost | Wall (run) | Run name |
| --- | --- | --- | --- | --- |
| `claude_code_musterd` (coop + musterd) | **2 / 10** | $29.08 | 42 min for nine pairs at c=3, + 18 min for the re-run | `pilot-musterd` |
| `claude_code` in `team` (CooperBench, published, `cc_team_core_v4`) | 5 / 10 | ~$8.5 | 21 min | not re-run |
| `claude_code` in `coop` | not run | | | |

Per pair. `N` = passed via the merged tree, `L` = passed via agent1's patch alone (naive merge
conflicted), `·` = failed. Their `cc` column is CooperBench's published `team` run.

| Task | musterd | their `cc` team | merge | f1 / f2 tests | cost | acts (directed) | gate allow / deny |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dottxt_ai_outlines/1655` [1,3] | **N** | N | identical | 95/0 · 87/0 | $2.12 | 36 (25) | 4 / 0 |
| `dspy/8563` [1,4] | · | · | clean, f1 fails | 43/7 · 59/0 | $2.67 | 32 (20) | 4 / 1 |
| `go_chi/27` [3,4] | · | · | conflicts (re-run) | — | $2.76 | 26 (13) | 7 / 1 |
| `llama_index/17244` [5,6] | · | · | conflicts | — | $1.36 | 19 (11) | 6 / 1 |
| `openai_tiktoken/0` [4,8] | · | L | agent1's patch did not apply | — | $1.93 | 23 (12) | 8 / 1 |
| `pallets_click/2800` [1,4] | · | · | clean, f2 fails by 1 | 68/0 · 76/1 | $2.97 | 25 (11) | 6 / 2 |
| `pallets_jinja/1559` [5,8] | · | N | conflicts | — | $3.82 | 42 (28) | 7 / 1 |
| `pallets_jinja/1621` [6,10] | · | L | agent1's patch did not apply | — | $4.05 | 38 (23) | 35 / 2 |
| `react_hook_form/153` [2,6] | · | · | conflicts | — | $5.06 | 30 (17) | 14 / 0 |
| `typst/6554` [2,6] | **L** | L | conflicts, agent1 alone passes both | 1/0 · 1/0 | $2.33 | 27 (13) | 10 / 0 |

Every agent in the nine first-run pairs had the musterd MCP server `connected` at session start
and ended `Submitted`; after the re-run no pair was an error. Steps per agent ran 44–112.
The `summary.json` in the run folder is the re-run's (CooperBench rewrites it on `--force`); the
nine first-run pairs' costs are in `stage1-readout.json`, and sum to $26.32.

## What the pairs show

**Every pair claimed overlapping lanes, and the overlap was never the signal.** In all ten pairs
both agents' lane scopes named the same file (`mux.go` in `go_chi`, after the re-run): `outlines/types/__init__.py` twice,
`tiktoken/core.py` twice, `src/jinja2/loaders.py` twice, and so on. The ADR 150 gate requires the
editing seat to own *a* covering lane, not the only one, so both edited; the board's
`surface_overlap` warning is advisory, and no audit row records an agent reading it. The agents
did see each other — 11 to 28 directed acts per pair, one or two `request_help` in most — and
talked about the overlap in prose. That is the shipped product measured as shipped (manifest
decision 1), and it is the same thing lane 1's run 3 saw.

**Coordination talk did not become disjoint edits.** Four pairs ended in a naive-merge conflict
on the one file both lanes named (`llama_index`, `jinja/1559`, `react_hook_form`, `typst`), and
`typst` only passed because agent1 had merged agent2's branch and its patch alone carried both
features. `outlines` passed the way CooperBench's `team` harness passes: both agents merged each
other's work over the shared remote and submitted byte-identical patches.

**Two pairs lost a patch to the git flow, not to coordination.** In `tiktoken` and `jinja/1621`
agent1 merged the partner's branch, then wrote `patch.txt` with `git diff`, which is a diff
against the merged HEAD. Its hunks assume the partner's lines are present, so the patch fails to
apply on the task base (`apply_status: failed`), the merge is `missing_input`, and the agent1-alone
fallback has nothing to test. This is CooperBench's own `_git_block` recipe (`git fetch team &&
git merge … ` then `git diff > patch.txt`), identical in every arm; `cc_team_core_v4` passed both
of those pairs lead-alone, so their lead's patch was whole. It is a harness hazard to name for
the next run, not a musterd effect.

**Two pairs merged clean and still failed a suite.** `dspy/8563` (f1: 43 pass, 7 fail) is the
pair CooperBench's changelog flags as hard for every framework; `pallets_click` failed feature 2
by one test on a clean merge. Neither is a coordination failure.

**The gate did what it was built to do, and it was not the bottleneck.** 101 gated edits allowed,
10 refused across the ten pairs; every refusal was an edit outside the agent's own lane, and the
agent then widened or asked, as lane 1's falsifier predicted. With both lanes covering the same
file, "inside your lane" was never a constraint on the collision that mattered.

## Verdict against the pre-registered rules

- "closes the gap at least as well as CooperBench's team harness": requires musterd ≥ team on
  the day **and ≥ 6/10**. 2/10 fails the floor. **Not made.** The team arm was not run,
  per the staging rule.
- "beats coop": the coop arm was not run; **not read.**

## Honest N

Ten pairs, one run, one model, one harness. 2/10 against a published 5/10 is a
pilot's direction, not an effect size: three of the ten pairs failed every framework in
CooperBench's own table, and two of our failures are a patch-recipe hazard. What the per-pair
record supports is narrower than the headline: with overlapping lanes allowed, musterd's
coordination surface produced the same conflict-on-the-shared-file outcome as plain coop, and
the pairs it won, it won the way `team` wins — by merging the partner's branch.

## Cost

Model: $29.08 for stage 1 ($2.76 of it the re-run), **about twice the manifest's $12–15
estimate**. The estimate came from one pair without `--git` ($1.27); with `--git` and the core
subset's larger repos, pairs ran $1.36–5.06 (median ≈ $2.5). Fly: about 2 h of `performance-2x`.
Stages 2 and 3 were not spent.

## What it changes

1. **No "closes the gap" claim for this configuration**, and `cooperbench`'s goal outcome stays
   unstated.
2. **The next question is exclusive claims** — answered 2026-10-21 by
   [ADR 691](../decisions/691-named-file-is-held-first-claim-wins.md): a lane that names a file
   holds it, first claim first, and the gate refuses the other seat's edit. Every pair's loss that was coordination at all was
   two lanes over one file. Whether a second claim on a covered surface should be refused
   (ADR 150's gate decides ownership; the board only warns on overlap) is a product decision the
   manifest deferred; this is the data for it. It is also dogfood run 8's question. A second pilot
   should not run until that ADR exists, or the second pilot is the same experiment.
3. **The patch recipe needs a line in the arm's instruction** — "diff against the task base, not
   your merged HEAD" — in *every* arm alike, before any arm is scored again, or two pairs per ten
   are decided by `git diff`'s base.
4. The Alpine Node fix stays in the adapter; `go_chi` is the only Alpine image in `core`.

Runs: `docs/research/cooperbench/pilot-runs/2026-10-21-stage1/` (run and eval summaries, the
per-pair eval results, and the per-pair musterd readout: lanes, acts, gate counts).
