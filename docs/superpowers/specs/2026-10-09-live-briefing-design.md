# /live and /broadcast briefing — design

**Status:** design approved in chat 2026-10-09 (nick, miley); written spec awaiting review. Lane
`01M4FG1R7C84HM4RE5GF7FF6WZ`. Goal: `launch`. Revised the same afternoon after nick saw the overlay live:
the card was redesigned (§"The Now card, v2") and the page around it was thinned (§"Consolidation");
that revision is awaiting review.

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
  re-deriving, and the topbar meter and the team column are changed to read the new headline
  (increment 4 takes the headline back out of the topbar: the Now card carries the counts).
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

What it says, and how it looks, is §"The Now card, v2" below. The first build's content (a "Needs …"
section per human, a separate Blocked header, one text line per goal, a person line per shipper) was
replaced the same day: nick found it "wayy too dense with text … not visual enough".

## The Now card, v2 (approved 2026-10-09, mockup v9)

nick, on the first build: too dense with text, not visual or colourful enough, not intuitive. Six mockup
rounds followed. What he rejected is as useful as what he approved:

- a glowing, gradient "needs you" orb and a pulsing card: "UI/AI slop" (designer tells 1 and 3);
- a rainbow of per-goal colours, pill chips and a legend: still slop (tells 2, 4, 8);
- one tick per lane: "not intuitive enough" — an encoding that needs a legend;
- single initials for people: "not enough to identify the members";
- a strict ink-on-paper version with no colour at all: "back to no colors/visuals";
- a 780 px two-column version with six goals: "too dense".

**The rule that came out of it.** Colour on the card means something. It comes from three places only:
the **members' own faces** (each person drawn as the office draws them, so the hues belong to people),
**mustard** (the one accent: the "waiting on you" band and the goal bars) and **danger ink** (only on
"blocked"). Everything else is the `/live` paper and ink, in the three Recursive cuts. No gradient, no
pulse, no pill, no legend. _(2026-10-13, lane `01M4V754ZD36MBYBACTD54G60D`, nick: a fourth place —
**warn ink** on the line under a **stopped** goal. "Goals in motion" lists only goals with something
working, in review or blocked, so a plan whose later increments nobody is building vanished from the
card exactly when someone needed to see it. A "Stopped" list follows the goals in motion, absent when
nothing is stalled: one row per goal that is **quiet** — every live, unparked lane untouched for
`GOAL_STALE_DAYS`, the server's `stale_goals` rule, ADR 487 §5.4 — or that has **orphans**, open
unowned lanes that old while the rest of the goal moves. The row is the motion row without faces or
states: name, bar, "d of n done", and the line "nothing moved in 9d · 3 waiting, nobody's"; hover
names the oldest untouched lane, click drills the board into the goal. Capped at three with "N more
stopped". The office's own tell for a stopped goal is a second increment, after this one is seen.)_

**Shape.** One card, `min(920px, 100vw − 48px)` wide, over the room, placed just under the room's
asks strip and huddle rail (measured, since the rail grows as huddles open — a fixed offset covered the
huddle row in the first capture). Top to bottom:

1. **Header row**: "Now", and the full-screen and dock controls.
2. **Waiting on you** — only when the viewer is a signed-in human with asks routed to them (the briefing
   rule: team-wide or routed to a human). A flat mustard-tinted band (`--lc-warn` fill, `--lc-warn-ink`
   text) holding the asker's face, the newest ask's text, who asked and when, and an **Answer** button
   that opens the ask as the strip does. More than one: "Waiting on you · 3" and the newest. Asks routed
   to *other* humans, and seat-claim requests for an admin, are one quiet line under it ("2 waiting on
   sloane · 1 seat request"), no tint. Approve and Deny stay in the asks strip, the one place you act
   from (nick chose this, 2026-10-09: the strip is the live home, Now only reports it).
3. **Two columns**, goals left and shipped right (320 px); below 880 px wide they stack.
   - **Goals in motion**: a goal is in motion when one of its lanes is in progress, in review or
     blocked. Four rows, then "N more goals", which expands in place. Ordered by the newest lane update.
     A row is one line — the goal's **title** in Recursive Casual (cut to one line, the full title on
     hover; the `story` field is not used, so the row reads like the board), the **faces** of its lanes'
     owners (three, then "+N"), a thin mustard **bar** and its words: "3 of 8 done". Under it, small, the
     non-zero states: "4 working · 1 in review · 1 blocked", blocked in danger ink. `done of total`
     counts the goal's lanes with `abandoned` left out of both. Lanes with no goal gather in a last row,
     "No goal".
   - **Shipped since yesterday**: one row per person, most first: face, name, count, and the title of the
     newest thing they shipped on a second line. Four rows, then "N more people". "Since yesterday"
     keeps its meaning from the first build (the previous working day).
4. Nothing else. The headline sentence, the In review section and the Blocked section are gone from the
   card: the counts live in the goal rows, and blocked lanes show inside their goal.

**Faces.** A new `MemberFace` (inline SVG, about 26 px) draws a member's head and shoulders from
`office-scene/appearance.ts` (`appearanceOf`, already pure and stable per name): skin, hair and hat as
on the floor, and shoulders in the member's identity colour, which is the colour of their top in the
room. A first cut drew only a small head inside an identity-coloured ring; at row size nobody could be
told apart (capture, 2026-10-09). A name the roster does not know gets a plain disc, never a made-up
face. Agents get the scene's antenna and visor, humans get eyes: the same tell the
room uses (ADR 079), so a member reads the same on the card and on the floor. It lives in the Now chunk,
not the eager graph. Hovering a face names the member.

**The room answers back.** Hovering or focusing a goal row sets `/live`'s existing `linked` state to its
owners, so their plates light up in the office; the colour and motion stay in the room, where
`PRODUCT.md` puts the spectacle. Clicking a goal row opens the board overlay drilled into that goal (a
new `focusGoal` prop on `BoardOverlay`, which already has the drill-in state). Clicking a shipped row
opens that person's newest shipped lane.

**Docking.** The card docks into a **topbar chip**, "Now", not a tab on the room's left edge (one less
thing over the room). When something waits on the viewer the chip reads "Now · 1 needs you" with a
small static mustard dot. No pulse: the state does not turn off on its own. The open and dock transition
still scales the card from and into the chip; reduced motion and `?still` skip it. When it opens by
itself is unchanged (`nowWhen.ts`).

## Consolidation — the rest of the page stops repeating Now (approved 2026-10-09)

nick's screenshot showed the same facts three and four times: the topbar headline equalled the card's
title; one ask was in the asks strip, in Now, and again as the ticker's first chip; "last act", the
sparkline and the ticker all answered "is anything happening?".

- **Topbar.** The headline leaves `TopMeter`. The meter keeps the team name, the heartbeat and the
  rate with its sparkline; "last act …" folds into the heartbeat's hover text. The Now chip sits after
  the meter. "See every message" leaves the ticker and becomes a log icon button in the topbar, beside
  the Seeds button.
- **Ticker.** A chip whose act is an ask still open in the strip is dropped; the ticker carries activity
  only.
- **Asks strip.** Unchanged. It is the one place an ask is answered.

## The work board sign (approved 2026-10-09)

The wall board opens the board overlay, but nothing says so: its hotspot (`office-scene/index.ts`,
`lc-boardspot`) carries a "work board" tag that shows only on hover. The tag becomes a permanent small
wooden sign hung on two strings above the board, in the scene's own wood and Recursive Casual: "work
board ›". Hovering or focusing the board or the sign lifts the sign a couple of pixels and brightens it;
reduced motion keeps it still. `/live` only, because only there is the board a control; `/broadcast`
paints the board as it does today.

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

4. Consolidation: topbar headline out, ticker drops open-ask chips, log icon. Lane
   `01M4H2GYHN9DB8DE5TQN5K1VKV`.
5. The work board sign. Lane `01M4H2H10QASWMX10CPTJ0BRA4`.
6. The Now card v2, `MemberFace`, goal drill-in, and the topbar dock chip. Lane
   `01M4H2H4JD5ATGKB9GXHVTQW3A`. Lands after 4, which clears the topbar room the chip takes.

All six are under goal `launch`; the plan for 1–3 is
[`2026-10-09-live-briefing.md`](../plans/2026-10-09-live-briefing.md).

## Not in scope

A first-time-visitor welcome tour, a public seat-request count, reasons for a blocked lane (needs a
protocol field and an ADR), and any change to the office scene beyond the one marker and the board
sign. Per-goal colours: a goal has no colour of its own, and inventing one is the rainbow nick turned down.

## Falsifiers

- If, on a fixture team, the headline's counts differ from the lengths of the lists, the selector is
  wrong. The unit test is that fixture.
- If a viewer without an admin credential sees seat-claim requests anywhere, or `/broadcast` shows any,
  the privacy decision is broken.
- If `/live` connected at 1440×900 does not show every open ask routed to a human without scrolling or
  a click — in the asks strip, which is now their one home — the page has failed its one job.
- If a viewer with an ask routed to them opens `/live` and the Now card does not show "Waiting on you"
  first, or the dock chip does not say so, the card has failed.
- If a goal row's "d of n done" disagrees with that goal's lanes on the board, the count is wrong.
- If any colour on the card is not a member's face, mustard, or danger ink on "blocked", the colour
  rule is broken — run the designer skill's ten tells on a capture, not on the code.
