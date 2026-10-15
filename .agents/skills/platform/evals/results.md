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

## Run 3 — 2026-10-15, the skill as a new team receives it (blank `references/team.md`)

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
  team file can satisfy were listed: `changes-needless-bounce` #2, #3; `team-adapter-skew` #2. They are scored but kept out of the craft
  totals below.
- **Caveats:** both configs inherited this workspace's `AGENTS.md`, which names some of musterd's
  own operations (the auto-refresher, the runtime checkout), so the baseline knew more than a
  stranger would; it helped both configs equally. With-skill answers often said "team.md is an
  unfilled template", which tells a grader which answer had the skill. Grader errors charged for
  team facts (a blank team file truthfully records no rule) are removed from the counts below.

| | With skill | Without skill |
| --- | --- | --- |
| Craft expectations passed | 33 of 33 | 28 of 33 |
| Team expectations passed | 1 of 3 | 1 of 3 |
| Checks passed | 19 of 22 | 19 of 22 |
| Mean readiness (1–10) | 8.3 | 7.4 |
| Cases the grader preferred | 6 of 10 | 3 of 10 (1 tie) |
| Factual errors found by the grader | 0 | 3 |

| Case | With skill: craft (+team) · checks · readiness | Without skill: craft (+team) · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| diagnosis-stale-error-log | 4/4 · 2/2 · 9 | 4/4 · 2/2 · 9 | tie |
| diagnosis-postmortem | 5/5 · 2/2 · 8 | 4/5 · 2/2 · 7 | with skill |
| changes-needless-bounce | 1/1 (+1/2) · 0/2 · 6 | 1/1 (+1/2) · 0/2 · 6 | without skill |
| changes-postgres-not-null | 4/4 · 4/4 · 9 | 4/4 · 4/4 · 8 | with skill |
| automation-empty-target | 3/3 · 2/2 · 9 | 3/3 · 2/2 · 9 | without skill |
| automation-alarm-storm | 3/3 · 2/2 · 9 | 2/3 · 2/2 · 7 | with skill |
| health-endpoint-design | 4/4 · 3/3 · 9 | 2/4 · 3/3 · 6 | with skill |
| health-regression-two-runs | 4/4 · 1/1 · 9 | 4/4 · 1/1 · 8 | with skill |
| team-adapter-skew | 1/1 (+0/1) · 1/2 · 6 | 1/1 (+0/1) · 1/2 · 6 | without skill |
| team-secret-in-log | 4/4 · 2/2 · 9 | 3/4 · 2/2 · 8 | with skill |

**Verdict (ADR 586 §6, as shipped):** with the blank team file the skill beat no skill, graded blind
(craft 33/33 vs 28/33; preferred 6 to 3). It stays a built-in.

Where the skill made the difference: a blameless postmortem that marks inferences as inferences
(the baseline named a person and stated three things the notes do not say), notify-once-then-
escalate for the alarm storm, the Fly fact that a failed check does not restart a machine with a
private deep check, and routing the leaked token's rotation to its owner.

Ties and narrow losses were on cases both configs already passed (`automation-empty-target`,
`diagnosis-stale-error-log`). The two team cases (`changes-needless-bounce`,
`team-adapter-skew`) depend on how our web bundle and adapter are deployed; both configs missed
them equally.
