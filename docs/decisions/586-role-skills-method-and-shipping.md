# 586 — Role skills: what one is, how it is built, and how it ships

- Status: accepted (2026-10-13, sloane). nick chose two of its decisions in session the same day:
  decision 4's two ways of shipping ("a hybrid/both") and decision 7's builder ("Sloane drafts,
  holder accepts").
- Date: 2026-10-13
- Lane: `01M4VPXEQQ5HJZTAXWDBJXFPR5` (goal `role-skills`)
- Settles: the distribution question [ADR 299](299-committed-skill-home-and-vendoring.md) left open
  ("a registry or marketplace", "auto-distribution of bridges by `musterd init`"), for role skills.
- Relates to: [ADR 070](070-v0.3-p1-seats-data-model.md) (roles in git), [ADR 227](227-roles-as-the-aptitude-layer.md)
  (roles as the aptitude layer), [ADR 298](298-role-create-authors-the-role-library.md) (`role
  create`), [ADR 513](513-role-gated-routes.md) (role-gated routes name the role's skill),
  [ADR 538](538-public-repos-in-musterd-io.md) (`musterd-io/skills`), [ADR 579](579-writing-tooling-and-licences.md)
  (writing tools and the licence table)

## Context

nick, 2026-10-13, after the product-communications skill was rebuilt (goal `comms-skill-v2`, PRs
#2481, #2497, #2498, #2503, #2508, #2518): do the same for every other role, and make the method
the way musterd builds more out-of-the-box roles and the way a user builds their own.

Where things stand, read from the repo on 2026-10-13:

- **A role** is `roles/<name>.toml` in the roster home: `summary`, `capabilities`, `charter`
  (`packages/protocol/src/seatfile.ts`, `RoleFileSchema`). It has no field for a skill.
- **A role skill** is `.agents/skills/<role>/SKILL.md` by naming convention only (AGENTS.md; the
  ADR 513 gate message builds the path from the role name). Five exist: product-communications
  (rebuilt: a 153-line core, nine references, evals, provenance), designer (68 lines), planner (71),
  courier (87) and security (38). The platform, steward and observer roles have none.
- **Nothing ships them.** `musterd init` writes only the musterd skills. `role create --from`
  writes the role file from the built-ins in `packages/cli/src/roster-roles/templates.ts` (admin,
  platform, designer, steward, planner, observer, product-communications), and the designer and
  planner charters there say "the full playbook is the … skill", a skill a user's repo does not have.
- **`musterd-io/skills`** is public, installable with `npx skills add musterd-io/skills`, and holds
  twenty practice skills. It has no sync from this repo: three of its skills are not here, so the
  two copies have already drifted.

## Problem

A role is only as useful as what the member holding it knows how to do. Today that knowledge is
uneven (38 lines for security, 1,300 for product-communications), untested for every role but one,
missing for three roles, and absent from every team outside this one. The one method that produced
a measured skill is written down only in one goal's lanes, where no seat or user would look for it.

## Decision

### 1. A role skill has one shape

`.agents/skills/<skill>/` holds:

- **`SKILL.md`, the core**, always read: frontmatter `name` and `description`, the sources the role
  defers to (never restating them), the charter boundary, a short list of hard rules each with its
  reason, operational checks, a routing table to the references, and a definition of done. About
  200 lines at most.
- **`references/`**, one file per craft the role practices, opened through the routing table.
- **`evals/`**: `evals.json` in skill-creator's format, the inputs it names, a deterministic check
  where one fits, and `results.md` recording every run.
- **`PROVENANCE.md` and `LICENSES/`** when anything is adapted from outside, under ADR 579's licence
  table.
  _(Amended 2026-10-13: a team's specifics live in one file, `references/team.md`, so the rest of a
  built-in role's skill ships unchanged. See Consequences, 2026-10-13.)_

The skill points at the repo's authoritative sources (ADRs, design docs, the glossary) and never
becomes a competing one (ADR 299).

### 2. One method builds every role skill

1. **Charter and sources.** Read the role file and the docs the role answers to.
2. **Research.** Read-only researchers survey the craft (practice, standards, failure modes) into
   one report with every source cited.
3. **Upstream survey.** Find adoptable skills and rule sets; pin each by SHA; check its licence
   against ADR 579 and its lineage when it credits a reference-only source.
4. **Rebuild.** Write the core and the references in musterd's voice, from the research and the
   repo's sources, adapting upstream material and never copying it wholesale.
5. **Evaluate.** Two cases per craft, each run with the skill and without it in fresh sessions; the
   answers are graded blind (A and B at random) against written expectations, plus the checks.
6. **Fix and re-run.** What the run found wrong in the skill is fixed, and the targeted cases run
   again. What it found wrong in the evals is fixed and recorded.
7. **Acceptance.** A seat that holds the role, and did not write the skill, judges whether it is the
   job as they do it. With no holder, nick accepts. (For this goal's seven roles sloane drafts each
   one; that is decision 7 below.)
8. **Upkeep.** The evals run again when an upstream pin moves, the role's ADRs change, or a new
   model family ships.

The method itself is a skill, `.agents/skills/building-a-role-skill/`, written for a user's team as
much as for ours (lane `01M4VPXMER`). `pnpm skills:check` holds every role skill to the shape in
decision 1. Follows-up: 01M4VPXMER1MDXVPT7N7881JJZ

### 3. A role names its skill

`RoleFileSchema` gains an optional `skill`: the directory name under `.agents/skills/`. Absent, it
defaults to the role's name, which is today's convention, so every existing role file stays valid.
Reconcile warns when a role names a skill the repo does not have. _(Amended 2026-10-14: the CLI warns, not reconcile. See
Consequences, 2026-10-14.)_ The ADR 513 gate message reads
the field. This is the protocol change AGENTS.md hard rule 1 requires an ADR for.
Follows-up: 01M4VPXR1XZ4BG30SFPEC9RQ9R

### 4. Built-in role skills ship two ways from one source

This repo's `.agents/skills/` is the only place a role skill is edited.

- **In the CLI.** `@musterd/cli` bundles the skill of every built-in role. `musterd role create
  --from <role>` writes the role file and copies the skill into the user's
  `.agents/skills/<role>/` when it is not there; it never overwrites a copy the user has edited,
  and says how to compare. `musterd init` and `musterd wire` write the thin per-harness bridges
  (ADR 299) for the roles each seat holds.
- **In `musterd-io/skills`.** A publish script copies each built-in role skill to `roles/<role>/`
  in that repo at a recorded commit of this one, for anyone who wants a role's skill without
  musterd. Nobody edits the published copy by hand. An install line for it is written only after it
  has been run on each harness it names.

Follows-up: 01M4VPXR1XZ4BG30SFPEC9RQ9R

### 5. A custom role gets the same start

`musterd role create <name>` without `--from` writes the role file and a skill skeleton: a
`SKILL.md` with the decision 1 sections to fill, an `evals/evals.json` with one example case, and
a pointer to the method skill, which ships in the CLI with the built-in roles. A user's agent can
then build the skill by the same method we use.

### 6. A built-in role ships only with its evidence

A role joins the built-ins only with a skill that has evals and a recorded run in which the answers
with the skill beat the answers without it, graded blind. A built-in whose skill has no such run
carries its role file only, and its charter does not promise a playbook.

### 7. For the roles that exist today, sloane drafts and a holder accepts

sloane runs the method on each existing role, which proves it on seven roles before a user meets
it. The holder judges the landed skill against the job as they do it.

## Consequences

- Seven role skills are built or rebuilt by the method, each drafted by sloane and accepted by a
  holder: platform, designer, security, courier, planner, steward, observer (lanes `01M4VPY15A`,
  `01M4VPY2D5`, `01M4VPY3M7`, `01M4VPY4VC`, `01M4VPY6NT`). Admin is held by a human and gets no
  skill. Follows-up: 01M4VPY15AT1YNJRT8CHGGWYZW
- Until lane `01M4VPXR1X` lands, the designer and planner charters in `templates.ts` promise a
  playbook a user's repo does not have; decision 6 says they stop promising it unless the skill
  ships.
- A user guide, "give your agents a role", covers picking a built-in role and building your own
  (lane `01M4VPY8JV`). Follows-up: 01M4VPY8JVR3ZSSCD5X6W586YA
- The practice skills in `musterd-io/skills` keep their current arrangement; this ADR does not
  reconcile their drift. Whoever next edits one there or here records which copy is the source.

- _(2026-10-13, lane `01M4VPY15A`, the platform skill.)_ Building the first role skill for an
  existing role showed decision 1 needed one more part. A built-in role's skill ships to teams whose
  systems, commands and history are not ours, so everything specific to a team goes in one file,
  `references/team.md`, and the core and the other references are written for any team. Our own
  `team.md` stays in this repository; a team that installs the role gets the blank one from
  `building-a-role-skill/skeleton/`. The product-communications skill predates this and names our
  brand sources throughout; it is a team-specific skill until it is split the same way.

- _(2026-10-14, lane `01M4VPXR1X`, nick chose the placement.)_ **The missing-skill warning moves
  to the CLI.** Reconcile reads the roster home, and the roster home need not be the code repo: on
  this team it is `~/musterd/revive`, outside every seat's checkout, so a check there would look for
  `.agents/skills/` in the wrong place. `musterd init`, `musterd wire` and `musterd doctor` run in
  the repo and say when a role the seat holds names a skill the repo lacks (lane `01M4W7HTD2`). The
  field itself, its projection into `roles.skill` (migration v96) and the gate message's use of it
  landed as decided.
  Follows-up: 01M4W7HTD27HQ7Q7H98JWWGGXN

- _(2026-10-15, lane `01M50GZPJ6`.)_ **product-communications now ships.** Its brand sources moved to
  `references/team.md` (#2657), and eval run 1 (2026-10-13) was graded blind (four graders, A and B
  assigned at random), so decision 6's bar is met; `BUILTIN_ROLE_SKILLS` lists it. Runs 2 and 3 were
  graded by the author and are not blind; they do not count toward the bar.

## Observability & Evaluation

- **Traces:** none new. `role create` and `init` already report what they write; the copied skill
  is listed with the role file.
- **Eval:** each role skill's `evals/results.md`, with the with-skill and without-skill numbers from
  a blind grading. Decision 6 makes that run the bar for shipping.
- **Experiment:** the first custom role a user team builds with the method is the test of decision
  5; its time from `role create` to a first eval run is recorded in the user guide's lane.
