# 683 — /live is where a person sits, and what "multiplayer AI" may mean in our message

- Status: proposed (sloane's proposal for nick; nothing below is on any surface until nick accepts)
- Date: 2026-10-20
- Lane: `01M5D9SSDFR2WB2G7GCWV4GKHP` (goal `accountable-agents-positioning`)
- Amends: [ADR 578](578-the-office-and-knowledge-work.md) §1 (the office), if accepted. The claim stays
  [ADR 563](563-the-claim-is-the-team.md)'s and the supporting message stays
  [ADR 665](665-accountability-message-a-person-at-both-ends.md)'s.
- Relates to: [ADR 079](079-live-isometric-office.md), [ADR 104](104-work-items-board-insight-layer-web.md),
  [ADR 155](155-human-presence-ladder.md), [ADR 042](042-humans-multi-presence.md)

## Context

Every positioning decision so far argues the platform: agents join a team through the CLI and MCP, and
the record shows who did what. The UI appears as a picture. ADR 567 put the office in the hero, ADR 578
named the office, and the deck says "you can watch the office at work, at /live". No decision says what a
person gets from `/live`.

nick, in session with sloane on 2026-10-20, said `/live` lets them step out of the individual harness
sessions, where they miss things. From there they see what everyone is doing, and answer questions and
accept work from everyone in one place. That is one person's daily use on one team. It is the only evidence this ADR has for the value of
`/live`, and the copy below claims no more than what that person does.

Separately, "multiplayer AI" has become a category name. Y Combinator's Fall 2026 request for startups
(Aaron Epstein, read on ycombinator.com/rfs on 2026-10-20) says AI is still mostly single-player and asks for
AI where "anyone on a team should be able to drop into the same live agent session to watch it work,
redirect it, and hand it off." Vendor sources describe products doing this: Conductor's multiplayer cloud
workspaces (early access, July 2026), Zed, Slack-based agents, and several smaller products. Those pages
are written by competitors (AQ, Poly), so they are leads and not citations. The Multiplayer AI talk of
2026-10-01 used the phrase for what musterd does today: several people and agents as members of one team.

What `/live` does today, read from the code on 2026-10-20 (`origin/main` at `afb56949`; not every path exercised):

| A person can | Where it is |
| --- | --- |
| See every member's presence and work as one room | the office scene, `packages/web/src/live/OfficeScene.tsx` (ADR 079) |
| Answer an ask addressed to them without leaving the composer | `ComposerReplies.tsx`, `AsksStrip.tsx`, `AskChoices.tsx` (lane `01M4KY55N1`) |
| Write a sentence to the room and read each member's reply, with its model | `ComposerReplies.tsx` |
| Claim, start, block, hand off, confirm and send back a lane, where the rules allow | `boardWrite.ts` (ADR 104): only the owner moves an owned lane; the review queue is read-only, because acceptance is the acceptor's act |
| See who else is watching | **No.** Watching is anonymous. Only signing in as a seat attaches a human presence (ADR 155), so two people can watch and neither sees the other. |

The server already allows one human several live sessions (ADR 042).

## Problem

1. Should the message say what a person gets from `/live`, and in what words, without turning musterd into
   a dashboard product?
2. May we use "multiplayer AI", and what may it claim? The market's definition is one shared live session.
   Ours is one team. Saying yes to the phrase without the difference overclaims. Saying nothing leaves the
   best-known frame of the quarter to competitors.

## Decision

### 1. `/live` is named as the place a person sits

The sentence: **"From /live you see every member at work in one room, answer the questions waiting for you,
and write to any member."** It names three things the code does today (the table above) and no more.

- It ties to ADR 665: a person at both ends of every piece of work. `/live` is where the person at the
  end sits. The sentence does not say the person "holds the team accountable" until the record shows it
  (ADR 665 §3).
- It claims what a person can do, and no benefit. "You miss nothing" and "step back to a higher level" are
  nick's words for nick's use. They are not said as claims until a second person says them to us (hard rule 2,
  k of n, with consent).
- "Dashboard", "control plane" and "mission control" are not used. They name a feature any tool can ship. The
  room is ours: it draws members as a team (ADR 578 §1).

### 2. "Multiplayer AI" is used for the team sense, with the difference stated

- It may appear in the Q&A bank and in investor and event copy, where the room already uses the phrase.
  It stays out of the hero, the tagline and the subhead (ADR 563 stands).
- The standing answer, in nick's voice, replaces nothing and is added to the bank:

  > **Is this multiplayer AI?** Y Combinator's request describes it as anyone on a team dropping into the
  > same live agent session to watch it work, redirect it and hand it off. On musterd you drop into the team.
  > From /live you see every member at work, answer the questions waiting for you, write to any member and
  > hand a lane to someone else. People and agents are members of one team, each in their own session. One
  > shared session that several people steer together is not built. I would want a design partner to tell me
  > they need it first.

- "Shared session", "co-driving", "real-time collaboration" and "presence indicators" are not claimed. None
  exists. If a candidate below is built, the claim waits for the merged PR.

### 3. What is built next is a separate decision, and the evidence gate is written down

This ADR builds nothing. Two small candidates serve the message and neither is decided here, because each
needs the design role and ADR 155's phantom-person rule resolved first:

1. A "who is here" row on `/live` for signed-in humans.
2. A follow-a-seat view.

A shared, co-driven session is the large candidate. It waits until at least two design partners
ask for it, in writing, in their words (k of n, `references/research.md`), because the demand today is a
request from an accelerator and competitor blog posts. nick has had no design partner conversations as of
2026-10-20.

### 4. Where it lands, when accepted

| Surface | Change | Owner |
| --- | --- | --- |
| `docs/demo/pitch/script.md` page 5, last sentence | "And you can watch the office at work, at /live." becomes "And from /live you see every member at work in one room, answer the questions waiting for you, and write to any member." | sloane |
| `docs/demo/pitch/script.md` questions to expect | the Is-this-multiplayer-AI answer above, and a ledger row for the YC request (URL, read 2026-10-20) | sloane |
| `docs/demo/pitch/deck.html` slide 5 | the same sentence | sloane |
| `docs/design/homepage-copy-spec.md` §0c | the §1 sentence in its homepage form ("On your team, /live shows…"), under `StreamSection`; written, held until acceptance; miley builds | sloane writes, miley builds |

## Consequences

- A reader of the deck learns what the UI is for, in the words of what a person does there.
- The Q&A bank has a truthful answer to the question the market will ask us in the next quarter.
- We give up the hero word. If YC's frame becomes the category, a team-sense claim is a smaller story
  than a shared-session one, and the next competitor demo may out-shout it. The answer to that is the
  record we already have.
- The `/live` sentence rests on one person's use. A second person's account would let us say more.
  Follows-up: deferred — ask the first design partner, with consent, what they do on `/live` (2026-10-20)
- The vendor pages about Conductor, Zed and Slack are unverified leads. Before a competitor is named in
  public copy, the product's own page is read and a ledger row written.

## Observability & Evaluation

- **Traces:** n/a — a copy decision; no agent behaviour changes.
- **Eval:** the message test in `references/positioning-and-gtm.md`: show the §1 sentence and the §2 answer
  to the first design partners and record k of n who can say back what `/live` is for, in their words. Not
  run yet; no design partner has been spoken to.
- **Experiment:** none until a design partner exists. The gate in §3 is the experiment's trigger.
