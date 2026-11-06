# The app comes alive — design

- Date: 2026-11-06
- Lane: `01M6SASNA5YECENP5Q5RV35DVE` (this spec). The build gets its own lanes in the plan.
- Asked by: nick, in a brainstorm with cider on 2026-11-06 (musterd questions `01M6S5WHT7`,
  `01M6S6RBA6`, `01M6S75DHF`, `01M6S77EAQ`, `01M6SA87SN`, answered from the phone).
- Mockups: [three directions](2026-11-06-app-alive-directions.html) (open in a browser). nick picked
  **A · the live floor**.
- Builds on: [the app shell design](2026-11-05-app-shell-design.md) (its feel bar is this
  document's acceptance bar, and its phases 2–3, nudges and chat, are folded in here), ADR 814 (the
  roster carries /live's team), ADR 797 (portraits), and /live's lane glow and goal bell
  ([the goal bell design](2026-11-03-goal-bell-design.md)).

## Intent

Phase 1 shipped the shell: the pill, Now with For you and the team in /live's states. nick on
build 61: "Good improvement … Overall it still doesn't quite make me feel how I described." Asked
which apps do give him that feeling: "Instagram, ESPN, Reddit, Twitch — there is immediate
gratification, plenty of ways to interact with it/the community very easily, what I am interested
in is bubbled up to the forefront, easy to navigate, it feels warm and immersive and like I'm
sharing an experience with other users."

So the app's job widens from "answer and check" to "be there with your team". Five qualities, in
his words, are the brief:

1. **Immediate gratification.** Something is happening the moment you open it.
2. **Easy ways to interact** with the team, one tap each.
3. **What you care about bubbled up.**
4. **Warm and immersive.**
5. **A shared experience** with the others on the team.

nick picked **A, the live floor**: the top of Now is the office itself. The moment that matters most
is **a lane landing**. And the feel is not only for the floor: "we can implement in other ways
besides just live." His one decided mechanic: **reactions reach the team.**

## Goals

- Opening the app shows the team at work, live, before anything else (qualities 1, 4).
- A lane landing is a small celebration you can join with one tap, and your reaction reaches the
  seat that landed it and everyone on /live (qualities 1, 2, 5).
- What is yours rises to the top everywhere: your asks, your lanes landing, your goals (quality 3).
- You can talk to the team and to any member from the phone (quality 2).
- Every surface of the app carries the same feel, not only the floor.

## Non-goals

- /live's full office scene on the phone. The floor is a phone-sized stage, not the Canvas2D
  scene with walking figures.
- A general social feed. Moments are the team's work, nothing else.
- Emoji keyboards, GIFs, threads of reactions. A short fixed set of reactions.
- Android, iPad, dark mode (unchanged).

## Anti-goals (nick, 2026-11-05 and 2026-11-06)

Too complicated; too crowded; the generic AI look (stacked rounded cards, coloured left borders);
not fun, magical or warm enough to want to use; too much movement ("a little too much movement" on
the re-sort, build 61).

## The live floor (top of Now)

A stage about a third of the screen tall, under the header. Warm: /live's floor colours (terracotta
wood, cream light), so the phone and the office are visibly one place.

- **Who is at work.** Each member who is here sits at a desk as their portrait (ADR 797), with
  /live's state dot. At most eight desks show; more than eight shows the eight most recently active
  and "+N" at the edge. Away members are not on the floor (they stay in the offline fold below).
- **What they are doing.** One short speech bubble at a time, rotating every few seconds between
  members whose state changed most recently: "merging #4019", "waiting for review", "asking you →".
  The words come from the roster the phone already has (`members[].label` and `title`), shortened.
  A bubble that names you is mustard.
- **LIVE** tag in the header while anyone is working.
- **Watching with you.** "you + dolly watching": the people (not agents) who have the app's Now or
  /live open right now, as small faces. Needs the daemon to know who is watching (see Decisions).
- **A lane lands.** A landing is the same event /live's glow fires on — the lane reaching `done` —
  so the phone and /live never glow for different lanes; it is credited to the lane's owner seat.
  *(cider's call.)* The member's desk glows — /live's "soft ding and a little glow at their desk" —
  the phone gives a light success haptic if Now is on screen, and the landing enters the feed.
- **A goal finishes.** The bell: a short ring animation over the floor and a heavier haptic,
  /live's goal bell in miniature.
- **Tap a desk** → that member's sheet.

**Fast enough to feel live** (nick, 2026-11-06: "I like the snappier approach"). The roster stays
pulled (ADR 791/814), but when a lane lands or a goal finishes the daemon also sends the paired
phone a **silent push** that carries no content, only "something happened", and the phone pulls at
once if Now is in front. A landing shows within seconds, not up to 30 s later. The silent push is
throttled (at most one in flight per phone, coalesced over a few seconds) so a burst of merges is one
pull, and it is dropped when the app is in the background: the next open pulls anyway.

Motion budget (the anti-goal "too much movement"): one bubble change and at most one glow at a time;
nothing loops faster than every few seconds; Reduce Motion freezes the floor to static faces and
dots, and the glow becomes a still highlight.

## Moments (under the floor)

A short feed headed "Happening now", newest first, capped at the last ~20 in a day. **Lane
landings lead**: a landing is a full row with the member's portrait, the lane's title, its goal, and
the reaction bar. Everything else is quieter:

| Moment | Row | Notes |
| --- | --- | --- |
| A lane landed (merged, attested) | full, with reactions | the hero |
| A goal finished | full, with the bell glyph and reactions | rarer, louder |
| An ask to you | already in For you; not repeated here | |
| A review verdict on your lane | one line | yours bubbled up |
| Someone started a lane | one line, folded when several | |
| A poll opened (admin) | one line | |
| Someone joined / went quiet | not shown | noise (nick picked landings) |

*(The quiet rows are cider's call; nick named only the landing. They can be cut to landings-only
if the feed feels busy on the phone.)*

## Reactions (decided: they reach the team)

- A fixed set of four: 🔥 👏 ✅ 👀. One tap adds yours; a second tap takes it back. Counts show on
  the row; yours is mustard.
- **They reach the team, and never wake anyone.** A reaction is recorded on the team's timeline
  against the moment, as a quiet kind that never wakes a seat and never counts as unread: a 🔥 must
  not cost a paid turn. *(cider's call.)* So:
  - /live shows them on the same moment (in the stream and as a small burst at the desk);
  - the seat that landed the lane sees them on its next turn, as an ambient line in its inbox
    ("nick 🔥 your lane 'For you shows only live asks'"), never as something it must answer;
  - the phone shows everyone's reactions, not only yours.
- From the phone a reaction is signed by the question key (silent, as quick actions are, ADR 791):
  no Face ID for a reaction.

## The same feel across the app

nick: "we can implement in other ways besides just live." The five qualities, applied elsewhere:

- **For you** (quality 3): your own lane landing or a verdict on your work rises here as a moment,
  not only asks.
- **Notifications** (qualities 1, 5): a lane you asked for (its `requested.by` names you) landing
  is a quiet notification ("cider landed 'For you shows only live asks'") with the four reactions as
  notification actions. Goals are not used for this: they carry no owner, and agents declare most of
  them. *(cider's call.)*
- **A member's sheet** (qualities 2, 5): the phase-2 nudge from the shell design (the one action
  that fits the moment, with its reason), their lanes landed today, and the chat.
- **Chat** (quality 2), from the shell design's phase 3, moves here: the "Say something to the team"
  box under the floor posts a team message, and people's team messages appear as one-line moments in
  the feed, so the room's talk is part of the floor; a reply addressed to you lands in your chat with
  that member. A member's sheet opens a chat with that member; the thread holds everything between
  you and them from any surface. *(cider's call.)*
- **Work** (quality 3): goals as score cards at the top (from direction B), each with what landed
  today; tapping one opens its lanes.
- **Pull to refresh, tab switches, sheets**: unchanged springs; the landing glow and the bell are the
  only new motion.

## Decisions this needs (each its own ADR)

1. **Moments on the roster** (protocol + daemon): the roster carries the day's moments (landings,
   goals, verdicts on the viewer's lanes, starts, polls), each `{id, kind, member, lane?, goal?, ts,
   reactions}`, through the ADR 407 read scope like the asks.
2. **The reaction act** (protocol): how a reaction is recorded on the timeline (an act or a `meta`
   on a message, its target, idempotent per person and kind, retractable), how /live and a seat's
   inbox read it, and the phone's signed `reaction` callback.
3. **Watching** (daemon): signed-in people with the app's Now in front (its roster pull is the
   heartbeat) or a signed-in /live tab open, as a short-lived presence that never makes a person look
   "working". Public and broadcast tabs do not count. *(cider's call.)*
4. **Nudges and chat**, from the shell design's decisions 3 and 4, unchanged in substance.
5. **The live nudge** (protocol + daemon + relay, amends ADR 814 decision 4): a content-free silent
   push on a landing or a goal finishing, throttled and coalesced, that makes a foreground Now pull.
   The roster itself stays pulled.
6. **The floor** needs no other new wire: it draws from `members` and moments.

## Order of work

1. **The floor and moments, read-only**: decisions 1 and 5, then the floor and the feed on the
   phone, with the glow and the bell. Shippable alone: the app feels alive before anything is
   interactive.
2. **Reactions**: decision 2, the phone's reaction bar and notification actions, /live's display,
   the seat's inbox line.
3. **Chat and nudges**: decision 4, the box under the floor and the member sheet.
4. **Watching**: decision 3.
5. **Work's score cards.**

Each phase ends with a TestFlight build and nick's feel pass on the phone, as phase 1 did.

## Left to the builder

- The floor's exact layout of desks for 1–8 members, the bubble wording rules, and the glow and bell
  animations, within the motion budget above.
- How moments are bounded (count, window) within the relay's frame size.
- How /live shows a reaction burst at a desk.
- Empty floor (nobody here): a quiet room, in the app's voice.
