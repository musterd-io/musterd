# 692 — /live shows who else has it open

- Status: accepted
- Date: 2026-10-21

## Context

Watching /live used to be anonymous to everyone else: two people could open the same office and
neither saw the other ([ADR 683](683-live-and-multiplayer-in-the-message.md), context table). nick asked
for a "who is here" row (ADR 683 §3, candidate 1; lane `01M5DAJ0Z7`). Only a signed-in seat attaches a
human presence ([ADR 155](155-human-presence-ladder.md)). The /broadcast capture seat
([ADR 157](157-broadcast-mode.md), [ADR 601](601-broadcast-visibility-grade.md) decision 7) and every
other observer seat must never count as a person.

## Problem

Nothing on the wire said "this is a /live page". A signed-in /live tab holds a human presence row
with `surface: 'web'`, but so do /board's socket and the ambient row every web HTTP read touches
(`x-musterd-surface: web`). Counting `web` rows would put someone on the board page, or someone who
had closed /live a minute ago, into the row.

Two smaller gaps showed up once the row was on screen:

- `readPresence` in `guards.ts` dropped `attached_at`, so the web never saw when a tab opened.
- The daemon sends a `presence` frame only when a member's last row goes. A /live tab closed beside
  a still-open CLI session sent nothing, so other tabs kept showing the member.

## Decision

1. **The claim carries the page.** A /live tab's WS claim sets `workspace: '/live'`
   (`LIVE_PAGE_WORKSPACE`; `LiveConfig.page = 'live'`, set only by the /live route). `workspace` is
   the existing "where" label on the claim. For human and observer seats it is display only, because
   displacement (ADR 068/092) is agent-scoped. No schema changes. /board and /broadcast do not set it.
2. **Here = a `/live`-labelled `web` row on the roster.** `hereRow.ts` reads it with no server change.
   Observers never reach the roster (`listPresence` drops `observer = 1`), so the /broadcast seat, the
   anonymous watcher and watch links stay out even if one of them sends the label. Held rows from a
   closed tab are out of the roster for their grace window (ADR 010).
3. **One face per member.** A second tab or device counts once; the card says "2 tabs". This answers
   the lane's open question. ADR 042 lets a human hold several sessions, but the row is about people.
4. **The reader keeps `attached_at`.** `readPresence` now reads the field `PresenceSchema` already
   declared (ADR 379). The guard/schema drift falsifier in `guards.test.ts` covers it.
5. **/live polls the roster every 60 s while visible.** This is how a tab closed beside another live
   session leaves the row. No new server frame is needed.
6. **The look** (design role, this lane): faces at the head of the topbar's tools, in the neutral
   chrome (ADR 681) and drawn as `MemberFace`, so a person looks the same in the row as on the floor.
   - The stack fans open on hover or focus. A tap pins a face's card: name, person or agent session,
     "here since", the tab count, and "quiet" when every tab is away.
   - The one authored moment is an arrival: the face slides in wearing one ring of the member's own
     colour, which settles. There is no pulse.
   - "<name> opened /live" shows for about three seconds, announced politely. It appears only when
     the member was already online elsewhere, because the team column already says "just walked in"
     for a fresh arrival.
   - Leaving folds the face away. A lone viewer reads "just you here".
   - Under reduced motion every change is instant and the words still say what changed.
   - The copy avoids "presence indicators" and "shared session" (ADR 683 §2).

## Consequences

- Any surface that wants "has /live open" reads the label. A future page that should count, such as
  a follow-a-seat view, sets its own `page` value and teaches `hereRow.ts` about it.
- The roster's `workspace` for a human's /live row now reads `/live`. The team card and the seat detail
  show it where they show a workspace.
- Perf: +186 B initial JS (the label, the poll, the reader), +2,145 B total JS (the row's lazy chunk)
  and +846 B live CSS. All three ceilings were raised as logged in `docs/perf/web-live-baseline.md`.
- A closed tab can stay in the row for up to 60 s when its member is still online elsewhere. That is
  the poll interval. Otherwise it leaves on the presence frame.

## Observability & Evaluation

- **Traces:** n/a. The row reads the roster that already carries every presence row. The label rides
  the existing `presence.attached` event's `workspace`.
- **Eval:** `packages/server/src/transport/who-is-here.test.ts` attaches the broadcast seat, a
  full-grade observer and a watch link, each sending the /live label, and asserts that no /live row
  reaches the roster. It also asserts that a signed-in member's /live tab appears and leaves on
  close, and that a board-page socket without the label does not count. `hereRow.test.ts`,
  `WhoIsHere.render.test.ts` and the claim-frame tests in `client.test.ts` cover the web half.
- **Experiment:** n/a. This is a product surface, not an agent-behaviour change.
