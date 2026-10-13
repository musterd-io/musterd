---
name: building-a-role-skill
description: How to build or rebuild the skill a musterd role carries, by one measured method — read the charter and sources, research the craft, survey upstream skills under a licence check, write a lean core with references, evaluate with and without the skill graded blind, fix and re-run, and have a holder of the role accept it. Use when creating a custom role's skill, rebuilding an existing one, or deciding whether a role's skill is good enough to ship.
---

# Building a role skill

A role is a responsibility your team grants a member: a charter, a ceiling, and a skill that
says how to do the job. This skill is the method for writing that skill so the member holding the
role does the job better with it than without it, and you can show the run that says so.

It is the method musterd used for its own roles (ADR 586). Every step works in any repository
with a `.agents/skills/` folder.

## What you are building

`.agents/skills/<skill>/`:

| Part | What it holds | Read |
| --- | --- | --- |
| `SKILL.md` | The core: frontmatter `name` and `description`, the sources the role defers to, the charter boundary, hard rules each with its reason, the checks that catch most mistakes, a routing table to the references, a definition of done. About 200 lines at most. | Always |
| `references/` | One file per craft the role practices, each with its procedure, its rules and the sources behind them. | When the routing table points there |
| `evals/` | `evals.json` (cases), the inputs they name, a check script where one fits, `results.md` (every run). | When you change the skill |
| `PROVENANCE.md`, `LICENSES/` | Every outside source adapted: repo, pinned commit, licence, what was taken. | When you adapt anything |

`skeleton/` beside this file has a starting `SKILL.md` and `evals/`. `musterd role create <name>`
copies it for a new role.

## The method

Do the steps in order. Each step has a reference with the detail.

1. **Charter and sources.** Read the role file (`roles/<name>.toml`: summary, capabilities,
   charter) and every document the role answers to: the team's decisions, its brand or style
   guide, its glossary. The skill points at these and never restates them, so they stay the one
   source of truth.
2. **Research the craft.** Split the craft into its parts (for a designer: interaction, visual
   system, accessibility, handoff). Send read-only researchers, one per part, and merge their notes
   into one report with every source cited (`references/research.md`).
3. **Survey upstream skills.** Find published skills and rule sets for the same craft. Pin each by
   commit, check its licence, and check its lineage when it credits a source with a stricter
   licence (`references/upstreams.md`).
4. **Rebuild.** Write the core and the references from the research, the sources and what upstream
   does well, in your team's voice. Adapt; never copy a file wholesale. Every rule carries its
   reason; every claim carries its source.
5. **Evaluate.** Write two cases per craft. Run each in a fresh session twice, once told to read the
   skill and once kept away from it. Grade the answers blind against written expectations, and run
   the checks (`references/evals.md`).
6. **Fix and re-run.** Fix what the run found wrong in the skill, then re-run the cases it touched.
   Fix what it found wrong in the evals too, and write both down in `results.md`.
7. **Acceptance.** A member who holds the role, and did not write the skill, judges whether it is
   the job as they do it. On musterd, that is the lane's acceptance (`lane_submit`). With no
   holder, a human on the team accepts.
8. **Upkeep.** Run the evals again when an upstream pin moves, when the decisions the role answers
   to change, or when a new model family arrives.

## Hard rules

1. **The skill defers to the team's sources.** If the skill and a decision record disagree, the
   decision wins and the skill has a bug. A skill that restates policy becomes a second policy.
2. **Nothing invented.** No made-up users, quotes, numbers or capabilities, in the skill or in its
   eval inputs. A fictional eval input says so in its first line.
3. **Licences first.** Adapt only from licences your team accepts (musterd's list is in ADR 579:
   MIT, Apache-2.0, BSD, ISC, 0BSD, CC0, CC BY). Share-alike, copyleft, non-commercial and
   unlicensed sources are for reading and citing only.
4. **Blind grading.** The grader never knows which answer had the skill. A grader who knows will
   find what they expect.
5. **A run beats an opinion.** The skill is good when the run says so. Record every run, including
   the ones that went badly and the grader's own mistakes.
6. **Write work stays with the member who owns the lane.** Researchers and graders read and report;
   they never edit the repository.

## Routing

| You are | Open |
| --- | --- |
| Planning the research or merging researchers' notes | `references/research.md` |
| Looking for upstream skills, or checking a licence or lineage | `references/upstreams.md` |
| Writing cases, running them, grading, recording results | `references/evals.md` |
| Starting a new role's skill | `skeleton/` |

## Definition of done

- [ ] Steps 1–7 done, in order
- [ ] `SKILL.md` under about 200 lines; every craft has a reference; every reference is routed
- [ ] Every adapted source in `PROVENANCE.md`, its licence in `LICENSES/`
- [ ] `evals/results.md` records a blind-graded run where the skill beats the baseline, and the
      re-run after fixes
- [ ] On musterd's own repository: `pnpm skills:check` passes
- [ ] A holder of the role accepted it
