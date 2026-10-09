# /live and /broadcast briefing — design

**Status:** design approved in chat 2026-10-09 (nick, miley); written spec awaiting review. Lane
`01M4FG1R7C84HM4RE5GF7FF6WZ`. Goal: `launch`.

## What nick asked for (2026-10-09)

When someone first lands on `/live` it must be immediately clear: what everyone is working on, what is in
progress, whether there are blockers, issues or asks, and what was completed recently. Most of that is
already displayed somewhere; it needs to be more prominent, holistic and very easy to understand.

Two audiences, two surfaces:

- **`/live`** is for members of the team, checking in daily. Dense, scannable, interactive.
- **`/broadcast`** is the hosted Twitch stream. Non-interactive, read from across a room, and a stranger
  arriving mid-stream should still get the picture.

## What is wrong today (measured 2026-10-09, 1440×900, team `revive`)

- Asks, approvals and blocked lanes are the quietest thing on the page. The asks strip read "no open
  questions · +2 more waiting" (collapsed); a BLOCKED seat showed only as a small label on the fifth card
  of the team column, below the fold.
- The team column is grouped by person. It shows four of eleven seats before scrolling, with titles
  clipped. It answers "who is doing what", not "is anything wrong".
- "Completed recently" is a three-chip ticker under the room that mixes "opened 4 lanes" with real
  finishes, with titles clipped.
- The counts disagree: the topbar read "1 working · 10 between tasks" while the team column read
  "3 working". Two derivations of the same word.

## Decisions

1. **One pure selector, two presentations.** `briefing.ts` derives everything; `/live` and `/broadcast`
   render it. The counts in a headline can never disagree with the lists under it, because both come from
   the same arrays.
2. **Blocked lanes are loud**, like open asks and approvals. A person's ordinary in-progress work, human
   or agent, is the calm bucket.
3. **Approvals mean two things** and are handled differently:
   - *Approve-type asks* (an agent asks a human to approve something) arrive on the message timeline and
     are in "Needs a human" on both surfaces.
   - *Seat-claim requests* come from `GET /teams/:team/requests`, which is admin-only (ADR 077). They
     appear on `/live` only, only for a viewer holding an admin credential, and not on `/broadcast`.
     Showing who is asking to join on a public stream was weighed and declined; a count-only version
     is a possible later increment, and it needs a public-grade read, so a server change and an ADR.
4. **No protocol or server change in these increments.** Everything is derived from `roster`, `board`,
   `goals`, `asks` and `envelopes`, which the pages already hold.

## `briefing.ts`

A pure module in `packages/web/src/live/`, node-testable (the repo has no jsdom). Input:
`{ roster, board, goals, asks, envelopes, now, requests? }` where `requests` is the pending seat-claim
list and is passed only when the viewer is an admin. Output:

| Field        | Contents                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `needsHuman` | Asks in `open` or `held` (existing `askIsLoud`), lanes in `blocked`, and seat-claim `requests`. Each item: `kind`, title, owner, age, `waitingOn` when known. |
| `inProgress` | Lanes in `claimed` or `active`: title, owner, goal title, age. Humans and agents alike.                                                          |
| `inReview`   | Lanes in `awaiting_acceptance`.                                                                                                                  |
| `shipped`    | Lanes that reached `done` in the last 24 h, newest first: title, closed-by, time. Read from the board, never from envelope text.                  |
| `headline`   | One sentence built from the four arrays, e.g. "3 working · 1 blocked · 2 waiting on you · 4 shipped today".                                      |

Notes from reading the code:

- Lanes carry no "blocked reason" field. A blocked item shows title, owner, time blocked and its
  `depends_on` when declared. It does not invent a reason.
- `teamCards.ts` and `workingOn.ts` already derive per-member state for the office and the member cards.
  They stay. `briefing.ts` reuses their helpers (`memberPosture`, the in-flight sets) instead of
  re-deriving, and the topbar meter and the team column are changed to read the new headline.
- The "1 working" vs "3 working" mismatch is fixed here, by there being one definition, and pinned by a
  test that renders the headline and the lists from one fixture and asserts the counts agree.

## `/live` — the Now panel

- Replaces the team column. Four stacked sections: **Needs a human**, **In progress**, **In review**,
  **Shipped (24 h)**.
- **Needs a human** is the only loud section. Non-empty: a warm-amber band with a count; each row is a
  card with kind (ask / approval / blocked / seat request), title, owner and how long it has waited.
  Click opens the thing, as the asks strip and board overlay do now. Empty: a single calm line
  ("nothing is waiting on anyone"), so an empty section reads as good news and not as a missing one.
- The other three are quiet lists: full title wrapped (not clipped), owner chip, goal, age; about five
  rows each plus "+N more". Windowed, per the web contract (no unbounded mounts).
- The topbar meter is replaced by the headline sentence.
- The office stays. A seat that owns a blocked lane gets a small marker on its plate, so the picture and
  the list agree.
- The per-member cards move to a **Team** tab on the same panel, so the whole roster (idle and away
  included) is still one click away.
- Phone: the panel is first and the office stays hidden, as today.
- Seat-claim requests: fetched only when the viewer's credential is admin-grade; a failed or forbidden
  read renders nothing, never an error.

## `/broadcast` — the lower-third

- The headline sentence in large type, and below it one bucket at a time rotating slowly with up to
  three big rows (title and owner only; no ages or chips).
- **Needs a human interrupts the rotation.** While non-empty it holds the lower-third until it clears.
- No seat-claim requests (see Decisions 3). Asks, approve-asks and blocked lanes only. A blocked lane
  is a stronger public claim than "working on"; titles are already public on this surface.
- The rotation stops when the tab is hidden and honors still mode, per the animation rule in
  `packages/web/AGENTS.md`.
- `/broadcast` keeps its own route and its no-seat property.

## Constraints that apply

- `pnpm perf:check` byte budgets; the panel code stays in the route's existing graph or a lazy chunk.
- `pnpm a11y:check` and `pnpm a11y:targets:check` sweep `/live` connected at 390×844 and desktop; the
  new amber band uses `--lc-warn` for fills and `--lc-warn-ink` for text, never the fill as text.
- `pnpm tokens:check`: every new colour and length token defined, with consuming elements mounted
  where the token is in scope.
- Text and animation follow the three Recursive cuts; no new family.
- Web lanes default to `stakes: low`. Raise it for the increments that assert facts as public
  claims (increment 3).

## Increments

1. `briefing.ts` plus tests; the headline replaces the topbar meter. Fixes the count mismatch.
2. The Now panel on `/live` (including the Team tab, the seat-request read and the office blocked
   marker).
3. The `/broadcast` lower-third.

Each is its own lane under goal `launch`. Lane ids go in the plan's Increments table.

## Not in scope

A first-time-visitor welcome tour, a public seat-request count, reasons for a blocked lane (needs a
protocol field and an ADR), and any change to the office scene beyond the one marker.

## Falsifiers

- If, on a fixture team, the headline's counts differ from the lengths of the lists, the selector is
  wrong. The unit test is that fixture.
- If a viewer without an admin credential sees seat-claim requests anywhere, or `/broadcast` shows any,
  the privacy decision is broken.
- If `/live` connected at 1440×900 does not show every non-empty "Needs a human" item without scrolling
  or a click, the panel has failed its one job.
