# 719 — ios-engineer ships as a built-in role skill

- Status: accepted
- Date: 2026-10-22
- Lane: `01M5JT4WQRA27F5Z113BRGX90Q`

## Context

[ADR 586](586-role-skills-method-and-shipping.md) ships a role skill with the CLI only after a recorded blind-graded run, and a team that installs the role receives a blank `references/team.md`. [ADR 713](713-role-equipment-on-every-harness.md) decision 4 left `ios-engineer` unbundled: the skill lived in this repository, and a seat that held the role without the files on disk was told the skill was not a built-in.

The skill's evaluate run and fix re-run are in `.agents/skills/ios-engineer/evals/results.md`. Nick accepted it on 2026-10-22. The `ios` toolkit already ships.

## Problem

A team that runs `musterd role create ios-engineer` gets a role file and no skill. The playbook that passed the method stays in this repository.

## Decision

1. `ios-engineer` joins `BUILTIN_ROLE_SKILLS`. `role create` copies `.agents/skills/ios-engineer/` and replaces `references/team.md` with the blank file from `building-a-role-skill/skeleton/`. The team's own `team.md` stays in this repository.
2. The seeded role file names toolkit `ios`. Its charter is the job for any team. This team's roster file, which names `packages/mobile` and ADR 520 and ADR 676, is not the file the CLI seeds.
3. This reverses only the last sentence of ADR 713 decision 4. Equipping a held role's skill and toolkit is unchanged.

## Consequences

- A new team that creates the role gets the skill and the `ios` toolkit name. Revive's roster file is left as it stands.
- A Workspace that already has `.agents/skills/ios-engineer/` keeps those bytes (ADR 586). Seat creation copies the skill only when that directory is absent.

## Observability & Evaluation

- Traces: none added. Installing the skill is the existing copy, and the command already says when a skill was kept.
- Eval: the dataset is the `ios-engineer` skill directory and the blank `references/team.md` from the method skeleton. The baseline is the 2026-10-22 list, which omitted `ios-engineer`. `packages/cli/src/roster-roles/skills.test.ts` asserts every shipped skill has a seeded role and a recorded `evals/results.md`, and that the shipped team file is the blank one. The seat-provision test asserts a held `ios-engineer` with no skill on disk receives that copy.
- Experiment: none.
- Falsifier: `musterd role create --from ios-engineer` in a fresh roster home leaves `references/team.md` equal to this repository's team file, or omits toolkit `ios`.
