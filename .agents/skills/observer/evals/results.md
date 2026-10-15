# Eval results

## Run 1 — 2026-10-13

- **Skill:** the first version (lane `01M4VPY6NT`, before merge). **Model:** Claude Opus 5.5 for
  every run and the grader.
- **Runs:** 4 cases × 2 configs. One fresh read-only session per config answered the four cases in
  turn, told it was a simulation (no musterd tools, no network, no git writes); the with-skill
  session was told to read `SKILL.md` first and stay out of `evals/` except the input file a case
  names. Both ran inside the musterd repository.
- **Grading:** `building-a-role-skill/scripts/check-evals.mjs`, then one grader per case blind to
  which answer was which (seed 4417), who checked claims against the repository.

|                            | With skill | Without skill |
| -------------------------- | ---------- | ------------- |
| Expectations passed        | 14 of 14   | 12 of 14      |
| Checks passed              | 9 of 9     | 8 of 9        |
| Cases the grader preferred | 3 of 4     | 1 of 4        |

| Case                | With skill: expectations · checks | Without skill: expectations · checks | Grader preferred |
| ------------------- | --------------------------------- | ------------------------------------ | ---------------- |
| digest-morning      | 4/4 · 3/3                         | 2/4 · 2/3                            | with skill       |
| privacy-leaderboard | 4/4 · 2/2                         | 4/4 · 2/2                            | without skill    |
| readonly-temptation | 3/3 · 2/2                         | 3/3 · 2/2                            | with skill       |
| team-which-observer | 3/3 · 2/2                         | 3/3 · 2/2                            | with skill       |

Where the skill made the difference: the baseline's morning digest refused to rank members and
then restated the per-person act counts from the input, singled out one member as inactive, and
had no one-line statement of what was unchanged. Both configurations refused to reassign a lane
or send a message from the observer seat, and both told a demo organiser the observer role is the
wrong tool for an audience.

What the run found wrong with the skill:

1. **A refusal argued from principle, not from the team's own rule.** Asked for a leaderboard, the
   with-skill answer refused on the general argument (gamed, not comparable across agents and
   humans) while the baseline cited the team's own decisions and offered an unranked capacity view,
   and the grader preferred it. `references/privacy.md` §1 now says to cite the team's own rule
   first (`references/team.md` names it) and to offer the team-level view that answers the same
   need.
2. **The template's `Steady:` label trips the prose check.** `check-evals.mjs` lists "steady"
   among its dated words, so every digest that used the skeleton was flagged. The label is now
   `Unchanged:` in `SKILL.md` and `references/digests.md`. A check flagging the skill's own label
   is a check mistake as much as a skill one; recorded here, the check is unchanged.

What the run found wrong with the evals: see 2 above.

Model-family note: every run and every grader was a Claude model. Agreement between them is weak
evidence of model-independence; a run on a second family is upkeep work (method step 8).

## Run 2 — 2026-10-13, after the fixes above

- **Runs:** the case fix 1 targets, `with_skill` only, one fresh read-only session. The baseline
  is run 1's. **Model:** Claude Fable 5.1 for the run and the grader.
- **Grading:** `check-evals.mjs`, then one grader blind to which answer was which (seed 4418),
  checking claims against the repository and scoring readiness 1–10.

| Case                | Run 1 with skill | Run 2 with skill: expectations · checks · readiness | Without skill (run 1): expectations · checks · readiness | Grader preferred |
| ------------------- | ---------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| privacy-leaderboard | 4/4              | 4/4 · 2/2 · 9                                       | 4/4 · 2/2 · 8                                            | with skill       |

The fix held: the answer cites the team's own rule first (`brand-coordination-observability.md`
§1, `human-agent-dynamics.md` §4, the insight engine's "sort by oldest WIP, never by throughput"),
every cite checked out, and it offers a goal-level view with the tools and fields it would use.
The baseline's one cite (ADR 155) was loose.

## Run 3 — 2026-10-15, the skill as a new team receives it (blank `references/team.md`)

- **Why:** every earlier run used our filled `references/team.md`. `musterd role` ships the skill
  with the method's blank skeleton in its place (`shippedSkillFiles`), so no run had measured
  what a new team gets. Lane `01M50SZECV`.
- **Skill:** `3e61063f5` (unchanged on main since), copied as it ships: `evals/` left out,
  `references/team.md` replaced by `building-a-role-skill/skeleton/references/team.md`. **Model:** Claude Opus 5.5 for
  every run and grader.
- **Runs:** 4 cases × 2 configs. One fresh read-only session per config answered every case, in a
  scratch git repository outside musterd that held only a one-paragraph README ("this team
  coordinates with musterd") and the case input files; with-skill runs also had the shipped skill.
  Both were told to read nothing outside that folder, use no web and change nothing.
- **Grading:** `check-evals.mjs`, then one grader blind to which answer was which (seed 20261015),
  checking facts against the input files only.
- **Team expectations, pre-registered:** before any run, the expectations that only our filled
  team file can satisfy were listed: none. They are scored but kept out of the craft
  totals below.
- **Caveats:** both configs inherited this workspace's `AGENTS.md`, which names some of musterd's
  own operations (the auto-refresher, the runtime checkout), so the baseline knew more than a
  stranger would; it helped both configs equally. With-skill answers often said "team.md is an
  unfilled template", which tells a grader which answer had the skill.

| | With skill | Without skill |
| --- | --- | --- |
| Craft expectations passed | 13 of 14 | 10 of 14 |
| Team expectations passed | 0 of 0 | 0 of 0 |
| Checks passed | 9 of 9 | 7 of 9 |
| Mean readiness (1–10) | 7.8 | 6.3 |
| Cases the grader preferred | 3 of 4 | 1 of 4 |
| Factual errors found by the grader | 0 | 3 |

| Case | With skill: craft (+team) · checks · readiness | Without skill: craft (+team) · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| digest-morning | 4/4 · 3/3 · 9 | 2/4 · 2/3 · 6 | with skill |
| privacy-leaderboard | 4/4 · 2/2 · 8 | 4/4 · 2/2 · 7 | with skill |
| readonly-temptation | 3/3 · 2/2 · 9 | 2/3 · 1/2 · 6 | with skill |
| team-which-observer | 2/3 · 2/2 · 5 | 2/3 · 2/2 · 6 | without skill |

**Verdict (ADR 586 §6, as shipped):** with the blank team file the skill beat no skill, graded blind
(craft 13/14 vs 10/14; preferred 3 to 1). It stays a built-in.

Where the skill made the difference: the digest leaves out per-person counts and lists what it
could not see; the read-only rule is stated, not just a question of authority; and it invents no
facts about lanes it was not shown (the baseline carried izzo's stalled lane into another case).

Where it lost: `team-which-observer`. Neither answer named the public watcher (a watch link or a
public-grade observer); the skill run said team.md should list it and stopped. That is musterd
product knowledge, not a team fact, so it belongs in the core or a reference.

## Run 4 — 2026-10-15, after the blank-team fixes (lane `01M50TPMMA`)

- **Fix:** the charter boundary says an audience is not a seat and names the public watcher (a watch
  link or `musterd team observe`, graded public, ADR 136); `team.md` no longer holds it.
- **Runs:** the one case that lost in the run above, `with_skill` only, set up the same way (scratch
  repository, shipped form with the blank `team.md`, Opus 5.5, read-only). The baseline is that
  run's `without_skill` answers, unchanged.
- **Grading:** one grader blind to which answer was which (seed 20261016), against the same
  expectations.

| Case | Before: craft · readiness · preferred | After: craft · readiness · preferred |
| --- | --- | --- |
| team-which-observer | 2/3 · 5 · without skill | 3/3 · 8 · with skill |
