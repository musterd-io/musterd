# CooperBench pilot: pre-registration

**Lane:** `01M5AQEG23` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-20,
not yet run. Nothing below changes once a measured pair has run; what the run teaches goes in the
finding, not here. **CooperBench:** `63b9d44`. **Arms:** `docs/research/cooperbench/README.md`.

## Question

On CooperBench's 10-pair `core` subset, with Claude Code on `claude-sonnet-4-5`, does swapping the
coordination layer for musterd (lanes with the ADR 150 gate, `team_send` and the inbox) close the
gap CooperBench measures between two agents and one, and does it do so at least as well as
CooperBench's own `team` harness, the best coordination layer the benchmark ships?

## Arms

Three, on one harness and one model. Each is CooperBench's own code path, called, not copied.

| Arm | Run | What coordinates |
| --- | --- | --- |
| **coop** | `cooperbench run -s core --setting coop -a claude_code --git` | `coop-send` / `coop-recv` over Redis; no ownership |
| **team** | `cooperbench run -s core --setting team -a claude_code --git` | a lead and a member, a pre-seeded task list, a shared scratchpad volume, the team MCP server, a mandatory integration checklist before the lead submits (`team_harness/prompt.py`) |
| **musterd** | `cooperbench run -s core --setting coop -a claude_code_musterd --git` | the musterd MCP tools on a fresh team per pair; each agent opens and claims its own lane; the file-editing tools are gated to the agent's lanes; the interrupt hook delivers a partner's acts mid-run (`musterd_cooperbench/prompt.py`) |

The **team** arm is the bar to beat: CooperBench published `claude_code` in `team` on `core` at
**5/10, ~$8.5, 21 min** (`docs/BENCHMARK_RESULTS.md`, run `cc_team_core_v4`). It is re-run here,
on the same machine and day as the other two, so the three numbers share their noise. The published
figure is reported beside it, not in its place.

`--git` is on in every arm (brief item 7): without the shared remote neither agent can bring in the
other's work, so any two features that touch one file conflict whatever the coordination layer.
Whether CooperBench's published core runs used `--git` is not stated in their results page; that is
one reason the team arm is re-run rather than quoted.

**The musterd arm runs musterd as shipped.** Lane ownership is the gate's "the editing seat owns a
covering lane", not "owns it alone": two agents can claim overlapping lanes, the board warns, and
both edit. Run 3 of lane 1 showed agents doing exactly that. Making claims exclusive is a product
change (its own ADR), not a harness setting, so the pilot measures the product as it is and counts
overlapping claims as a secondary measure (below). _Decision recorded: nick, 2026-10-20 — see
"Decisions" at the end; the manifest is not final until each is filled in._

**The OpenHands arms are not in this pilot.** The brief names Claude Code. The open question from
lane 1b (a waiting OpenHands agent is killed by the SDK's stuck detector, in both arms alike) is not
answered here and stays on the README's notes for whoever runs the OpenHands pair.

## Tasks

`dataset/subsets/core.json` at `63b9d44`: 10 pairs over 9 repositories, fixed by CooperBench
(stratified sample, seed 42), the same 10 their table is scored on:

| Task | Features |
| --- | --- |
| `dottxt_ai_outlines/1655` | 1, 3 |
| `dspy/8563` | 1, 4 |
| `go_chi/27` | 3, 4 |
| `llama_index/17244` | 5, 6 |
| `openai_tiktoken/0` | 4, 8 |
| `pallets_click/2800` | 1, 4 |
| `pallets_jinja/1559` | 5, 8 |
| `pallets_jinja/1621` | 6, 10 |
| `react_hook_form/153` | 2, 6 |
| `typst/6554` | 2, 6 |

Three of these (`dspy/8563`, `go_chi/27`, `react_hook_form/153`) failed for every framework in
CooperBench's table. They stay in: the subset is theirs, and dropping them would make the number
incomparable.

## Scoring

**One eval policy, unchanged, for all three arms:** `cooperbench eval --backend docker`, which is
`eval/sandbox.py::test_merged` at `63b9d44`. For a pair: if both `patch.txt` are byte-identical,
test that tree; else attempt a naive 3-way merge and, if it is clean, test the merged tree (that
result is final); if it conflicts or a patch failed to apply, test **agent1's patch alone** against
both feature suites. A pair **passes** when both features' suites pass. There is no union merge and
no member-only fallback. In the `team` arm agent1 is the lead; in `coop` and `musterd` it is the
agent given feature 1. Brief item 4 asked that the musterd arm's policy be stated before the run:
it is this one, with nothing added.

Each pair's patches are stripped of test files by the evaluator (`_filter_test_files`), as always.
Nothing in any arm is re-scored under a different policy after the fact.

## Measures

Primary, per arm over the 10 pairs:

1. **Pass rate**: pairs with `both_passed`, out of 10.
2. **Cost**: the sum of the per-agent USD CooperBench's `claude_code` cost parser records
   (`result.json`), plus the Fly machine's hours, reported separately.
3. **Wall time**: the run's `duration` from `summary.json`.

Secondary, reported but not part of the verdict:

4. Merge outcome per pair (`identical` / `clean` / `conflicts` / `missing_input`) and whether a
   pass came from the merged tree or the agent1-alone fallback (`strategy`).
5. For the musterd arm, from each pair's copied daemon database: lanes opened, pairs where the two
   agents' lane scopes overlapped, acts by kind, gated edits allowed and refused, and whether the
   musterd MCP server was `connected` at both agents' session start (a pair where it was not is an
   **error**, not a score, and is re-run once).
6. For the team arm, CooperBench's own `team_metrics` from `result.json`.

## Verdict rule, fixed before any run

- **The claim "musterd closes the gap at least as well as CooperBench's team harness" may be made
  only if** the musterd arm's pass count is **≥ the team arm's pass count** on the same run day
  **and ≥ 6/10** (strictly above the published team figure of 5/10).
- **The claim "musterd beats plain coop" may be made only if** the musterd arm's pass count is
  ≥ coop + 2. One pair in ten is a coin flip on this N.
- Otherwise the finding reports the three numbers and makes **no** "closes the gap" claim, and
  the goal's next step is decided from the per-pair secondary measures, not from a re-run.
- The verdict is read once, from the first complete run of each arm. A pair is re-run only for an
  **error** (container or MCP startup failure, evaluator error, API outage), never for a failed
  score, and each re-run is recorded with its reason.

## Honest N

Ten pairs. A one-pair difference between arms is within noise; the rules above are set so that
only a two-pair margin over coop, and a lead over team, is read as a signal, and even then it is a
pilot result that names a direction, not an effect size. No per-task conclusions.

## Procedure

On the run machine (`musterd-cooperbench`, Fly `performance-2x`, docker), in this order, in one
session:

1. `fly machine start`; sync the run machine's musterd to the commit named in the finding
   (`pack.sh`); record `musterd-ref.txt`.
2. `gate_smoke.py` must print **PASS** (brief item 9). A FAIL stops the pilot.
3. Pull the ten task images (`cooperbench prepare -s core`) so no arm pays for image pulls in its
   wall time.
4. Run the three arms, `--concurrency 3` (CooperBench's own `core` runs used 3; 10 broke
   container startup), in the order **coop, team, musterd**, each with `--no-auto-eval`.
5. `cooperbench eval` each run, `--backend docker`.
6. Copy each run's `logs/<run>/` (including every musterd pair's daemon database and log) to
   `/data/runs/pilot-2026-10-<dd>/`, and bring `summary.json`, `result.json` and the per-pair
   eval results back to the repo under `docs/research/cooperbench/pilot-runs/`.
7. `fly machine stop`.

Expected spend: from lane 1's one-pair runs, about **$1.1–1.3 per pair** in the coop and musterd
arms and CooperBench's **~$8.5 per 10 pairs** for team, so roughly **$30–40 in model calls** for
the three arms, plus under $5 of Fly time. Spend is approved by nick before step 1 (brief item 6).

## What it changes

- Passing the first rule lets the `cooperbench` goal's outcome ("a public score shows how much of
  that gap musterd's lanes and acceptance close") be stated with this number, and opens the next
  lane: the full dataset, or the OpenHands harness, whichever nick picks.
- Failing it closes the "closes the gap" claim for this configuration. The secondary measures say
  whether the loss was coordination (overlapping lanes, conflicts after a plan) or something the
  harness owes (deaf windows, gate fail-open), and that decides whether a product change (exclusive
  claims) is proposed as an ADR before any second pilot.
- Either way the finding is `docs/research/<next free number>-cooperbench-pilot.md`. The lane brief
  says 015; the resident-seat pilot manifest also promises 015, so the number is the next free one
  at scoring time.

## Decisions

Filled in before step 1; the manifest is not final until each has an answer and a date.

| Decision | Options | Answer |
| --- | --- | --- |
| Lane semantics in the musterd arm | shipped (overlap warns) · exclusive claims (needs an ADR first) | _pending_ |
| Spend | approve ~$30–40 + Fly · hold | _pending_ |
| OpenHands arms | out of this pilot (as above) · in, after the wait fix | _pending_ |
| Finding number | next free at scoring time · 015 regardless | _pending_ |
