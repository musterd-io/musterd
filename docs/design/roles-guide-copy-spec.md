# /docs/roles — UI-copy spec for "Give your agents a role"

**Status:** spec, 2026-10-15. Copy is final; implementation is the designer role's (product UI stays
with the designer; comms supplies the exact strings). Lane `01M4VPY8JV`, the user
guide [ADR 586](../decisions/586-role-skills-method-and-shipping.md) Consequences names. Every claim
below traces to the code or decision cited in §3; nothing on the page claims more than they do.

## 1. What this page is for

A team that has installed musterd and added members wants each member to know its job. ADR 586
ships that two ways: a built-in role arrives with its skill, and a custom role arrives with a
skeleton and the method to build its skill. Nothing outside the repo says so today. The CLI help
for `musterd role` does not mention skills, and `/docs` has two pages (concepts and the spec).

The page is a how-to (Diátaxis): a competent user doing a task, the goal in the title, no theory
beyond what the steps need. It sits under `/docs`, so it is prerendered with no daemon behind it.

## 2. The page

Publish the text between the rules verbatim as `packages/web/content/docs/roles.md`, with a
`DOCS_MANIFEST` entry `{ slug: 'roles', title: null, source: 'packages/web/content/docs/roles.md' }`
after `concepts`. Headings, code blocks and the table are part of the copy.

---

# Give your agents a role

A role is a job your team gives a member. It has three parts: a charter that says what the job is,
a ceiling on what the seat may do, and a skill that says how to do the job well. A member reads its
charter when it joins the team, and its harness lists the skill beside the member's other skills.

You can start from a built-in role or make your own. Run every command here in the checkout that
holds your team's roster, the folder with `.musterd/team.toml`.

## Start from a built-in role

| Role | The job | Ships with a skill |
| --- | --- | --- |
| `designer` | Owns the design surfaces: product UI, the visual system, frontend work | Yes |
| `planner` | Turns a pitch into a plan the team can build, then the goal and its lanes | Yes |
| `platform` | The one seat that touches running infrastructure | Yes |
| `steward` | Keeps the declared record honest: roadmap, decision statuses, doc prose | Yes |
| `observer` | Reads team state for dashboards and digests; holds no lanes, sends no acts | Yes |
| `security` | Owns the team's security evidence: threat models, scans, findings, disclosure | Yes |
| `courier` | Moves team material between the team's machines | Role file only |
| `comms` | Owns the product's voice: messaging, public docs, release notes | Yes |
| `admin` | The team's governance authority, held by a person | Role file only |

A role ships with its skill only when the skill has evals and a recorded run in which answers with
the skill beat answers without it, graded blind. The others carry their role file until theirs do.

Create the role from the built-in, then give it to a member:

```sh
musterd role create designer --from designer
musterd role assign ada designer
```

`role create` writes `.musterd/roles/designer.toml` and copies the skill to
`.agents/skills/designer/`. Commit both. The daemon updates the roster when the commit merges.

Then run `musterd wire` in the member's own folder. It writes the small file each harness needs to
find the skill.

### Tell the skill about your team

A built-in skill is written for any team. The one file it leaves blank is
`.agents/skills/<role>/references/team.md`. Fill it in with what is yours: your systems and where
their state lives, the commands that change them, the decisions the role answers to, and the
incidents behind your local rules. The member reads it before its first piece of work in a session.

### When you already have a copy

`role create` never overwrites a skill folder that differs from the one musterd ships. It keeps
yours and prints the command to compare the two:

```
⚠ kept your .agents/skills/designer — it differs from the one musterd ships; compare: diff -r …
```

## Make your own role

```sh
musterd role create release-manager
```

This writes three things:

- `.musterd/roles/release-manager.toml`, the role file. Write its charter: what the job is, who
  routes work to it, and what it must never do.
- `.agents/skills/release-manager/`, a skeleton of the skill: a `SKILL.md` with its sections to
  fill and an `evals/evals.json` with one example case.
- `.agents/skills/building-a-role-skill/`, the method musterd used to build its own roles.

Then ask an agent on your team to build the skill:

```
Build the release-manager skill with the building-a-role-skill method.
```

The method has eight steps:

1. Read the charter and the sources the role answers to.
2. Research the craft, with every source cited.
3. Look for skills to adapt, pinned and licence-checked.
4. Write a short core and one reference file per craft, with your team's specifics in `team.md`.
5. Write two eval cases per craft and run each one with the skill and without it.
6. Grade the answers blind, then fix the skill and run the cases again.
7. Have a member who holds the role accept it against the job as they do it.
8. Run the evals again when a source changes or a new model family ships.

When the skill is done, assign the role and run `musterd wire`, as for a built-in role.

## Not yet

- The built-in role skills are not yet published on their own for use without musterd. Today
  they ship inside `@musterd/cli`.

---

## 3. Sources for every claim on the page

| Claim | Source |
| --- | --- |
| A role is a charter, a ceiling and a skill | ADR 227 (roles), ADR 586 §1; `building-a-role-skill/SKILL.md` |
| A member reads its charter when it joins | the MCP `team_join` reply ("Your Team Role charter") |
| The nine built-ins and their one-line jobs | `packages/cli/src/roster-roles/templates.ts`, each role's `summary` |
| Which built-ins ship a skill | `BUILTIN_ROLE_SKILLS` in `packages/cli/src/roster-roles/skills.ts` (designer, observer, planner, platform, comms, steward); admin is human-only (ADR 172) |
| The evidence bar for shipping a skill | ADR 586 §6 |
| `role create --from` writes the role file and copies the skill | `packages/cli/src/commands/role.ts` `installRoleSkills` |
| Commit both; the daemon reconciles on merge | the `role create` output ("commit both files — the daemon reconciles the roster on merge", ADR 058) |
| `musterd wire` writes the per-harness bridges | ADR 586 §4; `packages/cli/src/onboard/roleSkills.ts` |
| `team.md` ships blank and carries the team's specifics | ADR 586 §1 (amended 2026-10-13); `shippedSkillFiles` in `skills.ts` |
| An edited copy is kept, with a diff command | `installSkill` and `skillLines` in `skills.ts` and `role.ts` |
| A custom role gets the skeleton and the method | ADR 586 §5; `installRoleSkills` |
| The eight steps | ADR 586 §2; `building-a-role-skill/SKILL.md` |
| Role skills are not published separately yet | ADR 586 §4 says an install line is written only after it has run on each harness; `musterd-io/skills` has no `roles/` folder on 2026-10-15 |

## 4. Notes for the designer

- The table is the page's one dense element. On a phone it scrolls inside its own box; the three
  columns stay.
- The `⚠ kept your …` block is real CLI output. Show it as captured text in a code block.
- Link the page from `/docs/concepts` where it first says "role", if it does.

## 5. Open, and who owns it

- **The README** gets a one-line pointer to `/docs/roles` once the page is live. A pointer to a page
  that 404s helps nobody, so it waits for the designer's lane.
- **ADR 586's experiment** (the time a user team takes from `role create` to a first eval run) is
  recorded against this lane when the first outside team builds a role. No outside team has yet.
