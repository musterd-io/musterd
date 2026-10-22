# 021 — CooperBench claim run: one pair apart at N = 20, and the cost fixes worked

> **Status:** 2026-10-22, lane 01M5GWBB17 (lazara), asked for by nick. Pre-registered 2026-10-22
> ([manifest](./cooperbench/claim-manifest.md)); run and scored the same day.
> **Pass verdict: inconclusive, as pre-registered.** musterd's two agents passed **5/20** and one
> agent doing both features passed **6/20**. Solo = musterd + 1 is the manifest's "no claim" case,
> the same gap as at N = 10 (finding 018). **Cost verdict: delivered.** On the 10 `core` pairs, musterd
> cost **$17.29**, under the $19.55 line: 30% below pilot 3's $24.59, and close to finding 019's
> $16.29 estimate.

## Question

On 20 CooperBench pairs, with Claude Code on `claude-sonnet-4-5`, do musterd's two agents (one
feature each) pass as many pairs as one agent given both? And on `core`, what does musterd cost now
that finding 019's two fixes are in (join at session start with tool search on, ADR 707; a blocking
wait, ADR 705)?

## Setup

As the manifest says. musterd (`block` posture, ADR 691 + 693 + 697) and CooperBench's own solo arm
ran side by side on `musterd-cooperbench`, `-c 3` each, Claude Code pinned to 2.1.307. The tasks
were CooperBench's 10 `core` pairs plus 10 new tasks drawn with a fixed seed, one pair each. Each arm
was scored with CooperBench's unchanged evaluator.

**Deviations from the manifest's procedure, none in a measured pair** (details in the
[run log](./cooperbench/pilot-runs/2026-10-22-claim/run.log)):

1. **Claude Code was pinned** to 2.1.307, the version pilot 3 and the solo reference ran. `latest` had
   moved to 2.1.308. This was written into the manifest before any measured pair.
2. **Host smokes ran as an unprivileged user.** Claude Code refuses `--dangerously-skip-permissions`
   as root, and CooperBench's containers avoid that with `IS_SANDBOX=1`. Only the host-side smokes
   were affected.
3. **Two aborted starts, $0 measured spend.** The first started the arms without pulling images
   (`cooperbench prepare` takes no subset). The second pulled all 20 images (83 GB), filled the
   79 GB volume, and every container errored at install. Neither produced a score.
4. **The run went in two halves:** `core` (18:24Z), then the ten new tasks (19:01Z). Both arms ran side
   by side within each half, on the same machine and day, under one $60 stop.

Pre-flight passed. `gate_smoke.py` passed with tool search on, as did pilot 3's ADR 697 hold smoke. On
the smoke pair, both agents submitted and fetched and merged each other's work, with no lookup
failures, at $2.07 against pilot 3's $2.85 on the same pair. **No measured pair errored and none was
re-run.** All 40 musterd agents and all 20 solo agents submitted.

## Result

| Arm | All 20 | `core` | new 10 | Model cost (20) | Wall time (core + new) |
| --- | --- | --- | --- | --- | --- |
| **musterd** (two agents, `block`) | **5 / 20** | 4 / 10 | 1 / 10 | $35.99 | 27 + 27 min |
| **solo** (one agent, both features) | **6 / 20** | 4 / 10 | 2 / 10 | $11.18 | 12 + 12 min |

| Task | Half | musterd | solo |
| --- | --- | --- | --- |
| `outlines/1655` | core | **pass** | **pass** |
| `jinja/1559` | core | **pass** | **pass** |
| `jinja/1621` | core | **pass** | **pass** |
| `tiktoken/0` | core | **pass** | fail |
| `typst/6554` | core | fail | **pass** |
| `dspy/8563`, `go_chi/27`, `llama_index/17244`, `click/2800`, `react_hook_form/153` | core | fail | fail |
| `jinja/1465` | new | **pass** | **pass** |
| `datasets/7309` | new | fail | **pass** |
| `outlines/1371`, `outlines/1706`, `dspy/8587`, `go_chi/26`, `llama_index/18813`, `click/2068`, `click/2956`, `react_hook_form/85` | new | fail | fail |

**Every musterd loss is a task loss, not a coordination loss.** In all 20 musterd pairs the two agents
submitted byte-identical patches, so no pair was decided by a merge. Each failure is a feature suite
failing on the one tree they agreed on.

## Verdict against the pre-registered rules

- **Pass:** `M = 5`, `S = 6`, so `S = M + 1`. **Inconclusive, no claim.** Neither "musterd's two
  agents pass as many pairs as one agent" (needs `M ≥ S`) nor "a gap remains" (needs `S ≥ M + 3`)
  may be stated.
- **Cost:** musterd on `core` cost $17.29, which is ≤ $19.55. **"The two fixes delivered the saving
  finding 019 predicted."** That is 30% below pilot 3's $24.59 and 6% above the $16.29 estimate.

## What the pairs show

**The discordant pairs are three, and they point both ways.** Solo alone passed `typst/6554` and
`datasets/7309`. musterd alone passed `tiktoken/0`. The verdict rests on those three pairs. At this
N, a one-pair margin is the smallest difference the run can show.

**Pair outcomes on `core` changed between runs, in both arms.** Against pilot 3 and the solo reference
a day earlier (same pairs, model and harness), musterd's `core` passes swapped `typst` for `tiktoken`,
and solo lost `tiktoken`. Two of ten musterd pairs and one of ten solo pairs flipped. The arm counts
(4 and 4 here, 4 and 5 then) stay close, but no single pair is stable. That is why finding 018's one
"pair that splitting the work cost", `tiktoken`, does not reproduce.

**The new ten are harder than `core`** for both arms: 1/10 and 2/10, against 4/10 and 4/10.
CooperBench's `core` was built so its pass rate tracks the full set. On this draw, it ran high.

## The cost, and whether the fixes acted

| Measure, musterd on `core` | Pilot 3 (2026-10-21) | Claim run |
| --- | --- | --- |
| Model cost | $24.59 | **$17.29** |
| First-call context (median agent) | 39.6k tokens | **25.3k** (solo: 22.7k) |
| Blocking waits (`team_inbox_check {wait}`) | none existed | 84 calls; every one of 40 agents used it |
| Polling-shaped calls (plain inbox check, `lane_board` / `team_status`, `sleep` in Bash) | 257 inside waits | 101 anywhere |
| musterd cost ÷ solo cost, `core` | 4.0× | **3.4×** |

- **A, join at session start with tool search on, acted.** Agents loaded musterd tools through
  `ToolSearch` (98 calls over 40 agents). A musterd agent's first call now carries 2.6k tokens more
  than a solo agent's (25.3k against 22.7k). In pilot 3 it carried 39.6k, about 17k more than today's
  solo agent (pilot 3 did not record a solo first-call context).
- **B, the blocking wait, acted.** All 40 agents used it. The polling-shaped calls are counted with a
  wider ruler than 019's (every such call, not only those inside a wait), so 101 is an upper bound
  against 257.
- **C, the state-carrying sends, did not shrink much:** 149 `team_send` calls on `core`. 019 counted
  132 of pilot 3's sends as carrying state the product already has. Telling those sends apart needs
  019's keyword labels, which this run did not apply. Fix C (#3172) wakes the waiter. It does not
  stop an agent from announcing.

Two agents still cost **about 3.2× one** over all 20 pairs ($35.99 against $11.18). Finding 019 said
two agents cost about 2.5× one at best, which is the team harness's own ratio. musterd is now closer
to that floor than in pilot 3, but not at it.

## Honest N

Twenty pairs, one run per arm, both arms the same day and machine. Two halves, each side by side. The
three discordant pairs split 2–1. The `core` re-run shows that individual pairs flip between runs.
Whether two agents match one agent on CooperBench is not settled by this run, and a bigger N alone
may not settle it: the arms differ by less than the run-to-run swing on single pairs.

## Cost of the run

Model: **$49.25** ($2.07 smoke pair, $35.99 musterd, $11.18 solo), under the $60 stop and near the
~$47 estimate. The aborted starts cost $0 in model spend. Fly: about 1.5 h of `performance-8x`. The
five CooperBench runs together: about $195 of model spend.

## What it changes

1. **No claim about passes, and the reason is now firmer.** At N = 10 and N = 20 musterd's two
   agents are one pair behind one agent, with every musterd loss a task loss. The open question is
   whether two agents can match one, not whether coordination loses pairs. Coordination lost none
   here.
2. **The cost claim can be made, with its setting:** on CooperBench `core`, with Claude Code on
   `claude-sonnet-4-5` in `block` posture, musterd's two agents cost 30% less than before finding
   019's fixes ($17.29 against $24.59), and the fixes are why: first-call context and polling both
   fell as predicted.
3. **The next cost lever is the sends.** About 150 `team_send` calls per 10 pairs remain. Labelling
   them with 019's rules is the next diagnosis, and it needs no new run.
4. **Harness fixes, landed with this finding:** Claude Code is pinned in the run image (it was
   `latest`). `claim.sh` pulls images directly and runs in halves when the images exceed the volume.
   The smoke scripts' root and ADR 697 problems are passed to big-body's smoke-hardening lane
   (`01M5G2PCFW`).

Runs: `docs/research/cooperbench/pilot-runs/2026-10-22-claim/` (per-pair readout, per-agent tool
counts and the script that made them, the run log, the run script).
