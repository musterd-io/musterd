# Writing the plan and slicing it

Open to write the plan and break it into lanes.

## 1. The plan, readable in a minute

```
<What, for whom, in one sentence.>
Goal: <the outcome as a check>
Lanes:
  1. <title> — <agent | human> — done when <check> [after <lane>]
  2. …
Decisions for humans: <each, as its own decide lane, before the lanes that depend on it>
Out: <what this leaves out>
At open: <the team's rules these lanes meet when opened, each with its reason; stated, not asked>
My calls: <small decisions you made, and the defaults you used for unanswered questions>
Reply accept to start, or tell me what to change.
```

Before posting, check it for the common failures: it restates the pitch instead of deciding
anything; a line says "to be decided"; a decision is buried inside a build lane; a lane has no
"done when"; an estimate is written as a promise; two lanes touch the same files.

## 2. Slices, not layers

- **Each lane is a vertical slice**: a thin piece of the outcome that works end to end, rather
  than "the database part" and "the UI part" that only work together. (Shape Up's "scopes";
  INVEST for each unit: independent, valuable, small, testable.)
- **The right size** is the smallest unit with its own check that a reviewer could accept while
  sending back its neighbour (after obra/superpowers `writing-plans`, MIT).
- **For agents, smaller is safer.** Published results fall off sharply with task length: on
  SWE-bench Verified, agents solve most tasks a person would do in under an hour and about half
  of those that take one to four hours (2026 analysis, cited). Passing tests is not the same as
  mergeable: METR found agent PRs that passed every test but needed human rework before merging.
- **A lane an agent can start cold** carries its goal, the context it needs (files, decisions,
  links), its constraints, and "done when" as something it can run.

## 3. Order

- The first lane is often the skeleton the others build on; the rest name it in what they depend
  on.
- Lanes that touch different files and depend on nothing can run at once; say so.
- A decide lane comes before every build lane that depends on its answer. A decision that is
  hard to undo is never inside a build lane.
- A plan to replace or rewrite something starts with a lane that measures what it replaces, and
  its decide lane weighs alternatives, not one option. Deciding before measuring is how a
  rewrite becomes the plan instead of the question.
- Work the plan defers is a lane too, opened with why it waits, so nothing vanishes. Shelving it
  is a human's call where the team says so (`references/team.md`).
