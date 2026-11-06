# 814 — The app is the team on the phone; the roster carries /live's team and what waits on you

- Status: accepted
- Date: 2026-11-05
- Lane: `01M6Q58CFSNEX50G13ECNZ5C4F` (task 1 of
  [the phase 1 plan](../superpowers/plans/2026-11-05-app-shell-now.md)).
- Design: [the app shell design](../superpowers/specs/2026-11-05-app-shell-design.md), approved by
  nick on 2026-11-05.

## Context

[ADR 676](676-mobile-app-sealed-ask-client.md) carved the app down to two jobs: answer asks and be
the phone authenticator. Its Consequences say "a team view, `/live` on the phone, and the calendar
stay deferred". Since then the app grew a Seats screen ([ADR 791](791-phone-quick-actions-and-roster.md)),
quick actions, a seat's waiting line ([ADR 806](806-roster-seat-waiting-on.md)), portraits
([ADR 797](797-member-portraits-reach-the-phone.md)) and Twitch polls ([ADR 807](807-twitch-polls.md)),
each on its own ADR, each one more screen on a stack.

nick's use of the phone, 2026-11-05: a notification takes him into an ask; he opens the app to see
whether anything waits; and he wants to see who is on the team, agents and people, what they are
working on, and who is idle or offline, with actions that fit each one, the way `/live`'s team panel
shows it. He also wants goals, a few settings and a chat with a member there. The design doc above
settled the shape: three tabs (Now, Work, You), the Now screen first, the team as `/live` shows it.

What the phone receives today (ADR 791 decision 7) is a list of agent seats with `online`,
`wakeable` and one lane. `/live`'s team column (`packages/web/src/live/teamCards.ts`) reads a
member as one of six states (working, waiting for review, blocked, asking, between tasks, away)
with a label, the shown lane, its goal, since when, how many more lanes, and the model badge, and
sorts by that. People are in it. The phone cannot draw that from what it has.

## Problem

The app has no shell that can hold more than two screens, and the roster it pulls does not carry
what `/live`'s team panel shows. Without a decision the next screens pile onto the stack and the
phone invents its own states (the Seats screen's `online` / `asleep` / `offline` already differ
from `/live`'s words), which nick named as the thing to avoid: "let's not implement new conventions
for working, offline etc — align with what /live does".

## Decision

1. **The app's scope widens.** The app is the team on the phone: asks and questions, the team as
   `/live` shows it, goals and lanes, a few settings, and a chat with a member. It stays without the
   office scene, without Android and without the App Store (ADR 676 decision 11 stands). ADR 676's
   "a team view … stay deferred" is amended by a dated note; its Decision is unchanged.
2. **The roster delivery gains `members`.** Every standing member of the team, agent and human
   (not observers, not service seats), at most `APP_ROSTER_MAX`, each with `/live`'s card as
   `teamCards()` computes it: `state` (one of `working`, `review`, `blocked`, `asking`, `between`,
   `away`), `label` (the card's `stateLabel`, verbatim), `title` and `source` (the shown lane's
   title, or the member's own status), `goal` (the lane's goal name), `since`, `more_lanes`,
   `model` (the model badge's label), plus the seat fields the phone already uses: `online`,
   `wakeable`, `lane`, `portrait`, `waiting`. The daemon's fold is the same rule as `/live`'s, so
   the two never disagree on a member's state. `seats` stays as ADR 791 decision 7 has it, so a
   phone built before this decision keeps working; `members` is optional for the same reason.
3. **The roster gains `for_you`.** Everything waiting on the binding's person as `/live` counts it:
   the open asks addressed to them or to the team, and the open questions to them, oldest first,
   each as `{id, from, kind, summary, ts}` with `summary` at most 200 characters. At most 32. The
   phone's badge is the union of this list and the asks that reached it as pushes, by id, so the
   badge and `/live` agree even for an ask the hourly ceiling held (ADR 676 §8).
4. **The roster stays pulled, and the Now screen pulls it on a cadence.** On open, on
   pull-to-refresh, on any delivery, and every 30 seconds while the Now screen is in the foreground
   and the app is active. Never pushed (ADR 791, as amended 2026-11-03). The pull pauses while the
   ask screen is in front, because that screen holds a token of its own.
5. **The app's shell is three tabs under one floating pill: Now, Work, You.** Now holds what waits
   on you and the team; the Seats screen folds into it. Work holds goals and lanes, then the wiki.
   You holds the viewer's and the team's settings and the way to `/live`. A notification still opens
   its ask directly, over whichever tab was showing.

What each later phase needs on the wire (nudges, chat, goals, settings) is its own ADR; this one
decides the shell and the team.

## Consequences

- The daemon's roster read grows: it folds every member the way `/live` does, one more lane and
  question read per roster. The 30-second cadence from one phone is 120 roster pulls an hour while
  Now is open; a roster is sealed per binding, so the cost is per paired phone. If that shows in the
  daemon's CPU, the cadence lengthens before the fold is cached.
- The roster delivery can reach 64 members with 200-character summaries; it rides the relay's
  body-fetch path (ADR 676 §2), which has no push-size limit, and the phone already pulls it.
- An old phone (before this ADR) ignores `members` and `for_you` and keeps the Seats behaviour. An
  old daemon sends neither; the new phone falls back to `seats` for the team list and to its own
  pushed asks for the badge.
- `/live`'s `teamCards()` and the daemon's fold are two copies of one rule. The daemon's is the
  one with a test fixture per state; `/live` keeps its own because it folds client-side from the
  timeline. A state the two disagree on is a bug in whichever moved last.
- The phase 1 plan carries this into the protocol (task 2), the daemon (task 3) and the app
  (tasks 5 to 7).
- _(2026-11-06, lane `01M6Q58GSP66VKS1V08NHYNH42`.)_ Decisions 2 and 3's shapes are
  `AppMemberSchema` (with `APP_MEMBER_STATES`) and `AppForYouSchema` in `appChannel.ts`, optional
  on the roster delivery as `members` (at most `APP_ROSTER_MAX`) and `for_you` (at most
  `APP_FOR_YOU_MAX` 32, summaries at most `APP_FOR_YOU_SUMMARY_MAX` 200). SPEC A.33 says so.

## Observability & Evaluation

- Traces: the roster fetch is already audited as a sealed delivery (`auditSealed`). The phone's
  cadence adds no new event; the daemon's per-binding `roster` fetch count over an hour is the
  reading for the cost line above.
- Eval: n/a. Not agent-facing. Correctness is pinned by the schema round-trip (task 2), a daemon
  test fixture per `members` state and the sort (task 3), and the phone's `teamRows` tests (task 6).
- Experiment: falsified if a member `/live`'s team column shows in one state appears in another
  on the phone's Now screen after a pull, or if the phone's badge differs from `/live`'s "waiting
  on you" count for the same person at the same moment.
