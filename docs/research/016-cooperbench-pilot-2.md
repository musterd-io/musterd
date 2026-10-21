# 016 — CooperBench pilot 2: a held file is waited for, then edited from the base

> **Status:** 2026-10-21, lane 01M5FQBPHB (lazara). Pre-registered 2026-10-21
> ([manifest](./cooperbench/pilot2-manifest.md)); run and scored the same day.
> **Verdict: no "closes the gap" claim.** The musterd arm scored **3/10** and CooperBench's own
> `team` harness **2/10** on the same machine and day. The first rule needs musterd ≥ team **and**
> ≥ 6/10; the second half fails.

> **Correction (2026-10-21, lane 01M5G6AGDY).** The musterd arm in this pilot **never had the shared
> git remote either.** Every musterd agent that reached a `git fetch` or `git push` to `team` (all 14 in
> the re-run, and 10 of 20 in the first run, whose other pairs died on the API limit first) failed with
> `unable to look up cooperbench-git`. Its containers use the host's network, where the git server's
> container name does not resolve; the OpenHands arms already used its bridge IP, and this arm did not.
> No team-arm agent saw the failure (0 of 28). So the comparison below is musterd **without** a shared
> remote against `team` **with** one, and the mechanism this finding first gave (the waiting agent
> "edited from the base without pulling the holder's work") is wrong: the agents tried to pull and
> could not. The streams show them pasting diffs to each other in messages instead. The two bad-base
> patches have the same cause (the `main` pin is in the failed setup chain). The scores stand as
> measured. The verdict (no claim) stands. The read of *why* does not, and pilot 3 must run with the
> remote reachable, which the adapter now checks and refuses to score without. ADR 697 is still a
> real product gap (a seat that waits for a file should start from the holder's result) but this
> pilot is not evidence for how much it matters.

## Question

The same question as [finding 015](./015-cooperbench-pilot.md), asked again after the product changes
015 led to: on CooperBench's 10-pair `core` subset, with Claude Code on `claude-sonnet-4-5`, does
swapping the coordination layer for musterd close the gap between two agents and one at least as
well as CooperBench's `team` harness, measured on the same day?

## Setup

Exactly the [manifest](./cooperbench/pilot2-manifest.md): two arms, `team` (`--setting team`) and
`claude_code_musterd` (`--setting coop`), both `--git`, concurrency 3 each and side by side on
`musterd-cooperbench` (`performance-8x`, 16 GB), musterd `9a30c1b2` in the image. The musterd arm ran
the gate in `block` posture over `**`, with
[ADR 691](../decisions/691-named-file-is-held-first-claim-wins.md) (a named file is held, first
claim first) and [ADR 693](../decisions/693-a-hold-lapses-when-its-holder-has-left.md) (a hold lapses
when its agent holder has left) in force. The agents' instructions were byte-identical to pilot 1's.
Eval: CooperBench's unchanged `test_merged`. Per-pair records:
[`readout.py`](../../scripts/research/cooperbench/readout.py), committed with this finding and run
the same way on every pair.

Before any measured pair, on the run machine: `gate_smoke.py` PASS ($0.009), `hold_smoke.py` PASS
($0.007; a second seat refused while the holder was in grace, then let through with the lapse
advisory, both audited with `hold`), and one small `team` pair (`pallets_click` 2068) that submitted
and scored ($2.27). `readout.py` was checked against pilot 1's full logs and reproduced 015's hand
classification exactly (4 coordination, 2 setup, 2 task), after one fix: CooperBench names each patch
after the agent's feature, not its index.

**An error, re-run once, as pre-registered.** At about 19:57Z the API account reached its monthly
usage limit ("You have reached your specified API usage limits"), and 11 pairs died mid-run: seven
musterd pairs and four team pairs, both arms in the same three minutes. nick raised the limit; the 11
were re-run once, under new run names (`p2r-*`) so the first run's logs stay as recorded. The other
nine pairs were scored from the first run. No pair was re-run for its score.

**Two changes to the spend rule, both nick's, both before or outside measured pairs.** The hard stop
went from $65 to $75 after the team smoke pair cost $2.27 (twice the guess: CooperBench's published
team figure ran without `--git`). The re-run got its own stop of $35 ("we are burning through
cash"). Neither was reached.

## Result

| Arm | Pass | Model cost | Run |
| --- | --- | --- | --- |
| `claude_code_musterd` (coop + musterd, `block`) | **3 / 10** | $32.68 | `p2-musterd` + `p2r-musterd` |
| `claude_code` in `team` (CooperBench) | **2 / 10** | $13.58 | `p2-team` + `p2r-team` |
| `claude_code` in `team`, published (`cc_team_core_v4`) | 5 / 10 | ~$8.5 | not comparable: no `--git`, and before the `main` pin |

Per pair. `N` = passed on the merged tree; `·` = failed; `r` = from the error re-run. Cause is the
manifest's class, from `readout.py`.

| Task | musterd | cause | team | cause | common file(s) | holds | after the refusal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `outlines/1655` | **N** (agent1 alone) | — | **N** | — | `outlines/types/__init__.py` | 3 held | request_help, message |
| `dspy/8563` | · | coordination | · | task | `dspy/adapters/types/tool.py` | 1 held | request_help |
| `go_chi/27` | · | coordination | · | coordination | `mux.go` | 1 held | request_help |
| `llama_index/17244` | · r | setup | · | task | `…/base/llms/types.py` | 1 held | request_help |
| `tiktoken/0` | · r | setup | · | coordination | `tiktoken/core.py` | 1 held | request_help |
| `click/2800` | · r | coordination | · | coordination | `shell_completion.py` | 3 held | request_help ×2 |
| `jinja/1559` | **N** r | — | **N** r | — | `src/jinja2/ext.py` | 1 held | request_help |
| `jinja/1621` | **N** r | — | · r | coordination | `src/jinja2/loaders.py` | 2 held | request_help ×2 |
| `react_hook_form/153` | · r | coordination | · r | coordination | `createFormControl.ts`, `form.ts` | 1 held | request_help |
| `typst/6554` | · r | coordination | · r | coordination | `foundations/str.rs` | 1 held | message |

## What the pairs show

**The hold did what ADR 691 says, in every pair.** Both agents' lanes named the same file in all ten
pairs, as in pilot 1. This time the second agent's first edit of it was refused (`hold = held`, the
holder named), 15 refusals across the ten. In nine pairs the refused agent's next act was a
`request_help` to the holder, and in the tenth a message. No hold lapsed: every holder was still
there. The readout's shell heuristic found no agent writing a held file through Bash.

**Waiting in turn did not become building on the holder's work.** go_chi shows it step by step from
the daemon's audit: agent1 claims `mux.go` at 0 s; agent2 names it at 20 s; agent2's edit is refused
at 93 s; agent1 closes its lane at 131 s; agent2 edits `mux.go` at 172 s, through the gated Edit tool,
now allowed, on its own copy of the base file. It never fetched agent1's pushed branch. Both patches
change the same lines of `mux.go`, and the naive merge conflicts. The hold turned a race into a
queue, but the second agent in the queue still started from the old file.

The streams show the same split across the arm. Counting `git merge|pull|rebase|cherry-pick` of a
`team/` branch per agent: in both pairs that passed on the merged tree (jinja 1559 and 1621), **both**
agents merged the other's branch. In every one of the five coordination losses, at least one agent
never did. outlines passed the way 015's typst did: the naive merge conflicted, and agent1's patch
alone carried both features.

**Two musterd pairs lost a patch that would not apply** (`llama_index` agent2, `tiktoken` agent1:
`apply_status: failed`, merge `missing_input`). tiktoken agent1's patch touches 14 files the feature
never needed (`build_wheels.yml`, `Cargo.toml`, …), the signature of a diff against a later upstream
commit. #3111 pinned local `main` to the task base; these agents reached a wrong base another way,
and the streams show them trying to pass diffs to each other through messages. That is a setup hazard
in the musterd arm's runs, and it is unresolved; the team arm lost no pair this way.

**The team arm's losses are the same collision without a hold.** Six of its eight failures are
conflicts on the one shared file; two merged clean or identical and failed a suite.

**Cost.** musterd's agents took far more steps (go_chi: 116 and 117 against team's 43 and 32), and
the arm cost 2.4× the team arm. Part of that is the waiting a hold creates: a refused agent polls its
inbox for the holder to finish.

## Verdict against the pre-registered rules

- "closes the gap at least as well as CooperBench's team harness": musterd 3 ≥ team 2 holds, **≥ 6/10
  fails. Not made.**
- "beats plain coop": the coop arm did not run (manifest); **not read.**
- With the gate in `block` posture.

## Honest N

Ten pairs, one run per arm, one model. A one-pair lead over team is noise; the team arm's own 2/10
against its published 5/10 shows how much `--git` and the `main` pin move a ten-pair number. What
the per-pair record supports is narrower and firmer than the score: the hold changes when the second
agent edits, and nothing yet changes what it edits from.

## Cost

Model: $56.20 for pilot 2 ($2.30 of smoke and the team smoke pair, $24.54 for the first run, $29.36
for the error re-run), under the $75 stop. Fly: about 1.5 h of `performance-8x`; the volume grew from
50 to 80 GB so six pairs at once could not fill it.

## What it changes

1. **No "closes the gap" claim** for this configuration either; the `cooperbench` goal's outcome stays
   unstated.
2. **The next product change is the hand-over of content, not of turn.** When a hold ends (the
   holder's lane finishes or the file is handed off), the seat that was refused should be told where
   the holder's work is (the lane's branch, or the commit that landed it) and to bring it in before
   editing the file. On a real team this is the same gap: waiting for a teammate's file only helps if
   you start from their result. It needs an ADR (amending ADR 691's refusal and the gate's allow after
   a hold), and it is the one product change a third pilot would measure.
3. **The patch hazard is not closed.** Two musterd pairs produced a patch against the wrong base after
   #3111. It is found and fixed in every arm's setup before any third pilot, or that pilot is decided by
   it again.
4. **Cost is a measure from now on.** The musterd arm's 2.4× is reported beside its score; a change
   that wins pairs by multiplying waits is not a free win.

Runs: `docs/research/cooperbench/pilot-runs/2026-10-21-pilot2/` (the per-pair readout, the run log,
and the two run scripts). Each pair's daemon database, log, streams and patches are on the run
machine's volume under `/data/runs/logs/p2-*` and `p2r-*`.
