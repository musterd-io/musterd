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
| `headline`   | One sentence built from the four arrays, e.g. "3 in progress · 2 need a human · 1 in review · 4 shipped today". It counts lanes, not people: the old meter counted a presence posture and the old column counted lane-owning cards, which is the disagreement above; the Team column keeps the person view.                                      |

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

## `/live` — the Now briefing (rebuilt 2026-10-09)

The first build was a **Now tab** beside Team in the team column. nick on seeing it: it "just looks like the
team tab", the "needs a human" title should name the human, the items were "way too big", and the point
is the thing a member needs *when they sign on in the morning having forgotten what they and the team did
yesterday*: who is working on what, what the issues are, who has done what. It was rebuilt (lane
`01M4GXHERZF6A2KFMBK2G616CK`) as follows; the team column is back exactly as it was.

**One card, three homes.** An **overlay** over the room's left (the room stays live and untouched behind
it), a **side tab** it docks to, and a **full-screen** layout. They share one set of geometry properties,
so moving between them is a single transition: docked, the card is scaled onto the tab at the tab's
position, so collapsing visibly shrinks *into* the tab and opening grows *out of* it. Not modal: it takes no
focus, and Esc steps it down (full → overlay → tab). Reduced motion and `?still` skip the transition.

**When it opens by itself.** On the first visit of a *period* (eight hours: a morning and the afternoon
after it are one sitting), once, after the first paint so the entrance plays. Otherwise it starts docked.
A phone never auto-opens (the overlay would cover the one column it has) and does not spend the period; its
tab is a small pill in the team header. The stamp is written when the overlay actually opens, so an effect
that runs twice cannot spend the period on a cancelled frame. Storage is a per-viewer convenience: if it
throws, the briefing opens as on a first visit (`nowWhen.ts`).

**What it says, grouped the way each question is asked** (the Team column is by person; this is not):

- **Needs …, by the human who has to act.** Asks and seat claims under a heading built from what is being
  asked of whom — "Needs approval from nick", "Needs approval and clarification from nick", "Needs an answer
  from the team", "Needs approval from an admin" (seat claims, admin credential only). The wording is the
  ask's own species (approve → approval, consult → clarification, escalate → an answer).
- **Blocked**, under its own header: a lane names a dependency, not a person to ask, so no human is
  invented. A blocked row says what it waits on when a dependency is declared and still open.
- **In progress, by goal**: one line per goal with who is on it in the overlay; every lane in full view.
- **Shipped since yesterday, by who shipped it**: one line per person in the overlay, their titles in full
  view. "Yesterday" is the start of the previous *working* day in the viewer's own clock (Monday reaches back
  to Friday), so the morning-after question has its answer; the topbar headline still counts the last 24 h.
- **In review**: last, and shortest.

Rows are one line each; the full title is on hover. Counts are lanes, not people. The rules in the section
above hold: a lane is in progress only while its owner is present, and an ask needs a human only when it is
team-wide or routed to a human. Rows open the lane or the ask exactly as the board and the asks strip do;
"+N more" opens full view.

## `/broadcast` — built, then reverted (2026-10-09)

A lower-third was built (#2272): the headline sentence and one rotating bucket in the room's empty
bottom-left corner, with Needs a human holding the frame. nick's verdict on seeing it: "I don't really
see the point of increment 3 as it stands now." It was reverted (lane `01M4GXHA3TBYXCT3A6TXEYFAQV`); the
stream is as it was before the briefing, and `briefing.ts` stays because `/live` reads it.

What the attempt taught, for whoever tries the stream again: the team column already lists what each
seat is on, so a stream briefing that repeats it adds nothing; the room's own banner already carries the
freshest ask; seated in the column the briefing cost two of six working cards; and a corner card at two
rows is the most the room's floor will take. What the stream does not show is *what shipped* and *what is
blocked* — that, not a rotating copy of the board, is the thing to design next, with the stream's
audience (a stranger arriving mid-stream) in mind rather than a team member.

Seat-claim requests stay off any public surface (Decisions, 3).

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
2. The Now panel on `/live` (merged #2265 as a tab; rebuilt as the overlay above, lane `01M4GXHERZF6A2KFMBK2G616CK`), including the seat-request read. The office blocked marker was split out. Lane `01M4FG5JRAR3QD460DWC7M7E7M`.
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
