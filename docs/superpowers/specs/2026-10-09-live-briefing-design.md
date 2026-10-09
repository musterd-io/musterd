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
| `headline`   | One sentence built from the four arrays, e.g. "3 in progress · 2 need a human · 1 in review · 4 shipped today". It counts lanes, not people: the old meter counted a presence posture and the old column counted lane-owning cards, which is the disagreement above; the per-member Team tab keeps the person view.                                      |

Notes from reading the code:

- **Two rules the first browser check forced (2026-10-09):** a lane is *in progress* only while its owner
  is present (a claim held by an offline seat is not progress; the first reading was "15 in progress"
  over a column saying "2 working"), and an ask *needs a human* only when it is team-wide or routed to a
  human (an agent-routed review ask is a review, not a person waiting). Both are in `briefing.ts` and
  pinned by tests.
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
- The other three are quiet lists: title wrapped to two lines (three in the loud section; the full text is
  on hover and one click away), owner chip, goal, age; five rows each plus "+N more on the board". Windowed, per the web contract (no unbounded mounts).
- The topbar meter is replaced by the headline sentence.
- The office stays. A seat that owns a blocked lane should get a small marker on its plate, so the picture
  and the list agree. **Split out of increment 2 (2026-10-09)** into its own lane: the scene's glyph
  overlay is driven by its own ask data and both routes read one room object, so it is a scene change,
  not a panel change. Lane `01M4GP19XE5JEC6MA7YCGZGSK6`.
- The per-member cards move to a **Team** tab on the same panel, so the whole roster (idle and away
  included) is still one click away.
- Phone: the panel is first and the office stays hidden, as today.
- Seat-claim requests: fetched only when the viewer's credential is admin-grade; a failed or forbidden
  read renders nothing, never an error.

## `/broadcast` — the lower-third

Built 2026-10-09 (lane `01M4FG5NWKCYSYQ9RWG06Y4TNC`); three things differ from the first draft, each
because the frame said so:

- **Where it sits.** In the room's empty bottom-left corner, above the floating ticker, over the office
  track only — not in the team column. Measured: seated in the column it cost two of six working cards
  at the 1080 stage, and that column has been trimmed for real estate before. The corner takes nothing
  from the cards.
- **What rotates.** *In progress* is **not** a rotating bucket here: the cards are that list, by person,
  and repeating it is the same fact twice. The headline sentence still counts it. What rotates is *In
  review* and *Shipped today*.
- **How much.** Two rows, then "+N more" — two is what fits the corner without covering the floor.

The rest holds: the headline sentence in large type, **Needs a human holds the frame** while anything is
in it (asks, approve-asks, blocked lanes; never rotated away), no seat-claim requests (see Decisions 3 —
the caller builds the briefing without `requests`, and the component drops the kind a second time), the
rotation stops while the tab is hidden and does not start in `?still`, and `/broadcast` keeps its own
route and its no-seat property.

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

1. `briefing.ts` plus tests; the headline replaces the topbar meter. Fixes the count mismatch. Lane
   `01M4FG58SX6BBJ736S4W1CHASS`.
2. The Now panel on `/live`, including the Team tab, the seat-request read and the office blocked
   marker. Lane `01M4FG5JRAR3QD460DWC7M7E7M`.
3. The `/broadcast` lower-third. Lane `01M4FG5NWKCYSYQ9RWG06Y4TNC`.

All three are under goal `launch`; the plan is
[`2026-10-09-live-briefing.md`](../plans/2026-10-09-live-briefing.md).

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
