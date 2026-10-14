# Eval results

## Run 1 — 2026-10-13

- **Skill:** the rebuilt draft (lane `01M4VPY2D5`, before merge). **Model:** Claude Opus 5.5 for
  every run and grader.
- **Runs:** 10 cases × 2 configs, each a fresh read-only session told it was a simulation, with-skill
  runs told to stay out of `evals/` except the input files. Both configs ran inside the musterd
  repository, so the baseline could read the brand guide, the a11y docs and the ADRs: the baseline
  is strong on purpose.
- **Grading:** `building-a-role-skill/scripts/check-evals.mjs`, then two graders blind to which
  answer was which (seed 5862), who checked claims against the repository and recomputed contrast
  ratios.

| | With skill | Without skill |
| --- | --- | --- |
| Expectations passed | 38 of 38 | 30 of 38 |
| Checks passed | 22 of 22 | 18 of 22 |
| Mean quality (1–10) | 8.8 | 7.1 |
| Cases the grader preferred | 10 of 10 | 0 of 10 |
| Factual errors found by graders | 6 | 8 |

| Case | With skill: expectations · checks · quality | Without skill: expectations · checks · quality | Grader preferred |
| --- | --- | --- | --- |
| visual-tells-review | 5/5 · 4/4 · 9 | 5/5 · 4/4 · 9 | with skill |
| visual-cli-color | 4/4 · 2/2 · 9 | 4/4 · 2/2 · 8 | with skill |
| a11y-live-scene | 4/4 · 3/3 · 9 | 2/4 · 1/3 · 7 | with skill |
| a11y-board-drag | 3/3 · 2/2 · 8 | 3/3 · 2/2 · 8 | with skill |
| handoff-stale-banner-spec | 4/4 · 2/2 · 9 | 3/4 · 1/2 · 8 | with skill |
| handoff-capture-method | 4/4 · 2/2 · 9 | 2/4 · 1/2 · 6 | with skill |
| critique-acceptance-verdict | 4/4 · 2/2 · 9 | 4/4 · 2/2 · 7 | with skill |
| critique-rewrite-request | 3/3 · 1/1 · 9 | 0/3 · 1/1 · 4 | with skill |
| team-accent-text | 3/3 · 2/2 · 9 | 3/3 · 2/2 · 6 | with skill |
| team-new-typeface | 4/4 · 2/2 · 8 | 4/4 · 2/2 · 8 | with skill |

Where the skill made the difference: capturing with device-metrics emulation after fonts and
hydration instead of `--window-size`; a pause control under WCAG 2.2.2 for `/live`'s scene, which
the baseline never asked for; writing findings with a severity instead of rewriting a teammate's
CSS; handing copy to the voice owner; and the brand's contrast facts (the baseline got three wrong
on the accent case, among them that `--accent` holds `#E1AD01`).

What the run found wrong with the skill:

1. **Two incident rows were inaccurate.** `references/team.md` said three office changes were
   "declined". #2445 is a revert of #2429; #2489 and #2519 merged and needed a second PR on the
   same lane (#2506, #2541). Corrected; one with-skill answer had repeated the claim.
2. **Controls named by their code names.** One answer listed `/board`'s card buttons by their
   internal action kinds; users see other labels. `references/critique.md` now says to
   name controls and states by what is on screen.
3. **Small errors from reading the repository,** none from the skill's text: a posture called `idle` that
   ADR 316 renamed `active`, a count of live regions, a tint attributed to the wrong rule.

What the run found wrong with the graders: both flagged "the target-size gate covers connected
`/board`" as false, citing the header of `scripts/a11y/target-size-gate.mjs` ("the connected routes
are not measured here"). The header is stale: the same script has a connected phase 2 and CI runs
it with `--connected-only`. The claim was right; the error count above still includes it (one for
each config).

No run 2: the fixes correct facts in the references and add one line; no case's verdict turns on them.
