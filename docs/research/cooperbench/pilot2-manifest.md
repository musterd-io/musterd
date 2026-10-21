# CooperBench pilot 2: pre-registration

**Lane:** `01M5FQBPHB` (goal `cooperbench`), asked by nick. **Status:** pre-registered 2026-10-21; run 2026-10-21 → [finding 016](../016-cooperbench-pilot-2.md).
Nothing below changes once a measured pair has run; what the run teaches goes in the
finding, not here. **CooperBench:** `63b9d44`. **Pilot 1:** [manifest](./pilot-manifest.md),
[finding 015](../015-cooperbench-pilot.md).

## Question

The same question as pilot 1, with the product changes pilot 1 led to. On CooperBench's 10-pair
`core` subset, with Claude Code on `claude-sonnet-4-5`, does swapping the coordination layer for
musterd close the gap between two agents and one at least as well as CooperBench's own `team`
harness, measured on the same machine and day?

## What changed since pilot 1

Each change is listed with where it reaches. A product change reaches every team that runs musterd;
a setup change reaches every arm alike, or it would be a thumb on the scale.

| Change | Kind | Reaches |
| --- | --- | --- |
| [ADR 691](../../decisions/691-named-file-is-held-first-claim-wins.md): a lane that names a file holds it, first claim first; under `block` the gate refuses another seat's edit of it | product | every team, under the posture it chose |
| [ADR 693](../../decisions/693-a-hold-lapses-when-its-holder-has-left.md): an agent holder that has left stops holding the file, about 90 s after its session ends | product | every team |
| The `lane.gate` audit row records `hold` and `holder` (lane 01M5FR8Y26) | product (record only) | every team |
| Local `main` pinned to the task base (`pin_main.py`, #3111) | setup | every arm |
| A pinned Node 22 ahead of an Alpine image's Node 20 | setup | the musterd arm (the other arms run no Node) |

Nothing else changed. In particular, the agents' instructions (`prompt.py`) are **byte-identical to
pilot 1's**, and so are CooperBench's own prompts for the other two arms. Pilot 1 showed that
agreements in prose did not stop the collision, and an instruction that lifted the score without
reaching a real team is what nick ruled out (2026-10-21).

## Arms

Two, on one harness and one model, as in [pilot 1](./pilot-manifest.md#arms): **team**
(`--setting team`) and **musterd** (`claude_code_musterd`), both with `--git`. **The coop arm does
not run:** it answers only "does musterd beat plain coop", which is not this pilot's verdict, and
it is run later if the musterd arm ties or beats team. _Decision: nick, 2026-10-21, to cut cost._

**The musterd arm runs the gate in `block` posture over `**`**, as it did in pilot 1 (`team.py`).
`block` is a team setting (`musterd team policy --enforce-posture block`), not the default; the
default `warn` turns ADR 691's refusal into an advisory, which pilot 1 showed agents read past. Any
result from this pilot is stated with that setting. _Decision: block — nick, 2026-10-21, on
lazara's recommendation (see "Decisions")._

## Tasks and scoring

Unchanged from pilot 1: the same ten `core` pairs, CooperBench's unchanged `test_merged` evaluator
(`cooperbench eval --backend docker`), test files stripped by the evaluator, one policy for every
arm, nothing re-scored after the fact.

## Measures

Primary, per arm: pass count out of 10, model cost (CooperBench's cost parser), wall time.

Secondary, reported but not part of the verdict: merge outcome per pair and whether a pass came from
the merged tree or agent1's patch alone; the team arm's own `team_metrics`.

**Per-pair diagnosis, every arm.** Each failed pair gets exactly one cause, decided by these rules in
this order, from the eval result and the patches:

1. **setup**: a harness or image error — a patch that did not apply on the task base, a container or
   MCP startup failure, an evaluator error. (An error is also re-run once; see Procedure.)
2. **coordination**: the two patches change a common file and the naive merge conflicted; or one
   agent's patch is empty or missing a feature because it was still waiting on its partner when its
   run ended.
3. **task**: the merge was identical or clean and a feature suite failed.

**Per-pair musterd record, musterd arm**, from each pair's copied daemon database and the agents'
streams:

- lanes opened, and whether the two agents' lanes **named** a common file (ADR 691's case) or only
  covered one through a glob;
- `lane.gate` rows by `hold`: `held` refusals, `lapsed` warns, and the holder;
- after each `held` refusal, what the refused agent did next, the first of: sent its partner a
  `handoff`, `ask` or `request_help`; narrowed or released its lane; waited (inbox checks with no
  edit to that file); **edited the held file through the shell** (Bash is not gated, README); or
  nothing before submitting;
- whether the pair's final patches still changed a common file.

The shell route is measured, not closed, in this pilot: it is a real gap in the gate (Bash edits are
not lane-checked), and if it decides pairs, that is the next product change.

## Verdict rules, fixed before any run

Carried over from pilot 1 unchanged, read once from the first complete run of each arm:

- **"musterd closes the gap at least as well as CooperBench's team harness"** only if musterd ≥ the
  same-day team arm **and** ≥ 6/10.
- **"musterd beats plain coop"** is **not read**: the coop arm does not run.
- Otherwise the finding reports the two numbers and makes no such claim.
- Any claim names the setting: "with the gate in `block` posture".

And one rule for what the run is for, whatever the score: the finding names **the next product
change** from the per-pair diagnosis — the cause class that lost the most musterd pairs, and within
it the mechanism the musterd record shows.

## Honest N

Ten pairs, one run per arm. A one-pair difference is noise. No per-task conclusions.

## Procedure

On the run machine (`musterd-cooperbench`, now `performance-8x`, 16 GB), in this order, in one
session. A check that fails stops the procedure before any measured spend.

1. **Deploy** from `main` at or after the audit-row fix, with `MUSTERD_REF` = that commit (`fly
   deploy … --build-arg MUSTERD_REF=$(git rev-parse HEAD)`). Record `musterd-ref.txt`.
2. **Smoke, under $1 in all:**
   - `gate_smoke.py` prints PASS (the gate is live in the arm's wiring);
   - `hold_smoke.py` prints PASS (a named file is held, the second seat is refused while the holder
     is in grace, and the hold lapses after it leaves; both audited with `hold`).
3. **One small pair in the team arm**, `pallets_click` task 2068, features 1 and 2, `--git`,
   scored with the evaluator (about $1). Pass: both agents submit and the pair scores (pass or
   fail, never an error). The team arm has never run on this machine; a setup error found here
   costs $1, not an arm.
4. **Pull the ten task images** (`cooperbench prepare -s core`).
5. **Run the two arms side by side**, `--concurrency 3` each, `--no-auto-eval`, then
   `cooperbench eval --backend docker` for each. No arm is stopped for its score.
   **Stop an arm only for errors:** if three of its first three pairs end in an error, stop it, fix
   the cause, and re-run it whole; that restart is recorded with its reason.
6. **Errors** (container or MCP startup failure, evaluator error, API outage) are re-run once, each
   with its reason recorded. A failed score is never re-run.
7. Copy every run's `logs/<run>/` (with each musterd pair's daemon database and log) to
   `/data/runs/pilot2-2026-10-<dd>/`, and bring `summary.json`, the eval results and the per-pair
   readout into the repo under `docs/research/cooperbench/pilot-runs/`.
8. `fly machine stop`; set the VM back to `performance-2x` before any later single-pair work.

## Spend

| Item | Estimate |
| --- | --- |
| Smoke and the team arm's small pair | $2 |
| musterd arm (pilot 1: $29.08 for ten pairs with `--git`) | $25–35 |
| team arm (CooperBench published ~$8.5 for ten; `--git` adds some) | $10–20 |
| Fly `performance-8x` for about 2 h | under $3 |
| **Total** | **about $40–60** |

Approved by nick on 2026-10-21: about $40–60, **hard stop at $65** in model spend, counted from
the first smoke. A run that reaches $65 is stopped and reported, not finished.

## What it changes

- Passing the first rule lets the `cooperbench` goal's outcome be stated with this number and its
  setting.
- Either way the finding (the next free number at scoring time) names the next product change, and
  the [progress page](https://claude.ai/artifact/3jJiB8uPbB8kcskdNgqSG3) is updated with the run.

## Decisions

| Decision | Options | Answer |
| --- | --- | --- |
| The holder-leaves deadlock | fix in the product first · run as is · tell agents to close their lanes | **product first** (ADR 693) — nick, 2026-10-21 |
| Arms | musterd + team · all three | **musterd + team**, $40–60, hard stop $65 — nick, 2026-10-21 (first said all three, then asked to cut cost) |
| Posture in the musterd arm | `block` (the setting ADR 691 needs) · `warn` (the default) | **block**, stated with every result — nick, 2026-10-21, on lazara's recommendation |
| Staging | staged with a score stop (pilot 1) · all arms, stop for errors only | **all arms, errors only** — follows from nick's "take full advantage of each run", 2026-10-21 |
