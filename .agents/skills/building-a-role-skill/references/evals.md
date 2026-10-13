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
- **Checks are deterministic**: strings that must survive, patterns that must not appear, numbers
  with no source. Test each check on a bad answer and a good one before you trust it. A model's
  note to the requester under a `---` line starting "Note" is not part of the answer.

musterd's `product-communications/evals/check.mjs` is a working example of a check script.

## Run them

Each case runs twice, each time in a fresh session that shares nothing with yours:

- **with the skill**: told to read `.agents/skills/<skill>/SKILL.md` first and follow it.
- **without**: told to stay out of `.agents/skills/` apart from the input files.

Both may read the rest of the repository; that is the real baseline. Both are read-only and write
their answer to a file outside the repository. Run them in parallel, within your harness's limit
on concurrent sessions.

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
