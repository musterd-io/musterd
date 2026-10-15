# Evals: show the skill helps, and find where it does not

Open for steps 5, 6 and 8 of the method. The format is skill-creator's (`evals/evals.json`); the
blind grading and the checks are this method's additions.

## Write the cases

Two per craft. Each case in `evals/evals.json`:

```json
{
  "id": 1,
  "name": "short-kebab-name",
  "craft": "which reference it exercises",
  "prompt": "The request, worded the way a teammate would send it.",
  "expected_output": "What a good answer does, in a sentence or two a reviewer can judge.",
  "files": ["evals/files/<input>"],
  "expectations": ["One verifiable statement per line", "…"],
  "checks": { "keeps": [], "absent": [], "present_any": [], "present_all": [] }
}
```

- **Mix the kinds.** Half the cases should be work the role does every week. The rest should be
  traps: a request the role must decline or reshape (draft a post a forum bans, invent testimonials,
  ship a change the role does not own).
- **Expectations are checkable by someone else.** "Keeps PR #2466 and 1,704" is checkable; "reads
  well" is not.
- **Inputs are true, or say they are fictional** in their first line.
- **A check fits the task.** "No numbers beyond the input" suits an edit; it does not suit a task
  where reading the repository for more figures is the right move.
- **Checks are deterministic**: strings that must survive, patterns that must not appear, numbers
  with no source. Test each check on a bad answer and a good one before you trust it. A model's
  note to the requester under a `---` line starting "Note" is not part of the answer.

musterd's `product-communications/evals/check.mjs` is a working example of a check script.

## Run them

Each case runs twice, each time in a fresh session that shares nothing with yours:

- **with the skill**: told to read `.agents/skills/<skill>/SKILL.md` first and follow it, and to
  stay out of the skill's `evals/` folder apart from the input files the task names. The cases'
  expectations live there, and a run that reads them is graded on a test it has seen.
- **without**: told to stay out of `.agents/skills/` apart from the input files.

Both may read the rest of the repository; that is the real baseline. Both are read-only and write
their answer to a file outside the repository. Run them in parallel, within your harness's limit
on concurrent sessions.

### A skill that other teams will install

Your runs used your own `references/team.md`. Another team gets the blank one, so run every case
once more the way they will meet it: in a scratch repository that is not yours, holding only the
input files, with the skill copied as it ships (blank `team.md`, no `evals/`) against no skill.
Before that run, list the expectations only your filled team file can satisfy; score them apart.
A team fact the core relies on shows up here as a loss, and the fix is to move the general rule
into the core. musterd's built-ins ran this on 2026-10-15: the planner had kept "never rank
members" only in its team file, and recommended a leaderboard without it.

## Grade them blind

1. For each case, assign the two answers to A and B at random, with a fixed seed so it can be
   reproduced, and keep the key away from the graders.
2. A grader (a fresh, read-only session) gets the case, A and B, and the team's sources. For each
   answer it marks every expectation passed or failed with a quoted line as evidence. It also lists
   factual errors, checked against the repository, and scores readiness 1–10. Then it says which
   answer is better.
3. Unblind, then add up the totals for each configuration: expectations passed, checks passed,
   readiness, factual errors, cases preferred.

## Read the results honestly

- **Graders make mistakes.** Check any surprising call against the source before you act on it,
  and record the correction.
- **Checks make mistakes too.** An ID read as a number, a refusal read as an action. Fix the check,
  re-score every run, and say so.
- **Find the gaps.** Where the skill run lost or tied, the skill has a gap. Each one becomes a fix,
  and the case that found it is re-run (step 6).
- **One run per case is noise at the level of one expectation.** Trust the totals and the error
  counts.

## Record every run in `evals/results.md`

Date, the skill's commit, the model, the run method, the totals table, a row per case, what the run
found wrong with the skill, what it found wrong with the evals, and what changed. The second run
after fixes gets its own section. A run its own author graded says so.
