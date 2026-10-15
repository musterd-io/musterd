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
2. **A held figure in the Show HN pack.** It cleared the cookoff multiplier, which
   `docs/wiki/how-musterd-got-here.md` holds out of outbound copy until its re-run lands.
   The grader also marked "musterd.io carries the same install" as false under ADR 565
   §5; that was the grader's error, since ADR 568 put the install on the site on
   2026-10-12. The skill run had it right.
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

## Run 2 — 2026-10-13, after lane `01M4VH098C`

- **Skill:** the increment 5 change, with the four fixes from run 1, read from its branch before merge.
- **Runs:** only the three cases the fixes target, `with_skill` only, Opus 5.5. The
  baseline is unchanged from run 1.
- **Grading:** `check.mjs`, then the expectations graded by sloane against the outputs.
  This grading was not blind.

| Case | Run 1 with skill | Run 2 with skill | What changed |
| --- | --- | --- | --- |
| prose-deslop-announcement | 5/5 expectations, 12/13 checks (added the deck's port) | 5/5, 13/13 | The post adds no fact. Suggestions, and the newer counts, go in a note below it |
| docs-diataxis-audit | 4/5 (said to delete the ADR 106 rationale) | 5/5, 5/5 | Links ADR 106 and moves the two points ADR 106 lacks, after checking it |
| launch-show-hn | 4/4, with a held figure listed as usable | 4/4, 3/3 | Lists the cookoff numbers under "Held. Don't use" and cites the hold |

Run 2 also turned up drift for other owners. ADR 550 §4 still quotes the held cookoff
pair ("65–83% → under 11%") as its proof line. That ADR's Decision is frozen, and the
next amendment to it should mark the hold.

The checker now reads only the answer: a note to the requester below a `---` line that
starts with "Note" is left out. Run 1's totals are the same under this rule.

## Run 3 — 2026-10-15, after lane `01M4VTQ66X` (team specifics moved to `references/team.md`)

- **Skill:** the split, read from its branch before merge. `SKILL.md` and the craft references
  no longer name musterd's sources; they point at `references/team.md`, which now holds them, the
  chart palette and the approved examples (`references/examples.md` is gone).
- **Runs:** the three cases that depend most on what moved, `with_skill` only, Opus 5.5, each in a
  fresh read-only session. The baseline is unchanged from run 1.
- **Grading:** `check.mjs`, then the expectations, graded by dolly. This grading was not blind.
  The Show HN and chart answers were shortened by hand before the checks ran (the pack's middle
  sections and the SVG's style block trimmed); the checked strings were kept.

| Case | Checks | Expectations | What the split had to keep |
| --- | --- | --- | --- |
| launch-show-hn | 3/3 | 4/4 | Found the holds in `team.md`: no post, a source pack for nick, the cookoff multiplier under "Keep out" |
| charts-brand-bar | 8/8 | 5/5 | Took `#B8860B` for light marks and `#E1AD01` for dark from `team.md`'s palette table |
| fundraising-traction-answer | 1/1 | 3/3 | Found the ledger and `counts.sh` through `team.md`; no invented users; dated counts |

Tells per 100 words: 0.12 mean. Each prompt said to open every source the core names, so this run
shows the pointers resolve; it does not show a session finds `team.md` unprompted.
