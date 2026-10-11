# Bring existing work in — design

**Status:** design approved in chat 2026-10-10 (nick, dolly); written spec awaiting review. Lane
`01M4FDBSN8JKWV6GJQ7C3VB888` (First run 1/3). Goal: `first-run-10-minutes`. Context:
[business plan](2026-10-09-business-plan-design.md) §"First 10 minutes and retention".

## What nick asked for (2026-10-10)

In a new team's first 10 minutes, the team wants its existing work on the board as goals and lanes, or
help planning new work. Today no path imports work from outside musterd: the README quickstart ends at
"agent online", not at "your work is on a board" (gap 1 in the business plan).

Sources nick named: a scan of the repo itself; GitHub issues, Linear, Jira and Notion; a way to create
goals and lanes at the start; and a spreadsheet that a person fills in and imports. He asked for **two
steps**: first import and preview, then save.

**Success:** on a real repo with an existing backlog, a fresh team gets lanes for its real work in one
session, and a stranger goes from install to their own work on the board in 10 minutes with nick watching
but not helping.

## Shape

One file format is the hub. Every source produces it, and one command imports it:

```
repo scan ─┐
GitHub ────┤                      musterd import <file>        musterd import save <id>
Linear …  ─┼─► import file ─────► check + preview + stage ───► goals, then lanes
a person ──┘   (CSV or JSONL)     (.musterd/imports/<id>.json)  (existing endpoints)
```

- **The CLI half** (`musterd import`) parses, checks against the live board, previews, stages, and saves.
  It knows nothing about any source.
- **The agent half** (the `musterd-import` skill) reads a source and writes the file. It uses access the
  agent already has (`gh`, or a harness connector for Linear, Jira or Notion), so musterd holds no
  tracker credentials and adds no runtime dependency.

Save uses `POST /teams/:slug/goals` (`DeclareGoalSchema`) and `POST /teams/:slug/lanes`
(`OpenLaneSchema`) as they are today. **No protocol change and no ADR** for phase 1.

## The import file

Two encodings, one row model:

- **CSV**, so the file opens in any spreadsheet app. The repo has no CSV parser; the CLI gets a small
  RFC 4180 reader (quoted fields, commas and newlines inside quotes, `""` escapes, a header row) instead
  of a new dependency.
- **JSONL**, one object per line with the same keys, for agents.

One table; the `kind` column says what each row is:

| column       | goal row                                     | lane row                                                     | maps to                        |
| ------------ | -------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| `kind`       | `goal`                                       | `lane`                                                       | —                              |
| `key`        | required; becomes the goal id (a slug)       | optional; lets other rows point at this lane                 | goal `id` / local only         |
| `title`      | required                                     | required                                                     | `title`                        |
| `detail`     | —                                            | optional                                                     | `detail`                       |
| `story`      | optional, ≤140 chars                         | —                                                            | `story`                        |
| `goal`       | —                                            | a goal `key` in this file, or an existing goal id            | `goal_id`                      |
| `depends_on` | goal keys or existing goal ids, `;`-separated | lane keys or existing lane ids, `;`-separated                | `depends_on`                   |
| `stakes`     | —                                            | `low` / `normal` / `high`                                    | `stakes`                       |
| `source_ref` | optional                                     | optional (e.g. `github#123`, `LIN-42`)                       | a `Source:` line in `detail`   |

- `project` is derived from the repo, as `lane open` derives it (`resolveProject`).
- **Deliberately absent:** owner and claim (imported lanes open unclaimed; seats pick them up through
  `team_next`); `scope`, `risk`, `branch`, `role` (decisions for whoever claims the lane — a human-visible
  scope owes a risk declaration, and an import must not guess one).

## Step 1 — `musterd import <file>`

Reads the file, checks it against the live board (goals and open lanes), prints the preview, and writes
the stage `.musterd/imports/<id>.json`. Creates nothing on the board.

The stage records: the parsed rows, the source file path and its sha256, the team, the time, the
diagnostics, and an empty `created` map (row → real id).

**Errors** (block save):

- a missing `kind`, `title`, or goal `key`; an unknown `kind`;
- a duplicate `key` in the file;
- a `goal` or `depends_on` that resolves to nothing in the file or on the board;
- a dependency cycle (among goals, or among lanes);
- an invalid `stakes`; a `story` over 140 characters; a goal `key` that is not a valid goal id.

**Warnings** (do not block):

- a goal `key` that already exists on the board — its lanes link to it, and **the goal is not
  re-declared**: a re-declaration amends the goal (latest wins, `store/goals.ts`), which would overwrite
  its title and story;
- a lane title that closely matches an open lane on the board (a likely duplicate);
- an unknown column;
- a lane with no goal.

The preview groups lanes under their goals, shows each lane's dependencies, then the diagnostics, then
one next step: `musterd import save <id>`, or `fix N errors and re-run`.

The server does not check that `depends_on` ids exist (`store/lanes.ts` stores them as given), so this
check is the only one.

## Step 2 — `musterd import save <id>`

- **Refuses** when the stage has errors, is already saved, is older than 24 hours, or names a different
  team than the one this workspace resolves to. Each refusal says to re-run step 1.
- **Order:** goals first, then lanes in topological order of `depends_on`, so every dependency has a real
  id before the lane that needs it opens. Keys resolve to real ids as rows are created.
- **Resumable:** after each create, the new id is written into the stage's `created` map at once (an
  atomic write, as `onboard/atomicWrite.ts` does). A save that stops partway — a network error, a daemon
  restart — is re-run with the same command and skips every row that already has an id. It never creates
  a row twice.
- **Finish:** prints `✓ N goals, M lanes`, the ids, and pointers to `/live?team=<team>` and `musterd next`.
  The stage stays on disk, marked saved, as the record of what came in from where.

`musterd import list` shows staged imports and their state. `.musterd/` is **not** wholly gitignored
(ADR 058 commits `team.toml` and `seats/`), so the first `musterd import` writes
`.musterd/imports/.gitignore` containing `*`. That works in any repo without touching its root
`.gitignore`, and keeps stages and drafts (which may hold issue text) out of commits.

## The `musterd-import` skill

**Distribution.** `musterd init` installs it the way it installs `musterd-orient`
(`onboard/guidance.ts`): one canonical copy plus a bridge per harness for the five first-class harnesses.
The README quickstart's last step becomes "ask your agent to bring your work in".

**Flow.**

1. Ask the human what to bring in: this repo, GitHub issues, something they paste, or new work to plan.
2. Gather it, draft rows, write `.musterd/imports/draft-<time>.csv`.
3. Run `musterd import <file>`; show the human the preview.
4. Run `musterd import save <id>` **only after the human says yes**. The two steps are the human's
   checkpoint; the skill states that an agent never saves an import it previewed itself without that yes.

**Repo scan.** Reads the README, ROADMAP and TODO files, plan and spec docs, a `TODO`/`FIXME` grep
(grouped into themes, not one lane per comment), unmerged branches, and recent commits for work in
progress. Themes become goals; concrete units become lanes. Each lane's `detail` says where it was found.

**GitHub issues.** `gh issue list --state open --json number,title,body,labels,milestone,url`.
Milestones, or else the main labels, become goals; each issue becomes a lane with `source_ref: github#N`
and the URL in `detail`. If `gh` is missing or not authenticated, the skill says so and continues with the
repo scan.

**First-import cap.** About 5 goals and 30 lanes; the agent tells the human what it left out, so a large
backlog does not flood a new board.

## Testing

- **CLI unit tests:** the CSV reader (quoting edge cases) and JSONL; each error and warning; goal-exists
  linking without re-declaring; topological save order; an interrupted save resumed against a fake HTTP
  client, asserting no duplicate creates; each save refusal.
- **Skill, end to end:** run it for real on a repo with open GitHub issues against a fresh team. That run
  is the lane's acceptance check.
- **Locally:** single test files, typecheck, lint and format only (the laptop hosts many seats); CI runs
  the suite.

## Phases

| Phase | What                                                                                       | Lane                         |
| ----- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| 1     | Import file, `musterd import` + `save` + `list`, `musterd-import` skill (repo scan + GitHub issues), README quickstart | `01M4FDBSN8JKWV6GJQ7C3VB888` |
| 2     | Linear, Jira, Notion sections in the skill (connector, or an export file)                  | `01M4M4A67Z9ZMYCSPHG55FSY8E` |
| 3     | `musterd import sheet` (a blank CSV with headers and two example rows) and a guided "plan new work" mode | `01M4M4AAJA75AS1YEN8CCHJ6DY` |
| 4     | Native tracker connectors and re-sync; `source_ref` as a lane field (ADR + protocol change). Only if a design partner asks | `01M4M4ABWQ7M5VEB9RS3VG99VF` |

## Not in this design

- **Draft lanes on the board** reviewed in `/live` before save. Considered and declined for phase 1: it
  needs a new lane state (protocol change + ADR) and cannot land by Oct 20. The local stage can be
  replaced by it later if review in `/live` proves to matter.
- **Editing or deleting imported items in bulk.** Imported goals and lanes are ordinary goals and lanes
  afterwards.
