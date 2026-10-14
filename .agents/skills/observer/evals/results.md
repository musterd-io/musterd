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
