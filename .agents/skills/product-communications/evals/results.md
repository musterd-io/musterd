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

## Run 4 — 2026-10-15, the skill as a new team receives it (blank `references/team.md`)

- **Why:** every earlier run used our filled `references/team.md`. `musterd role` ships the skill
  with the method's blank skeleton in its place (`shippedSkillFiles`), so no run had measured
  what a new team gets. Lane `01M50SZECV`.
- **Skill:** `3e61063f5` (unchanged on main since), copied as it ships: `evals/` left out,
  `references/team.md` replaced by `building-a-role-skill/skeleton/references/team.md`. **Model:** Claude Opus 5.5 for
  every run and grader.
- **Runs:** 16 cases × 2 configs. One fresh read-only session per config answered every case, in a
  scratch git repository outside musterd that held only a one-paragraph README ("this team
  coordinates with musterd") and the case input files; with-skill runs also had the shipped skill.
  Both were told to read nothing outside that folder, use no web and change nothing.
- **Grading:** `check-evals.mjs`, then one grader blind to which answer was which (seed 20261015),
  checking facts against the input files only.
- **Team expectations, pre-registered:** before any run, the expectations that only our filled
  team file can satisfy were listed: `launch-show-hn` #3; `positioning-new-tagline` #2; `positioning-battlecard` #3; `research-personas-with-quotes` #2; `charts-brand-bar` #2. They are scored but kept out of the craft
  totals below.
- **Caveats:** both configs inherited this workspace's `AGENTS.md`, which names some of musterd's
  own operations (the auto-refresher, the runtime checkout), so the baseline knew more than a
  stranger would; it helped both configs equally. With-skill answers often said "team.md is an
  unfilled template", which tells a grader which answer had the skill.

| | With skill | Without skill |
| --- | --- | --- |
| Craft expectations passed | 52 of 60 | 44 of 60 |
| Team expectations passed | 3 of 5 | 0 of 5 |
| Checks passed | 72 of 77 | 62 of 77 |
| Mean readiness (1–10) | 6.6 | 6.3 |
| Cases the grader preferred | 11 of 16 | 5 of 16 |
| Factual errors found by the grader | 1 | 0 |

| Case | With skill: craft (+team) · checks · readiness | Without skill: craft (+team) · checks · readiness | Grader preferred |
| --- | --- | --- | --- |
| prose-deslop-announcement | 5/5 · 13/13 · 6 | 5/5 · 13/13 · 9 | without skill |
| prose-readme-edit | 4/4 · 17/17 · 7 | 4/4 · 17/17 · 9 | without skill |
| docs-changelog-from-prs | 4/4 · 7/7 · 8 | 4/4 · 7/7 · 8 | with skill |
| docs-diataxis-audit | 5/5 · 5/5 · 8 | 2/5 · 3/5 · 6 | with skill |
| launch-show-hn | 3/3 (+1/1) · 2/3 · 8 | 0/3 (+0/1) · 0/3 · 2 | with skill |
| launch-weekly-digest | 5/5 · 1/1 · 8 | 3/5 · 1/1 · 6 | with skill |
| launch-press-release-no-news | 3/3 · 3/3 · 9 | 3/3 · 3/3 · 8 | with skill |
| positioning-new-tagline | 3/3 (+0/1) · 1/2 · 7 | 2/3 (+0/1) · 0/2 · 5 | with skill |
| positioning-battlecard | 3/3 (+1/1) · 3/3 · 5 | 1/3 (+0/1) · 0/3 · 4 | with skill |
| research-synthesis | 4/4 · 6/6 · 9 | 4/4 · 5/6 · 8 | with skill |
| research-personas-with-quotes | 2/2 (+1/1) · 1/1 · 8 | 2/2 (+0/1) · 0/1 · 8 | with skill |
| charts-brand-bar | 0/4 (+0/1) · 7/8 · 2 | 3/4 (+0/1) · 8/8 · 5 | without skill |
| charts-latency-distribution | 2/4 · 2/2 · 3 | 4/4 · 2/2 · 6 | without skill |
| fundraising-investor-update | 3/4 · 3/3 · 5 | 2/4 · 3/3 · 5 | with skill |
| fundraising-traction-answer | 3/3 · 0/1 · 4 | 3/3 · 0/1 · 5 | without skill |
| uxcopy-cli-daemon-unreachable | 3/4 · 1/2 · 8 | 2/4 · 0/2 · 7 | with skill |

**Verdict (ADR 586 §6, as shipped):** with the blank team file the skill beat no skill, graded blind
(craft 52/60 vs 44/60; preferred 11 to 5). It stays a built-in.

Where the skill made the difference: no ready-to-paste Show HN post (the baseline wrote one), a
Diátaxis audit that classifies the page and checks ADR 106 before linking it, the increment marked
as an increment, a battlecard with `as_of`, `source_url` and `review_by` and nothing about
CrewAI from memory, and k-of-n with no percentage.

Where it lost:
- `charts-brand-bar` and `charts-latency-distribution`. The skill run made no chart at all: the
  charts reference says to compute coordinates in code and render and look, the session could not
  run code, and the blank team file has no palette, so it handed back a plan. The baseline computed
  both charts correctly and flagged the fictional data. A read-only session should still deliver
  the computed SVG, marked unrendered, rather than nothing. The read-only instruction in this run
  made this worse than a normal session would.
- `prose-deslop-announcement`, `prose-readme-edit`: equal on expectations, lower on readiness,
  because the skill run appended a note to a request that said "return only the post".
- `fundraising-traction-answer`: all placeholders, where the baseline kept our dated usage line.
