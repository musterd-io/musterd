# 699 — The built-in product-communications role is renamed comms

- Status: accepted
- Date: 2026-10-21

## Context

A Twitch viewer asked "can you show their occupations", and the office nameplates now show each
seat's first role by its roster name (#3120, #3125), worn as a tag with the role's glyph (#3133).
nick ruled out a viewer-facing word map on 2026-10-21: the plate says what the roster says, and a
role whose name reads badly on a plate is renamed in the roster instead.

`product-communications` is a built-in role (ADR 586): a role file in
`packages/cli/src/roster-roles/templates.ts`, a shipped skill at `.agents/skills/<name>/`, and an
entry in `BUILTIN_ROLE_SKILLS`. On revive, sloane and alfie hold it.

## Problem

At 22 characters, `product-communications` is the longest role name in the library by far, and on a
plate it adds about 120 px to a floor tuned for twenty seats. Any team that takes the built-in has the
same problem, so renaming only revive's roster would leave every other team with it.

## Decision

The built-in is renamed `comms`. sloane proposed comms / voice / herald and alfie voice / writer /
editor; nick picked `comms`, what the team already calls the role aloud.

- The built-in role file, the `BUILTIN_ROLE_SKILLS` entry and the canonical skill directory
  (`.agents/skills/comms/`) take the new name.
- `product-communications` stays an alias for `musterd role create --from`
  (`ROLE_TEMPLATE_ALIASES`), so old instructions and muscle memory still build the role, as `comms`.
- A team that already holds `product-communications` keeps it. Its role file and installed skill
  are its own and are not migrated. The nameplate glyph recognises both names.
- revive renames its roster role and moves sloane and alfie onto `comms`.
- Living docs take the new name. Accepted ADRs, dated plans, research records and eval logs keep
  the old one as history.

## Consequences

- Plates for the role read "Comms" with the megaphone glyph.
- Workspaces provisioned with a `product-communications` bridge (`.claude/skills/…`,
  `.cursor/rules/….mdc`) point at a skill directory that no longer exists. They need
  `musterd init` to re-bridge onto `comms`; sloane and alfie are told on merge.
- The alias is permanent and costs one map entry. Dropping it later would be its own decision.

## Observability & Evaluation

n/a — a rename of a built-in role. No agent behaviour changes: the skill's content is the same
file under a new directory, and `pnpm skills:check` still checks it.
