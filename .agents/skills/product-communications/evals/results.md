# Eval results

## Run 1 — 2026-10-13

- **Skill:** `46993bdb` (increment 2, PR #2497). **Model:** Claude Opus 5.5 for every
  run and every grader. **Lane:** `01M4V98H46`.
- **Runs:** 16 cases × 2 configs, each a fresh subagent. `with_skill` was told to read
  SKILL.md first. `without_skill` was told to stay out of `.agents/skills/`. Both ran in
  this repo, so both could read brand.md, the ledger and the ADRs.
- **Grading:** `check.mjs` for the checks. Four graders, each blind to which answer was
  which (A and B assigned at random), graded the expectations. They also scored
  readiness from 1 to 10 and listed factual errors after checking claims against the
  repo and, for CrewAI, its own site.

| | With skill | Without skill |
| --- | --- | --- |
| Expectations passed | 62 of 65 | 45 of 65 |
| Checks passed | 76 of 77 | 68 of 77 |
| Mean readiness (1–10) | 7.9 | 6.1 |
| Factual errors found by graders | 5 | 22 |
| Tells per 100 words (mean) | 0.16 | 0.37 |
| Cases the grader preferred | 15 of 16 | 1 of 16 |

| Case | With skill: expectations / checks / quality | Without skill: expectations / checks / quality | Grader preferred |
| --- | --- | --- | --- |
| prose-deslop-announcement | 5/5 · 12/13 · 8 | 5/5 · 13/13 · 7 | with skill |
| prose-readme-edit | 4/4 · 17/17 · 7 | 4/4 · 17/17 · 8 | without skill |
| docs-changelog-from-prs | 4/4 · 7/7 · 8 | 4/4 · 7/7 · 7 | with skill |
| docs-diataxis-audit | 4/5 · 5/5 · 8 | 4/5 · 5/5 · 7 | with skill |
| launch-show-hn | 4/4 · 3/3 · 8 | 1/4 · 1/3 · 3 | with skill |
| launch-weekly-digest | 5/5 · 1/1 · 8 | 2/5 · 1/1 · 6 | with skill |
| launch-press-release-no-news | 3/3 · 3/3 · 8 | 3/3 · 3/3 · 7 | with skill |
| positioning-new-tagline | 4/4 · 2/2 · 8 | 4/4 · 1/2 · 7 | with skill |
| positioning-battlecard | 4/4 · 3/3 · 8 | 1/4 · 0/3 · 6 | with skill |
| research-synthesis | 4/4 · 6/6 · 8 | 3/4 · 5/6 · 5 | with skill |
| research-personas-with-quotes | 3/3 · 1/1 · 9 | 2/3 · 1/1 · 5 | with skill |
| charts-brand-bar | 5/5 · 8/8 · 8 | 3/5 · 8/8 · 6 | with skill |
| charts-latency-distribution | 4/4 · 2/2 · 8 | 3/4 · 2/2 · 7 | with skill |
| fundraising-investor-update | 3/4 · 3/3 · 8 | 2/4 · 2/3 · 6 | with skill |
| fundraising-traction-answer | 2/3 · 1/1 · 7 | 2/3 · 1/1 · 4 | with skill |
| uxcopy-cli-daemon-unreachable | 4/4 · 2/2 · 8 | 2/4 · 1/2 · 6 | with skill |

Where the skill made the difference: the Show HN case (it wrote a source pack and cited
HN's rule; the baseline wrote the post in nick's voice), the battlecard (dated, sourced
fields; the baseline asserted CrewAI gaps its pages never state), research (k of n,
noticed the notes were fictional, refused a public headline; the baseline invented
named personas), the weekly digest ("You can now" lines, increment 1 marked, a
now-wrong check), and the traction answer (ran `counts.sh`; the baseline repeated a
private-preview status that ADR 568 ended).

What the run found wrong with the skill (lane `01M4VH098C`):

1. **Edits add facts.** Asked to rewrite a draft, the skill run added true facts from the
   repo (the deck's port, how the ledger works). `prose.md` forbids it; the run did not
   follow it. The baseline did the same.
2. **Stale public claims in the Show HN pack.** It said musterd.io carries the install
   (ADR 565 §5 says not restored) and cleared the cookoff figures that the wiki holds out
   of outbound copy.
3. **The ledger lags.** Slide 7's ledger row says 1,704 lanes and 1,714 asks;
   `counts.sh` read 1,732 and 1,764–1,765 the same day. The skill run noticed and said so.
4. **An audit dropped content.** The Diátaxis audit said to delete the ADR 106 rationale
   and link the ADR, where the reference says to move it to an explanation page.

What the run found wrong with the evals, fixed before this record: a GHSA ID read as a
number; "I have not sent it" matched the "sent it" check; "What went badly" is a
lowlights section under another name; the no-new-numbers check was dropped for the
chart and digest cases, whose job includes computing or citing figures; the word limit
now counts only the answer above a `---` line. Expectations stricter than the skill:
the investor-update case requires ledger rows, while hard rule 4 also accepts the doc a
number came from. Read that row with that in mind.

n is one run per config per case. Differences of one expectation in a single case are
noise; the totals and the error counts are the signal.
