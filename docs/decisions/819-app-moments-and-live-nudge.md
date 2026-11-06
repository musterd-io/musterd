# 819 — App moments and the live nudge: the roster carries the day's work, and a landing wakes a foreground phone

- Status: accepted
- Date: 2026-11-06
- Lane: `01M6SBV98SDFB9GE7W876GP4G5` (task 1 of
  [the alive phase 1 plan](../superpowers/plans/2026-11-06-app-alive-floor.md)).
- Design: [the app comes alive](../superpowers/specs/2026-11-06-app-alive-design.md), approved by
  nick on 2026-11-06 (decisions 1 and 5 there).
- Amends: [ADR 814](814-app-is-the-team-on-the-phone.md) decision 4 ("never pushed").

## Context

[ADR 814](814-app-is-the-team-on-the-phone.md) made the app the team on the phone: the roster
carries `members` and `for_you`, and Now pulls it every 30 seconds. nick on build 61: "Good
improvement … overall it still doesn't quite make me feel how I described." The apps he named
(Instagram, ESPN, Reddit, Twitch) give immediate gratification and a shared experience. He picked a
live floor at the top of Now, named a lane landing as the moment that matters most, and, offered a
30-second pull against a push that carries nothing, said "I like the snappier approach."

## Problem

Two things the phone cannot do today:

1. **Show what happened.** The roster says who is doing what now; it says nothing of what landed an
   hour ago. A feed of the day's work needs the daemon to fold it, through the same read scope the
   asks use, because the phone has no timeline.
2. **Show it while it happens.** A 30-second pull makes a landing arrive up to 30 seconds late, so
   the celebration lands after the moment. ADR 814 decision 4 says the roster is never pushed.

## Decision

1. **The roster gains optional `moments`.** Each is `{id, kind, member, lane, goal, text, accepted?,
   ts}`, with `kind` one of `landed`, `goal`, `verdict`, `started`, `poll`, `said` — the team's
   work, nothing else (no joins, no presence changes). At most 20, from local midnight on the
   daemon, newest first. They are read through the timeline's read scope at the binding person's
   grade ([ADR 407](407-visibility-is-team-wide-delivery-is-addressed.md)), as `for_you` is: a moment whose source act the person cannot
   read is not theirs. A landing is a lane reaching `done`, credited to its `owner_seat` — the event
   `/live` glows on — and `accepted` says whether a peer confirmed it. A roster without `moments`
   stays valid, so an older daemon and a newer phone agree.
2. **A landing or a finished goal sends the paired phone a silent push that carries nothing.** A new
   daemon→relay frame, `app_nudge {binding, push, dedupe_id}`, strict: no title, no names, no sealed
   body may ride it. The relay sends an APNs background push (`apns-push-type: background`,
   `apns-priority: 5`, body exactly `{"aps":{"content-available":1}}`, expiring after 60 s). The
   daemon sends one on a routed act whose `meta.lane_resolve.state` is `done` or that carries
   `meta.goal_outcome`.
3. **It is throttled.** Per binding, the first moment in a 5-second window sends; the rest of that
   window are coalesced into it, so a burst of merges is one push and one pull.
4. **The phone acts on it only in the foreground, by pulling.** If the app is active it pulls the
   roster at once; otherwise the push is dropped, and the next open pulls anyway. The roster itself
   is still only ever pulled: what changes is when.

## Consequences

- ADR 814 decision 4's "never pushed" now reads "never pushed as content": the nudge tells the phone
  to pull, nothing more. A dated marker sits beside it.
- The relay needs a deploy before any nudge reaches a phone. Until then the relay rejects the new
  frame and the 30-second pull carries on, so the order of rollout is free.
- The app gains `remote-notification` in `UIBackgroundModes`. iOS budgets background pushes and may
  drop some; the 30-second pull stays the floor, so a dropped nudge costs latency, not correctness.
- A burst still costs one pull per phone per 5 seconds; the roster fold is read-only and already
  bounded, so the daemon's cost per landing is the push plus that pull.
- Reactions (spec decision 2), chat, and watching are later ADRs; `moments` carries no `reactions`
  field yet.

## Observability & Evaluation

- Traces: the daemon audits `app.nudge {binding_id, coalesced}` per send or coalesce; the hourly
  count against landings is the reading for the throttle. The roster fetch stays audited as
  ADR 814 says.
- Eval: n/a. Not agent-facing. Correctness is pinned by the schema tests (the cap, the kinds, the
  strict nudge frame), a daemon fixture per moment kind and the read-scope case, the gate's coalesce
  tests, the relay's exact-request test, and the phone's `newLandings`/`glowQueue` tests.
- Experiment: falsified if, on a foreground phone with a deployed relay, a lane reaching `done`
  shows on Now more than 10 seconds after its audit row in the majority of nick's first week of
  landings, or if any nudge request carries more than `content-available`.
