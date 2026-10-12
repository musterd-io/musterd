# Import from GitHub, Linear and Jira, and re-sync — design

**Status:** design approved in chat 2026-10-11 (nick, dolly); written spec awaiting review. Lane
`01M4M4ABWQ7M5VEB9RS3VG99VF` (bring work in, phase 4). Builds on the
[phase 1 design](2026-10-10-bring-work-in-design.md), whose import file, stage and save this reuses.

## What nick asked for (2026-10-11)

Phase 1 planned native tracker connectors "only if a design partner asks". None has asked, and nick wants
them built anyway. Decisions made in the design conversation:

- **One-way pull.** musterd reads the tracker and never writes to it.
- **The CLI runs it, on demand.** `musterd import github|linear|jira` uses credentials already on the
  machine. It produces the same stage and preview as a file import, and re-sync is running it again. **The
  daemon stores no tracker secrets.**
- **Three trackers:** GitHub, Linear and Jira, using Node's built-in `fetch`, so no new dependency. Notion
  stays with the `musterd-import` skill.
- **Closed upstream:** the preview proposes abandoning the lane, and save abandons it with
  `abandon_reason: closed in <tracker> (<ref>)`. A claimed lane is never touched; it gets a warning. A
  new issue opens a lane, and a renamed issue renames its lane (`lane_update`, ADR 240).
- **Matching:** `source_ref` becomes a real lane field, with one open lane per ref per team. It needs an
  ADR.

**Success:** on a repo whose GitHub issues are already on the board, running `musterd import github`
again after issues are opened, renamed and closed upstream previews exactly those changes. Saving them
leaves the board matching the tracker, without duplicating a lane or touching a lane someone holds.

## Shape

```
GitHub ─┐  musterd import github|linear|jira     musterd import save <id>
Linear ─┼─► fetch (local credentials) ─► rows ─► check + planSync + preview + stage ─► open / rename /
Jira ───┘                                 (same ImportRow as a file)                  abandon / adopt
```

Each tracker module turns issues into the `ImportRow[]` a CSV produces, so the check, preview, stage and
save of phase 1 run unchanged. What is new is `planSync`, which compares the rows with the board's lanes
for that source and adds rename, abandon and adopt actions to the stage.

## 1. `source_ref` as a lane field (protocol + server; new ADR)

**Protocol**

- `source_ref`: an optional string, 1–200 characters, the same shape as `source_ref` on calendar entries.
  It goes on `OpenLaneSchema` and `UpdateLaneSchema`, and on `LaneSchema` as `.nullable().optional()`,
  the posture `follows_up` used (ADR 487), so older readers keep working.
- An optional field leaves `musterd/0.3` unchanged (SPEC §6). `FEATURE_EPOCH` goes up by one, so a client
  can tell whether the daemon it talks to has the field.

**Server**

- Ladder migration (the next number, v91 as of 2026-10-11) adds a nullable `lanes.source_ref` column to
  SQLite and Postgres, using v81's guarded pattern. The Postgres drift test keeps the two schemas equal.
- **One open lane per ref.** Opening a lane, or updating one to carry a ref, is refused with a 409
  `conflict` (`source_ref "acme/app#12" already belongs to lane <id>`) when another lane on the team that
  is neither `done` nor `abandoned` holds the same ref. The check runs inside the store transaction, the
  way `store/calendar.ts` refuses a duplicate. A unique index cannot say "not done or abandoned", so it
  isn't one.
  - A done or abandoned lane keeps its ref as history, and a reopened issue can then get a new lane.
- When a synced team merges changes from another machine, the hub applies the same refusal on that path.
- `GET /lanes?source_ref=<ref>` is an exact-match filter alongside `goal`.
- Lane snapshots and the lane-update field diff carry the column like any other.

**Surfaces**

- **CLI:** `lane open --source-ref <ref>` and `lane update --source-ref <ref>`; `renderLane` shows the
  ref.
- **MCP:** `lane_open` and `lane_update` accept `source_ref`; `fmtLane` prints `src=<ref>`. This counts
  against the context budget (`pnpm context:check`).
- **`/live`:** a lane card shows a small source chip next to the goal chip. It links to the issue when the
  lane's detail holds the issue URL.

**The file import (phases 1–3)**

- `musterd import save` sends `source_ref` as the field, instead of appending a `Source: <ref>` line to
  `detail`.
- The preview checks rows against the live board. A row whose ref already belongs to an open lane is
  listed as "already on the board" and skipped, not saved again.
- If save hits a 409 on a ref, it records the existing lane as created and moves on. This closes the
  phase 1 gap where a lost response between a create and the stage write could duplicate a lane.

## 2. The three commands

Each command fetches open issues and returns `ImportRow[]`. The token is sent only in request headers. It
is never written to the stage file, printed, or sent to the daemon.

|                 | `musterd import github [owner/repo]`                | `musterd import linear --team ENG`               | `musterd import jira --site <url> --project PROJ`                                              |
| --------------- | --------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Credentials** | `gh auth token`, else `GITHUB_TOKEN`                | `LINEAR_API_KEY`                                 | `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud, basic), else `JIRA_PAT` (Server/DC, bearer), else none |
| **Fetch**       | REST `/repos/{o}/{r}/issues?state=open`, paged; pull requests skipped | GraphQL; issues whose state type is not `completed` or `canceled` | REST search, `project = PROJ AND statusCategory != Done`                         |
| **Goals**       | milestones                                          | projects, else cycles                            | epics, else fix versions                                                                       |
| **`source_ref`** | `owner/repo#12`                                    | `ENG-42`                                         | `PROJ-123`                                                                                     |
| **Stakes**      | label `priority:high` / `priority:low` if present   | Urgent → `high`, Low → `low`                     | Highest → `high`, Low or Lowest → `low`                                                        |

- **The repo** defaults to the `origin` remote (`git remote get-url origin`).
- **Detail:** the issue URL goes on the first line of `detail`, then the body, cut to the lane detail
  limit.
- **Goal ids** are slugs of the milestone, project or epic name. An existing goal is linked, not
  re-declared, as file import does now.
- **No group:** an issue with no group becomes a lane with no goal. The preview counts these ("12 lanes
  with no goal"); the CLI cannot ask the way the skill does.
- **Credentials missing or refused:** exit 2 with the one line that fixes it. For example: `no GitHub
  token — run gh auth login, or set GITHUB_TOKEN`, or `Linear refused the key (401) — check
  LINEAR_API_KEY`.
  - Jira with no credentials searches anonymously, which works on public sites such as Apache's.
- **Big backlogs:** all pages are fetched. Above 500 issues the preview warns, and `--limit N` caps the
  fetch.
- **Code:**
  - `packages/cli/src/import/trackers/{github,linear,jira}.ts`, plus a shared `http.ts`. `http.ts` pages,
    retries once on 429 or 5xx honouring `Retry-After`, and maps errors to the exit-2 lines.
  - `commands/import.ts` gets the three subcommands.
  - The help catalog and `docs/architecture/04-cli.md` describe them, including the file tree.
- **The skill** emits GitHub refs as `owner/repo#N` (it emitted `github#N` before), so the skill and the
  command produce the same refs. This is a guidance change (ADR 085 version bump).

## 3. Re-sync

Running the same command again is the re-sync. It reads the team's lanes that are neither done nor
abandoned and whose `source_ref` belongs to this source:

- **GitHub:** refs starting `owner/repo#`.
- **Linear:** refs starting with the team key and a dash, such as `ENG-`.
- **Jira:** refs starting with the project key and a dash, such as `PROJ-`.

Lanes with any other ref, or no ref, are never touched.

`planSync(rows, lanes)` is a pure function. It gives every issue and lane one action:

| Upstream                          | Board                                                    | Action (preview → save)                                                                     |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| open                              | no lane                                                  | **new**: open a lane                                                                        |
| open                              | lane, title differs                                      | **renamed**: update the title only. Goal, stakes and detail stay, since someone may have changed them on purpose |
| open                              | lane, same title                                         | unchanged (counted)                                                                         |
| absent from the open set: closed  | lane, unclaimed                                          | **abandon**, with `abandon_reason: closed in GitHub (acme/app#9)`                           |
| absent from the open set: closed  | lane claimed or `awaiting_acceptance`                    | **warning** (`closed upstream, held by <seat>`), untouched                                  |
| absent: not found (deleted, moved, no access) | lane                                         | **warning**, untouched                                                                      |
| open                              | lane with no ref and a `Source: <ref>` line in its detail | **adopted**: save sets its `source_ref`                                                    |

- **An issue absent from the open set** is fetched on its own to tell closed from not found. That costs
  one request per lane, and only for lanes whose issue has dropped out of the open set.
- **Legacy GitHub refs** are `github#N`, which names no repo. A `Source: github#N` lane is adopted as
  `owner/repo#N` only when the lane's `project` is this repo's project.
- **The preview** prints one count line, such as `new 4 · renamed 2 · closed upstream: abandon 3 ·
  adopted 7 · 1 warning`, with the rows under it. Counts of zero are left out.
- **Save:**
  - It runs adoptions first, then new lanes, renames and abandons. Each abandon is
    `PATCH /lanes/:id {state: 'abandoned', abandon_reason}`.
  - Just before a rename or an abandon, save re-reads the lane. A lane claimed since the preview is
    skipped with a warning and is never abandoned.
  - Each action is recorded in the stage as it completes (phase 1's atomic write), so
    re-running save skips what is done.

## Errors

- **Fetch fails partway through:** nothing is staged, and the command exits 1 with the tracker's error.
- **Save:**
  - Each action stands alone, and save lists the ones that failed.
  - Re-running save is safe. A lane that already exists comes back 409 and is adopted, not duplicated, and
    an abandon on a lane that is already abandoned is a no-op.
- **A stage from an older CLI** (with no sync actions) saves as before.

## Testing

Locally, run single test files only; CI runs the full suites.

- **protocol:** schema tests for `source_ref` on open, update and lane, including a lane that has no such
  key (an older daemon).
- **server:**
  - the migration (`db.test.ts`) and the Postgres drift test;
  - a 409 on a duplicate open, and on an update to a ref another open lane holds;
  - a duplicate allowed once the first lane is done or abandoned;
  - the refusal on the merge path for synced teams;
  - the `?source_ref=` filter.
- **cli:**
  - Each tracker module runs against a local `node:http` fake serving recorded payloads, so tests make no
    network calls. The cases cover paging, pull requests skipped, grouping, stakes, 401, and 429 with
    `Retry-After`.
  - One test asserts that the token appears nowhere in the stage file or the output.
  - `planSync` gets one case per row of the re-sync table, plus the legacy `github#N` project check.
  - An import-command test runs twice against an in-memory server and the fake tracker. The first run
    opens lanes; between runs, one issue is renamed, one closed and one added, and the second preview and
    save show exactly those changes. A claimed lane whose issue closed is left alone.
- **Acceptance (isolated daemon, `$SP/accept`):**
  - **GitHub:** a real repo, using nick's `gh` token.
  - **Jira:** Apache's public Jira, anonymous.
  - **Linear:** only with a key nick provides; otherwise the recorded payloads stand in, and the spec's
    acceptance notes say so.

## Increments

Goal `tracker-import`, with four lanes (ADR 487):

| Increment | What | Lane |
| --------- | ---- | ---- |
| 1 | The `source_ref` lane field: protocol, server, CLI, MCP, `/live`, and the file import sending it (ADR, epoch bump) | `01M4M4ABWQ7M5VEB9RS3VG99VF` |
| 2 | `musterd import github`, `planSync` and re-sync, and the skill's `owner/repo#N` refs | `01M4Q7PMAPNXP4772YPHTKM0K2` |
| 3 | `musterd import linear` | `01M4Q7PNWW8MBB40FS1421ZX99` |
| 4 | `musterd import jira` | `01M4Q7PQGX9JPJP9S691JCSDDN` |

Increment 1 lands first; 2 depends on it, and 3 and 4 depend on 2.

## Not in this design

- **Writing back to a tracker** (closing an issue when its lane is done, comments, labels). One-way by
  decision.
- **Daemon-side sync** (webhooks, a schedule, stored tokens). Re-sync is running the command.
- **Notion as a command.** Its schema is per-database; the skill keeps it.
- **Following upstream changes to grouping, stakes or body** after a lane exists. Only the title follows.
- **Goal `source_ref`.** Goals stay keyed by slug; a renamed milestone makes a new goal slug and the old
  goal stays.
