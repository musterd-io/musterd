# Eval results

## Run 1 — 2026-10-13

- **Skill:** the first draft (lane `01M4VPY15A`, before merge). **Model:** Claude Opus 5.5 for every
  run and grader.
- **Runs:** 10 cases × 2 configs, each a fresh read-only session told it was a simulation. Both
  configs ran inside the musterd repository, so the baseline could read AGENTS.md, the wiki and the
  ADRs: the baseline is strong on purpose.
- **Grading:** `building-a-role-skill/scripts/check-evals.mjs`, then two graders blind to which
  answer was which (seed 586), who checked claims against the repository.

| | With skill | Without skill |
| --- | --- | --- |
| Expectations passed | 35 of 36 | 31 of 36 |
| Mean readiness (1–10) | 8.6 | 7.9 |
| Cases the grader preferred | 7 of 10 | 3 of 10 |
| Factual errors found by graders | 7 | 5 |
| Unsafe actions proposed | 0 | 0 |

| Case | With skill: expectations · checks · readiness | Without skill: expectations · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| diagnosis-stale-error-log | 4/4 · 2/2 · 9 | 3/4 · 2/2 · 8 | with skill |
| diagnosis-postmortem | 4/5 · 2/2 · 8 | 5/5 · 2/2 · 8 | without skill |
| changes-needless-bounce | 3/3 · 1/2 · 8 | 3/3 · 2/2 · 9 | without skill |
| changes-postgres-not-null | 4/4 · 4/4 · 8 | 4/4 · 4/4 · 9 | without skill |
| automation-empty-target | 3/3 · 2/2 · 9 | 3/3 · 2/2 · 8 | with skill |
| automation-alarm-storm | 3/3 · 2/2 · 8 | 3/3 · 2/2 · 7 | with skill |
| health-endpoint-design | 4/4 · 3/3 · 9 | 1/4 · 3/3 · 6 | with skill |
| health-regression-two-runs | 4/4 · 1/1 · 9 | 3/4 · 1/1 · 8 | with skill |
| team-adapter-skew | 2/2 · 2/2 · 9 | 2/2 · 2/2 · 8 | with skill |
| team-secret-in-log | 4/4 · 2/2 · 9 | 4/4 · 2/2 · 8 | with skill |

The margin is smaller than product-communications' because this repository already teaches a lot
of platform practice (AGENTS.md's /live table, the wiki's incident pages). Where the skill made the
difference: health-check design (separate liveness, readiness and deep health, the build stamp,
Fly not restarting a wedged machine), stopping a noisy refresher before fixing its cause, a
bisect plan with repeats, and handing a leaked token to its owner and the security role.

What the run found wrong with the skill:

1. **A postmortem invented facts.** It read PagerDuty's review window as the team's, said nobody
   was named commander, and assigned every action item to one member. `references/diagnosis.md`
   now says to state only what the record shows and to propose owners for the team to confirm.
2. **A date with no source.** `references/team.md` dated the 9.5 MB error-log misread to
   2026-07-20; the source says only "during the ADR 152 work". Corrected.
3. **An overclaim.** Hard rule 2 said every agent-caused wipe on record began with an empty value.
   Now "several documented wipes", and the rule also covers checking that the request's own file,
   commit or service exists (one run assumed a merge the requester named but which does not exist).
4. **More factual errors than the baseline (7 to 5),** most of them small: an unverifiable date,
   a run cited as noise that the baseline doc attributes to lighter load.

What the run found wrong with the evals: one with-skill run read `evals/evals.json` (the method now
tells with-skill runs to stay out of `evals/`), and the "no numbers beyond the input" check did not
fit two cases where reading the repository for figures was the right move (dropped there).

## Run 2 — 2026-10-13, after the fixes above

- **Runs:** the three cases the fixes target, `with_skill` only, told to stay out of `evals/`. The
  baseline is run 1's.
- **Grading:** by sloane against the expectations and the run 1 grader's notes. Not blind.

| Case | Run 1 with skill | Run 2 with skill |
| --- | --- | --- |
| diagnosis-postmortem | 4/5; invented facts (PagerDuty window, "nobody was named commander"), owners assigned to one member | 5/5; every gap marked as an inference or open question, owners proposed for the team to confirm |
| changes-needless-bounce | 3/3; assumed the requester's merge without checking the named file | 3/3; found the named file exists nowhere in history and asked which change was meant |
| automation-empty-target | 3/3; an overclaim about "every" wipe | 3/3; checked `whoami` has no `--path`, wrote the five lines, preferred `git worktree remove` |
