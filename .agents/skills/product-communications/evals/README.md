# Evals for product-communications

Sixteen cases, two per craft, in `evals.json` (the skill-creator format, with one
extra key, `checks`, for the deterministic checks). Inputs live in `files/`. Some
are true musterd facts as of 2026-10-13, and some are marked fictional at the top.
A run compares the skill with a baseline that has no skill.

## Run

1. For each case, run the prompt twice in a clean session: once told to read
   `SKILL.md` first (`with_skill`), once told to stay out of `.agents/skills/`
   (`without_skill`). Save each answer as
   `<workspace>/<case name>/<config>/output.md`. The workspace lives outside the
   repo (a scratchpad).
2. Run the checks:

   ```
   node --disable-warning=ExperimentalWarning .agents/skills/product-communications/evals/check.mjs <workspace>
   ```

   It writes `checks.json` beside each output and `checks-summary.json` at the
   top, and prints a table. Per case, it checks the facts that must survive, the
   patterns that must be absent or present, numbers that appear in no source, and
   word limits. On every output, it counts contrast frames, hype words, dated
   words, the four banned words and dashes per paragraph, and reports them as
   tells per 100 words. Glossary Not-column words are reported and never fail a
   run, because several of them ("session", "user") have legitimate uses.
   All checks read only the answer: a note to the requester below a `---` line
   that starts with "Note" is left out, so a run can flag a fact it chose not to
   add.
3. Grade each case's `expectations` by reading the output (skill-creator's grader
   does this). The checks catch the mechanical part; the expectations catch
   judgment, such as declining to draft a Show HN post.

Record each run in `results.md`: date, the skill's commit, model, both configs'
check pass rates and tells per 100 words, expectation pass rates, and what
changed in the skill as a result.

## Adding a case

Two per craft keeps the run under an hour. A new case needs a prompt a teammate
would actually send, an `expected_output` a reviewer can judge, and at least one
check that fails on a plausible bad answer. Test the check on a bad and a good
output before adding it. Fictional inputs say so in their first line.
