# 519 — Calendar entries as team data

- Status: proposed
- Date: 2026-10-05
- Lane: `01M472885Y78QX2PQJRPAXPC95` (goal `mobile-app`, increment 1)
- Deciders: nick (direction, 2026-10-05: "a real iOS app on the App Store, calendar only for now";
  option (b), the calendar becomes musterd team data), dolly
- Relates to: [ADR 520](520-mobile-toolchain-expo.md) (the app that reads it), hard rule 1 (no
  protocol schema change without an ADR), [ADR 291](291-shared-seeds-before-lanes.md) (the last
  team-data type added, and the pattern followed here), [ADR 446](446-remote-mcp-https-oauth.md)
  (bearer credentials over HTTP, which the phone reuses)

## Context

nick's calendar for getting musterd off the ground — demos, pitch practice, deadlines, people to
meet — lives in a claude.ai artifact: one page, its own `events` collection, 112 entries on
2026-10-05. It works on a phone in a browser. It is not musterd data: no seat can read it, `/live`
cannot show it, and an agent that learns of a demo cannot put it on the calendar without the
artifact's own tools.

The lane handed to this seat (`01M46YWG8YHE`) asks for a native iOS app whose only job, for now, is
this calendar, and names the choice already made: the calendar becomes team data, imported once
from the artifact at cutover. The app reads and edits it natively; `/live` can show it later.

The artifact's model, read on 2026-10-05: `title`, `date` (`YYYY-MM-DD`, Pacific wall-clock),
`start` and `end` (`HH:MM` or empty), `kind` (one of `demo`, `topic`, `pitch`, `people`, `prep`,
`deadline`, `milestone`, `event`), `status` (empty or one of `going`, `pending`, `list`, `invited`,
`waitlist`, `done`), `place`, `url`, `note`, `pick` (shown in the Picks view), `source` (free text:
where the entry came from), `updated`. Its views are Upcoming / Month / Past, Picks / Everything, a
kind filter, and an "Up next" line.

## Problem

A new team-data type touches `@musterd/protocol`, the store, the HTTP surface and the SPEC. The
questions are the shape of an entry, who may read and write it, how the phone authenticates, how
the one-time import stays idempotent, and what is deliberately left out so the first increment
stays small.

## Decision

1. **One new type, `CalendarEntry`, in `@musterd/protocol` (`calendar.wire.ts` for the enums,
   `calendar.ts` for the zod schema).** Fields: `id` (ULID), `title` (1–160), `date` (`YYYY-MM-DD`),
   `start` and `end` (`HH:MM` or null), `tz` (IANA name; default `America/Los_Angeles`), `kind`
   (the artifact's eight), `status` (the artifact's six or null), `place` (≤120), `url` (https or
   null), `note` (≤2000), `pick` (boolean), `source` (≤120, free text), `source_ref` (the artifact
   document id for imported rows, else null), `created_by` (member name), `created_at`,
   `updated_at`. Dates and times are wall-clock in `tz`, never converted to UTC, because that is
   what the calendar means by "Thursday at noon" and what the artifact stores.
2. **Team-scoped; any active Member reads and writes.** It is team data in the sense Seeds are
   (ADR 291): an agent that learns of a demo adds it, a human corrects it. Deletion is a real
   delete, recorded in audit. Each write is one audit row (`calendar.entry_written {id, by}` or
   `calendar.entry_deleted {id, by}`), so the ledger shows who changed what.
3. **HTTP, member-authenticated, on the daemon:** `GET /teams/:slug/calendar` (all entries, with
   `?since=<ms>` for a delta), `POST /teams/:slug/calendar`, `PUT /teams/:slug/calendar/:id`,
   `DELETE /teams/:slug/calendar/:id`. Bodies parse through `CalendarEntrySchema` at the boundary
   (hard rule 4). No WebSocket frame in this increment: a calendar changes a few times a day and the
   app polls `?since` on foreground.
4. **The phone is a Member's device.** It holds that human's credential (`mscr_`, ADR 446's bearer
   shape) in the iOS Keychain and sends it as today's HTTP clients do. For increment 4 it reaches the
   laptop daemon over Tailscale at the MagicDNS name on port 4849, which `MUSTERD_ALLOWED_HOSTS`
   must list (`docs/guides/cross-network-overlay.md`). The server URL is a setting in the app, so
   musterd Cloud, when it exists, is a URL change and nothing else.
5. **One-time import, idempotent.** `musterd calendar import <events.json>` reads an export of the
   artifact's `events` collection and upserts on `(team_id, source_ref)`, so running it twice changes
   nothing. Until cutover the artifact stays the live calendar; the import runs once at cutover,
   and the artifact is then read-only by convention (its page is not changed by this ADR).
6. **Out of scope here, by name:** recurrence, reminders and push, invitations, sharing to Apple
   or Google Calendar, per-entry visibility, and a `/live` view. The schema carries nothing that
   anticipates them. Follows-up: deferred — none opened; each becomes a lane under `mobile-app`
   only when someone asks for it (2026-10-05).

## Consequences

- `@musterd/protocol` gains a schema and two enums (hard rule 1 satisfied by this ADR); `SPEC.md`
  gains Appendix A.16 (unreleased) with the routes and the entry shape; `02-protocol.md` and
  `03-server.md` gain the file lines. Migrations add `calendar_entries` on both backends (ADR 479).
- The artifact's 112 entries carry `source: ''` mostly; the import sets `source_ref` to the
  artifact document id and leaves `source` as it was.
- A `tz` per entry costs one column and avoids the two-timezone bug on the day nick is not in
  Pacific; the app shows times in the entry's `tz` and says so when it differs from the device's.
- **Increments, each a lane under Goal `mobile-app`:**

  | increment | lane | what lands | protocol? |
  | --- | --- | --- | --- |
  | 1 | `01M472885Y78QX2PQJRPAXPC95` | this ADR and ADR 520; transport settled | no |
  | 2 | `01M4728G4FEHNCJWTXDJVWF2KQ` | schema, table, routes, audit, SPEC A.16 | yes |
  | 3 | `01M4729B4F9HS53H77QQPEH82N` | `musterd calendar` + one-time import | no |
  | 4 | `01M472A1T4FSB7FNDTR9CMBZEA` | the Expo app on nick's phone (dev build) | no |
  | 5 | `01M46YWG8YHEV2SKW9F1N0W8FG` | TestFlight, then the App Store; cutover import | no |

  2 depends on 1; 3 and 4 on 2; 5 on 3 and 4. 5 also needs the Apple Developer Program membership,
  which only nick can buy.

## Observability & Evaluation

- **Traces:** the two audit verbs above; the daemon's existing request spans cover the routes.
- **Eval:** the lane's acceptance as handed off — nick installs the app (TestFlight first) and sees
  and edits the same 112 entries. Measured: the import reports `112 upserted, 0 changed` on its
  second run; a month after cutover, entries written by agents exist (count > 0), which is the
  reason this is team data rather than a synced file.
- **Experiment:** none. One user, one calendar.
- **Falsifier:** nick is still adding entries to the artifact a month after cutover, meaning the
  app did not replace it; then the app, not the data model, is what to revisit.
