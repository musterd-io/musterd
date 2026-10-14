# This team: musterd (revive)

The only file in this skill that names musterd's specifics. Read before the first run in a
session. A team adopting this skill replaces this file with its own.

## The role here

- **Role file**: `steward` in the team home: "Keeps the declared record honest — roadmap truth,
  ADR statuses, doc prose". Unheld: it runs as a scheduled GitHub Action, not a resident seat.
- **Operating charter**: `scripts/steward/CHARTER.md`, the prompt the CI run gets (ADR 112). It is
  the source for what a run may do; this skill is the craft behind it.
- **Acceptor of this skill**: no seat has held the role, so a human.

## Where the record lives

| Record | Home | Rendering and checks |
| --- | --- | --- |
| Roadmap | `content/roadmap.data.ts` (ADR 041) | `ROADMAP.md` between the generated markers, made by `pnpm roadmap:gen`; never hand-edit it. `roadmap:check` (generated file matches), `roadmap-truth:check` (shipped items cite a merged PR; a `building:` field exempts accepted-but-unshipped items) |
| Decisions | `docs/decisions/NNN-*.md` | `docs/architecture/07-conventions.md` §ADRs and `docs/wiki/amending-an-adr.md`: an accepted `## Decision` is frozen; later facts go in `## Consequences`; dated `_(Amended YYYY-MM-DD: …)_` markers only. Checked by `change-adr:check`, `adr-numbers:check`, `obs-evals:check`, `intents:check` (ADR 373, 487) |
| Architecture docs | `docs/architecture/00–07` | File trees are checked by `arch-trees:check` (ADR 043) |
| Wiki | `docs/wiki/` | `wiki:check`; claim markers `<!-- claim: … -->` and `ledger:check` (ADR 505) |

All but `change-adr:check` run in `pnpm format:check`. `scripts/adr-status.ts` is the permissive
status parser; prefer it over ad hoc parsing.

## How the steward runs here

- `.github/workflows/steward.yml`: Mondays 08:00 UTC and on demand. A scan job runs
  `pnpm steward:scan` (finders `reverse_drift`, `unmarked_feature`, `stale_prose`; tasks
  `roadmap-reconcile`, `undeclared-work`, `stale-prose`, all propose-only). An agent job runs the
  charter with a maximum of 40 turns.
- The charter limits edits to `content/roadmap.data.ts`, `ROADMAP.md` and `docs/`, one draft PR
  per task on `steward/<task>`, never a merge, and the trailer
  `Co-authored-by: steward <steward@musterd>`.
- ADR 112 also describes auto-merge tasks and an ADR-status task; neither was built. ADR 131
  reserves a move to a resident seat; it has not happened.

## What past runs taught

| Date | What happened | What it taught |
| --- | --- | --- |
| 2026-07-09 | The first run's stale-prose PR (#184) on a planted fixture | The loop works end to end |
| 2026-08-03 | A roadmap-reconcile PR (#592) correctly declined to mark an item shipped and flagged that the scanner ignores `building:`; closed on 2026-09-15 because main had already changed the item | Unknown beats a guess (hard rule 2); close a change the main branch overtakes |
| 2026-08-24 | A one-line stale-prose fix (#1009) merged | The smallest change is the one that lands |
| 2026-08 to 2026-10 | Most weekly runs failed: 40-turn limit reached, then a checkout failure after the repository moved to `musterd-io` (2026-10-12). The 2026-10-12 scan reported 96 findings, 91 of them undeclared-work | A noisy finder exhausts the run (`references/drift.md` §4); a failed run must reach a person |
