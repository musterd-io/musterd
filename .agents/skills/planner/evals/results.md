# Eval results

## Run 1 — 2026-10-13

- **Skill:** the rebuilt draft (lane `01M4VPY6NT`, before merge). **Model:** Claude Opus 5.5 for
  every run and the grader.
- **Runs:** 6 cases × 2 configs. One fresh read-only session per config answered the six cases in
  turn, told it was a simulation (no musterd tools, no network, no git writes); the with-skill
  session was told to read `SKILL.md` first and stay out of `evals/` except the input file a case
  names. Both ran inside the musterd repository.
- **Grading:** `building-a-role-skill/scripts/check-evals.mjs`, then one grader per case blind to
  which answer was which (seed 4417), who checked claims against the repository.

|                            | With skill | Without skill |
| -------------------------- | ---------- | ------------- |
| Expectations passed        | 20 of 22   | 17 of 22      |
| Checks passed              | 16 of 16   | 13 of 16      |
| Cases the grader preferred | 5 of 6     | 1 of 6        |

| Case                      | With skill: expectations · checks | Without skill: expectations · checks | Grader preferred |
| ------------------------- | --------------------------------- | ------------------------------------ | ---------------- |
| shaping-leaderboard-pitch | 3/4 · 2/2                         | 3/4 · 1/2                            | with skill       |
| shaping-clear-pitch       | 2/3 · 2/2                         | 2/3 · 2/2                            | with skill       |
| breakdown-review-draft    | 4/4 · 4/4                         | 3/4 · 3/4                            | with skill       |
| breakdown-too-big         | 3/3 · 2/2                         | 3/3 · 2/2                            | without skill    |
| routing-not-enough-agents | 4/4 · 3/3                         | 2/4 · 2/3                            | with skill       |
| team-lane-open-fields     | 4/4 · 3/3                         | 4/4 · 3/3                            | with skill       |

Where the skill made the difference: the baseline reviewed a layered plan (database, server, web)
without naming the layering and rewrote it still layered; it gave the review lane to a builder and
never said how many agents the plan was short; it jumped from a clear pitch straight to `lane_open`
without an accept; and it rewrote an accepted plan at open time by dropping a lane.

What the run found wrong with the skill:

1. **"Done when" could be skipped.** On the leaderboard pitch the with-skill answer asked about
   scope and appetite and never asked for or proposed a check. Hard rule 1 and
   `references/shaping.md` §2 now say the check is the one question never skipped: ask it, or
   propose one and label it your call.
2. **The team's open-time rules were applied but not stated.** The clear-pitch answer set
   `risk: ["user-facing"]` without saying why the lane needs it. The plan skeleton in `SKILL.md`
   and `references/breakdown.md` §1 gain an `At open:` line naming each rule and its reason, so
   the acceptor can see it.
3. **A rewrite pitch got a decision before a measurement.** Both answers cut the Rust rewrite to
   the appetite, but the grader preferred the baseline's measure-then-decide plan with alternatives
   to Rust. `references/breakdown.md` §3 now says a plan to replace something starts with a lane
   that measures what it replaces, and its decide lane weighs alternatives.

What the run found wrong with the evals: nothing. The grader's one surprising call (the rewrite
case) held up on reading both answers.

Model-family note: every run and every grader was a Claude model. Agreement between them is weak
evidence of model-independence; a run on a second family is upkeep work (method step 8).

## Run 2 — 2026-10-13, after the fixes above

- **Runs:** the three cases the fixes target, `with_skill` only, one fresh read-only session per
  case. The baseline is run 1's. **Model:** Claude Fable 5.1 for the runs and the graders.
- **Grading:** `check-evals.mjs`, then one grader per case blind to which answer was which (seed
  4418), checking claims against the repository and scoring readiness 1–10.

| Case                      | Run 1 with skill | Run 2 with skill: expectations · checks · readiness | Without skill (run 1): expectations · checks · readiness | Grader preferred |
| ------------------------- | ---------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| shaping-leaderboard-pitch | 3/4              | 3/4 · 2/2 · 8                                       | 3/4 · 1/2 · 5                                            | with skill       |
| shaping-clear-pitch       | 2/3              | 2/3 · 2/2 · 6                                       | 3/3 · 2/2 · 8                                            | without skill    |
| breakdown-too-big         | 3/3              | 3/3 · 2/2 · 9                                       | 3/3 · 2/2 · 6                                            | with skill       |

Fix 1 and fix 3 held: the leaderboard answer now proposes a done-when check and the rewrite
answer now measures first and weighs alternatives, and the grader preferred both. Fix 2 did not:

1. **The `At open:` line was read as a question.** The clear-pitch answer turned the rules it must
   state at open into a second ask ("risk and stakes at open"), failing the one-question
   expectation. The line in `SKILL.md` and `references/breakdown.md` now says it is a statement,
   never a question.
2. **`risk: 'none'` as a string.** The same answer passed `risk: 'none'` to `lane_open`, which takes
   an array (`[]` for none); `'none'` is the CLI spelling. `references/team.md` was the source of
   the confusion ("tags, or `none`") and now gives both forms.
3. **A per-member panel offered as the team-level alternative.** The leaderboard answer named the
   rule and routed the ranking to a human, then recommended a "shipped this week" panel listing
   every member with a count, which the grader rightly read as still a ranking.
   `references/team.md`'s product rule now says what a team-level alternative is and that a list
   of members with counts is not one.

Citation precision: the grader found three loose section cites in the leaderboard answer (brand
§5 for a line that is in AGENTS.md; §4 versus §5 of `human-agent-dynamics.md`). Those are the
model's reading of the sources, not text in the skill; noted, no change.

## Run 3 — 2026-10-13, after run 2's fixes

- **Runs:** the two shaping cases, `with_skill` only, one fresh read-only session per case; the
  baseline is run 1's. **Model:** Claude Fable 5.1. **Grading:** as run 2, seed 4419.

| Case                      | Run 3 with skill: expectations · checks · readiness | Without skill (run 1): expectations · checks · readiness | Grader preferred |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| shaping-leaderboard-pitch | 3/4 · 2/2 · 6                                       | 3/4 · 1/2 · 7                                            | without skill    |
| shaping-clear-pitch       | 2/3 · 2/2 · 6                                       | 2/3 · 2/2 · 7                                            | without skill    |

Run 2's fixes held (the `At open:` line was stated, `risk` was an array, the alternative was at
goal level, done-when was proposed) and both answers lost anyway, to the same fault: the skill
run asks too much. On the settled pitch it asked two questions; on the phone pitch it posted
three questions and a five-lane plan in one message. The grader called it a wall a pitcher on a
phone answers none of. Hard rule 1 said "two to four questions", which the model read as a quota,
and "one at a time" without saying what that means for a message.

Fix: hard rule 1 and `references/shaping.md` §2 now say a pitch that settles everything gets no
question, at most four otherwise, and one message carries one question and waits for the reply.

## Run 4 — 2026-10-13, after run 3's fix

- **Runs:** the two shaping cases, `with_skill` only, one fresh read-only session per case; the
  baseline is run 1's. **Model:** Claude Fable 5.1. **Grading:** as run 2, seed 4420.

| Case                      | Run 4 with skill: expectations · checks · readiness | Without skill (run 1): expectations · checks · readiness | Grader preferred |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| shaping-leaderboard-pitch | 4/4 · 2/2 · 8                                       | 3/4 · 1/2 · 5                                            | with skill       |
| shaping-clear-pitch       | 3/3 · 2/2 · 8                                       | 2/3 · 2/2 · 6                                            | with skill       |

The fix held. The settled pitch got no question and a one-lane plan with an accept gate; the
phone pitch got one question now with a recommended answer, the second held back for the reply,
the ranking routed to a human on the team's own rule, and a done-when check proposed.

What this run found wrong with the skill: the clear-pitch answer declared a goal for a one-lane
plan and cited ADR 487 for it; the ADR makes a goal of a plan with more than one increment.
`references/team.md` now says a one-step plan is one lane and needs no goal. The grader also
found two loose cites in the leaderboard answer (an ADR 147 section number, and one question
bundling two things); the first is the model's reading, the second is worth watching in upkeep.

Final totals after four runs, with-skill results taken from each case's latest run: planner
expectations 22 of 22 against the baseline's 17 of 22; every case preferred with the skill.

## Run 5 — 2026-10-15, the skill as a new team receives it (blank `references/team.md`)

- **Why:** every earlier run used our filled `references/team.md`. `musterd role` ships the skill
  with the method's blank skeleton in its place (`shippedSkillFiles`), so no run had measured
  what a new team gets. Lane `01M50SZECV`.
- **Skill:** `3e61063f5` (unchanged on main since), copied as it ships: `evals/` left out,
  `references/team.md` replaced by `building-a-role-skill/skeleton/references/team.md`. **Model:** Claude Opus 5.5 for
  every run and grader.
- **Runs:** 6 cases × 2 configs. One fresh read-only session per config answered every case, in a
  scratch git repository outside musterd that held only a one-paragraph README ("this team
  coordinates with musterd") and the case input files; with-skill runs also had the shipped skill.
  Both were told to read nothing outside that folder, use no web and change nothing.
- **Grading:** `check-evals.mjs`, then one grader blind to which answer was which (seed 20261015),
  checking facts against the input files only.
- **Team expectations, pre-registered:** before any run, the expectations that only our filled
  team file can satisfy were listed: `shaping-clear-pitch` #3; `team-lane-open-fields` #1. They are scored but kept out of the craft
  totals below.
- **Caveats:** both configs inherited this workspace's `AGENTS.md`, which names some of musterd's
  own operations (the auto-refresher, the runtime checkout), so the baseline knew more than a
  stranger would; it helped both configs equally. With-skill answers often said "team.md is an
  unfilled template", which tells a grader which answer had the skill. Grader errors charged for
  team facts (a blank team file truthfully records no rule) are removed from the counts below.

| | With skill | Without skill |
| --- | --- | --- |
| Craft expectations passed | 19 of 20 | 14 of 20 |
| Team expectations passed | 0 of 2 | 0 of 2 |
| Checks passed | 15 of 16 | 8 of 16 |
| Mean readiness (1–10) | 6.5 | 5.8 |
| Cases the grader preferred | 4 of 6 | 2 of 6 |
| Factual errors found by the grader | 1 | 0 |

| Case | With skill: craft (+team) · checks · readiness | Without skill: craft (+team) · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| shaping-leaderboard-pitch | 3/4 · 2/2 · 4 | 3/4 · 0/2 · 6 | without skill |
| shaping-clear-pitch | 2/2 (+0/1) · 2/2 · 7 | 1/2 (+0/1) · 1/2 · 6 | with skill |
| breakdown-review-draft | 4/4 · 4/4 · 8 | 3/4 · 2/4 · 6 | with skill |
| breakdown-too-big | 3/3 · 2/2 · 7 | 2/3 · 2/2 · 7 | with skill |
| routing-not-enough-agents | 4/4 · 3/3 · 8 | 2/4 · 2/3 · 5 | with skill |
| team-lane-open-fields | 3/3 (+0/1) · 2/3 · 5 | 3/3 (+0/1) · 1/3 · 5 | without skill |

**Verdict (ADR 586 §6, as shipped):** with the blank team file the skill beat no skill, graded blind
(craft 19/20 vs 14/20; preferred 4 to 2). It stays a built-in.

Where the skill made the difference: one question at a time with a recommended answer, waiting
for an accept before opening anything, slicing layers into end-to-end lanes, a human decide lane
before a hard-to-undo choice, and saying how many more agents a plan needs.

Where it lost, and this is the finding that matters: `shaping-leaderboard-pitch`. With a blank
team file the skill run recommended ranking members by lanes shipped as its default. The rule
against it ("Never a leaderboard of Members"; a pitch that ranks people is a decide lane) lives only
in our `references/team.md`, so the shipped skill does not carry it. In `team-lane-open-fields`
and `shaping-clear-pitch` the skill run also read the blank team file as "no rules apply at open"
rather than "the rules are not recorded here". Both are fixes for the core, not for the team file.

## Run 6 — 2026-10-15, after the blank-team fixes (lane `01M50TPMMA`)

- **Fix:** hard rule 9 (a plan never ranks people) moved into the core from `team.md`, and the plan
  template's "At open" line says a blank team file means "not recorded", never "none". The
  method's skeleton `team.md` now says the same for every role.
- **Runs:** the three cases that lost in the run above, `with_skill` only, set up the same way (scratch
  repository, shipped form with the blank `team.md`, Opus 5.5, read-only). The baseline is that
  run's `without_skill` answers, unchanged.
- **Grading:** one grader blind to which answer was which (seed 20261016), against the same
  expectations.

| Case | Before: craft (+team) · readiness · preferred | After: craft (+team) · readiness · preferred |
| --- | --- | --- |
| shaping-leaderboard-pitch | 3/4 · 4 · without skill | 4/4 · 8 · with skill |
| shaping-clear-pitch | 2/2 (+0/1) · 7 · with skill | 2/2 (+1/1) · 8 · with skill |
| team-lane-open-fields | 3/3 (+0/1) · 5 · without skill | 3/3 (+1/1) · 8 · with skill |

The leaderboard pitch now becomes a decide lane with a goal-level alternative, in one question.
Both lane-open cases propose risk on the user-facing surface and label it a proposal. The grader
again charged "team.md records no rule" as an error on two answers; with the blank file it is
true, so those are not counted. One error stands: `team-lane-open-fields` uses unchecked field
names (it says so).
