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

## Run 2 — 2026-10-15, the skill as a new team receives it (blank `references/team.md`)

- **Why:** every earlier run used our filled `references/team.md`. `musterd role` ships the skill
  with the method's blank skeleton in its place (`shippedSkillFiles`), so no run had measured
  what a new team gets. Lane `01M50SZECV`.
- **Skill:** `3e61063f5` (unchanged on main since), copied as it ships: `evals/` left out,
  `references/team.md` replaced by `building-a-role-skill/skeleton/references/team.md`. **Model:** Claude Opus 5.5 for
  every run and grader.
- **Runs:** 10 cases × 2 configs. One fresh read-only session per config answered every case, in a
  scratch git repository outside musterd that held only a one-paragraph README ("this team
  coordinates with musterd") and the case input files; with-skill runs also had the shipped skill.
  Both were told to read nothing outside that folder, use no web and change nothing.
- **Grading:** `check-evals.mjs`, then one grader blind to which answer was which (seed 20261015),
  checking facts against the input files only.
- **Team expectations, pre-registered:** before any run, the expectations that only our filled
  team file can satisfy were listed: `visual-tells-review` #5; `visual-cli-color` #4; `team-accent-text` #2; `team-new-typeface` #1, #2, #3. They are scored but kept out of the craft
  totals below.
- **Caveats:** both configs inherited this workspace's `AGENTS.md`, which names some of musterd's
  own operations (the auto-refresher, the runtime checkout), so the baseline knew more than a
  stranger would; it helped both configs equally. With-skill answers often said "team.md is an
  unfilled template", which tells a grader which answer had the skill.

| | With skill | Without skill |
| --- | --- | --- |
| Craft expectations passed | 31 of 32 | 24 of 32 |
| Team expectations passed | 0 of 6 | 0 of 6 |
| Checks passed | 18 of 22 | 16 of 22 |
| Mean readiness (1–10) | 7.3 | 6.4 |
| Cases the grader preferred | 7 of 10 | 2 of 10 (1 tie) |
| Factual errors found by the grader | 0 | 1 |

| Case | With skill: craft (+team) · checks · readiness | Without skill: craft (+team) · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| visual-tells-review | 4/4 (+0/1) · 4/4 · 7 | 3/4 (+0/1) · 4/4 · 7 | with skill |
| visual-cli-color | 3/3 (+0/1) · 1/2 · 7 | 2/3 (+0/1) · 1/2 · 6 | with skill |
| a11y-live-scene | 4/4 · 3/3 · 8 | 3/4 · 2/3 · 6 | with skill |
| a11y-board-drag | 3/3 · 2/2 · 8 | 2/3 · 2/2 · 6 | with skill |
| handoff-stale-banner-spec | 4/4 · 2/2 · 8 | 2/4 · 2/2 · 6 | with skill |
| handoff-capture-method | 4/4 · 2/2 · 8 | 4/4 · 2/2 · 8 | without skill |
| critique-acceptance-verdict | 4/4 · 2/2 · 9 | 4/4 · 2/2 · 8 | with skill |
| critique-rewrite-request | 3/3 · 1/1 · 8 | 2/3 · 0/1 · 6 | with skill |
| team-accent-text | 2/2 (+0/1) · 0/2 · 6 | 2/2 (+0/1) · 1/2 · 7 | without skill |
| team-new-typeface | 0/1 (+0/3) · 1/2 · 4 | 0/1 (+0/3) · 0/2 · 4 | tie |

**Verdict (ADR 586 §6, as shipped):** with the blank team file the skill beat no skill, graded blind
(craft 31/32 vs 24/32; preferred 7 to 2). It stays a built-in.

Where the skill made the difference with a blank team file: the 2.2.2 pause control for the
live scene, target size on the board, a spec that names tokens and leaves strings to the voice
owner, findings with a severity, and routing the copy rather than rewriting it.

Where it lost: `team-accent-text`. Both answers said `#E1AD01` fails on white; the baseline then
proposed a concrete darker shade, while the skill run said team.md records none and stopped. With
a blank team file the skill should still propose a value that passes, labelled as a proposal.
`team-new-typeface` tied at nothing: its expectations are almost all team facts.

## Run 3 — 2026-10-15, after the blank-team fixes (lane `01M50TPMMA`)

- **Fix:** hard rule 4 says that when the team has not recorded an ink shade for the accent, the
  designer computes one of the same hue that passes and labels it a proposed token.
- **Runs:** the one case that lost in the run above, `with_skill` only, set up the same way (scratch
  repository, shipped form with the blank `team.md`, Opus 5.5, read-only). The baseline is that
  run's `without_skill` answers, unchanged.
- **Grading:** one grader blind to which answer was which (seed 20261016), against the same
  expectations.

| Case | Before: craft (+team) · readiness · preferred | After: craft (+team) · readiness · preferred |
| --- | --- | --- |
| team-accent-text | 2/2 (+0/1) · 6 · without skill | 2/2 (+0/1) · 8 · with skill |

It now proposes `#8A6B01` at 5.0:1 (the grader recomputed 5.02) as a token, keeps `#E1AD01` for
fills, and keeps links underlined. The brand's own `mustard-900` is a team fact it cannot know.
