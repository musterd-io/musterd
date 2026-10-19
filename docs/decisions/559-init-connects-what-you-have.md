# 559 — init connects the agents you already have

- Status: accepted
- Date: 2026-10-11
- Deciders: nick (design approved in chat 2026-10-11: one seat per repo; one run reaches every repo,
  suggested from what the harnesses recorded; inside `musterd init`), stanley
- Lane: `01M4FDBVGBW79MYN0HFKT1FNKQ` (Goal `first-run-10-minutes`, "First run 2/3")
- Spec: [`2026-10-11-first-run-connect-design.md`](../superpowers/specs/2026-10-11-first-run-connect-design.md) ·
  Plan: [`2026-10-11-first-run-connect.md`](../superpowers/plans/2026-10-11-first-run-connect.md)
- Builds on: ADR 281 (several harnesses, one seat per
  Workspace), [ADR 491](491-seat-launcher.md) (`provisionAgentSeat`),
  [ADR 176](176-the-team-home.md) (the credential exclusion `.gitignore` block)

## Context

The business plan's lead reason to adopt musterd is "connect the agents you already have", and its
first user is a solo developer running two or more harnesses across one to three repos
([brainstorm](../superpowers/specs/2026-10-09-business-plan-design.md)). The 10-minute unassisted
install test is run against `musterd init`.

`init` already detects all five harnesses and can wire several into one folder. But it leads with
"Add a new agent", asks for a name, a toolkit, a role and a join policy, and reaches exactly one
folder. A person with three repos runs it three times and answers about fifteen questions.

## Problem

What does "connect the agents you already have" produce, and how does one run reach every repo?

## Decision

1. **`init`'s first and default intent is "Connect the agents you already have".** The existing
   intents ("Add a new agent", "Activate an existing member", "Just me") stay, unchanged, below it.
2. **One seat per repo.** Each picked repo becomes one agent member, named after its folder
   (`web`; `web-2` when the name is taken), with every chosen harness wired into it (ADR 281). The
   harness choice is asked once and applies to every repo.
3. **Repos are suggested from what the harnesses recorded.** `onboard/recents.ts` reads, read-only,
   the folders each harness has worked in — Claude Code's and Codex's session `cwd`, Cursor's
   `workspace.json`, Grok's `trusted_folders.toml`, opencode's project files — maps each to its git
   root, drops folders that are gone, temporary, already bound or refused a binding, and offers the
   eight most recent after this folder.
4. **Per repo, the existing sequence:** `provisionAgentSeat({ here: true, gitIdentity: false })`,
   then the AGENTS.md primer. No role, no toolkit, no join question: `provisionSeat` always writes
   `autojoin: true` with a standing grant.
5. **A person's own checkout keeps its author and keeps its key out of git.** `here` mode normally
   sets the folder's git identity to the seat; on this path it does not (`gitIdentity: false`, new on
   `provisionAgentSeat`), because the person commits there. And `.musterd/binding.json`, which holds
   the seat credential, is added to `.gitignore` before provisioning, without asking — the
   non-interactive `excludeCredentialFromGit` that `team export` uses.
6. **A failing repo never stops the others.** Each gets a `✓` / `⚠` / `✗` line; the exit code is 1 if
   any failed.

## Considered and rejected

- **One seat per harness** (Claude Code, Cursor and Codex as three members). Truer to "side by side",
  but it needs a seat-per-harness path that does not exist, and nick chose the repo as the unit.
- **One `init` run per repo.** No new code, but two or three runs inside the 10-minute test.
- **Typed paths only.** Works with no harness records, but asks the person to recall what their
  tools already know. It remains the fallback: with no suggestions the picker shows this folder.
- **A separate `musterd connect` command.** A second front door; the 10-minute test is about `init`.

## Consequences

- The roster grows by one seat per connected repo. `musterd agent` stays the detailed path (role,
  toolkit, a Workspace of its own).
- `recents.ts` depends on five file formats musterd does not own. Each reader returns `[]` on any
  error, so a format change costs suggestions, never the run.
- opencode's record location was not seen on a live install (it was not installed on the machine the
  others were checked on, 2026-10-11).
  _(2026-10-19, lane `01M4PHMBGY6TF7WMTB3S8AX4AB`: checked on a live OpenCode install — OpenCode
  migrated its store to `~/.local/share/opencode/opencode.db` (`project` table: `worktree`,
  `time_active`, `time_updated`, `time_created`, with `storage/migration` = `1` and no
  `storage/project/` directory). `recents.ts` now queries `opencode.db` first via `sqlite3` and
  keeps the `storage/project/*.json` reader as a fallback for pre-SQLite installs.)_
- The connect path ends without the tour offer. init offers the tour (lane `01M4FDBXPX`) only once
  the new agent is online, and this path waits for no agent; alfie owns whether and how it is
  offered here.
  _(2026-10-13, lane 01M4V8SKRR: the connect path now offers it after the summary when at least one
  seat connected and init knows the driver. It does not wait for an agent: the tour's own team step
  waits and says how to start one.)_

## Observability & Evaluation

**Traces.** n/a — this is local, interactive onboarding. It emits no spans of its own. The
provisioning it calls already emits one `musterd.provisioning.operation` span per fragment (ADR 282).

**Baseline.** Before this ADR, connecting three repos took three `init` runs and about fifteen
answers (name, toolkit, role, join policy, wire and primer confirms, per repo).

**Eval.** Unit tests: `recents.test.ts` (each reader against a fixture, the merge, git-root mapping,
the four filters, the cap, corrupt files yield `[]`), `connect.test.ts` (naming, per-repo isolation,
partial wiring, the binding ignored before provisioning, the primer appended), `connect.run.test.ts`
(the prompts' options and defaults, a refused cwd, no repos picked, exit 1 on failure), and the
`init.test.ts` hand-off.

**Experiment.** The 10-minute install test: on a machine with two or more harnesses and two repos,
one `musterd init` run leaves both repos as seats on `/live`, with only three answers (the intent,
the agents, the repos). Falsify: a run that needs a fourth answer, or a connected repo whose
`git status` lists `.musterd/binding.json`.
