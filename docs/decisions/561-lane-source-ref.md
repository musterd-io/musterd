# 561 — `source_ref` is a lane field, one open lane per ref

- Status: accepted
- Date: 2026-10-12
- Deciders: nick (design approved in chat 2026-10-11: matching on a real lane field; spec and plan
  approved), dolly
- Lane: `01M4M4ABWQ7M5VEB9RS3VG99VF` (tracker import, increment 1 of 4)
- Spec: [`2026-10-11-tracker-import-design.md`](../superpowers/specs/2026-10-11-tracker-import-design.md) ·
  Plan: [`2026-10-11-tracker-import.md`](../superpowers/plans/2026-10-11-tracker-import.md)
- Builds on: [ADR 487](487-nothing-vanishes.md) (the `follows_up` skew posture), the `source_ref` on
  calendar entries (`store/calendar.ts`)

## Context

Phase 1 of "bring work in" (`musterd import`) records where a row came from by appending a
`Source: <ref>` line to the lane's `detail`. That is enough for a person reading the lane. It is not
enough for the next step: `musterd import github|linear|jira` runs again and again, and each run has
to find the lane an issue already has, to rename it, to abandon it when the issue closes, or to leave
it alone. Matching on free text in `detail` breaks the moment someone edits the detail.

Phase 1 also left a gap: when the response to a lane create is lost between the daemon and the
stage write, a resumed save opens the same lane a second time.

## Problem

Where does a lane record the issue it came from, and what stops two open lanes tracking the same
issue?

## Decision

1. **`source_ref` is an optional lane field**, a string of 1–200 characters (`acme/app#12`, `ENG-42`,
   `CLI-7`). It rides `OpenLane` and `UpdateLane`, and `Lane` carries it as `.nullable().optional()`
   — the posture `follows_up` used (ADR 487), so a lane from an older daemon still parses and reads
   as having none. `musterd/0.3` is unchanged; `FEATURE_EPOCH` goes to 34 so a client can tell
   whether the daemon has the field.
2. **One open lane per ref per team.** Opening a lane with a ref, updating a lane onto a ref, or
   reopening a done or abandoned lane that carries a ref, is refused with a 409 `conflict` —
   `source_ref "<ref>" already belongs to lane <id>` — when another lane on the team that is neither
   `done` nor `abandoned` holds it. The check runs inside the store transaction, the way
   `store/calendar.ts` refuses a duplicate. The index on `(team_id, source_ref)` is not unique: "among
   lanes not done or abandoned" is not something a partial index can say over a state that changes.
3. **A done or abandoned lane keeps its ref** as history. A reopened issue can then get a new lane.
4. **`GET /lanes?source_ref=<ref>`** is an exact-match filter, alongside `goal`. Lane snapshots and
   the audited field diff carry the column like any other.
5. **The surfaces show it:** `lane open|update --source-ref` and `⌁ <ref>` in `renderLane`; the
   `source_ref` argument on `lane_open`/`lane_update` and `src=<ref>` in `fmtLane`; a source chip on
   the `/live` card, linked when the detail's first line is the issue URL.
6. **The file import sends the field** instead of the `Source:` detail line. Its preview leaves out
   a row whose ref an open lane already holds (`already_on_board`), and save adopts the existing lane
   when a create comes back 409.

## Consequences

- **The refusal is per daemon, not in the fold.** On a synced team a lane open is a local write that
  replicates as a `lane.opened` event, and the fold applies history; it never refuses an event. So
  each daemon checks at its own write, which covers the hub's arbitrated writes too, and the fold
  carries `source_ref` without judging it. Two machines opening the same ref at the same moment can
  still leave two open lanes. Re-sync (increment 2) reports such a ref as `duplicate_ref` and acts on
  neither lane. The spec's line that the hub refuses on the merge path is corrected by this ADR.
- **The phase 1 lost-response duplicate is closed** by decision 6: the resumed create gets a 409 and
  the save records the lane that already exists.
- **Lanes imported before this keep their `Source:` line** and no field. There is no backfill; a
  re-sync adopts them (increment 2).
- The two MCP tools grow by one argument each, counted against the context budget.
