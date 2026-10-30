# 772 — The phone keeps its own list of the asks that reached it

- Status: accepted
- Date: 2026-10-30

## Context

The app's asks list (lane 7h, `packages/mobile/src/native/asks.ts`) is read from Notification
Center. The extension admits a delivery and leaves a notification. The app reads every musterd
notification, takes each one's route (team, binding, ref, expiry) and fetches that ask through the
relay. The daemon answers only for an ask that is still open. Notification Center is the only
record on the phone of which asks reached it.

Lane `01M673P1E8` (#3631) clears a settled ask's notifications. nick (2026-10-30) also wants the
notifications of asks he has seen in the app to go, whether he answers them or not, the way Messages
and Slack clear a notification once you have read it in the app.

## Problem

Clearing the notification of an open ask also removes the only record that the ask reached the
phone, so the ask leaves the list. Tapping a notification already shows this: the tap removes the
notification, so the ask drops off the list (09-mobile.md, "A tap opens the ask").

Redelivery adds a second problem. Each time the app opens, it asks the daemon to re-push every
pending ask (ADR 676 decision 9). Each re-push arrives as a notification and goes back into
Notification Center. So a notification the app had cleared comes back every time the app opens.

## Decision

1. **The extension records the route of every ask it admits.** It writes `{team, binding, ref,
   expires_at, seen}` to a new keychain item, `ask-routes`, in the same service as the seen-nonce
   store (`dev.musterd.keys`, `AfterFirstUnlockThisDeviceOnly`). A record holds no body, no token
   and no signature, only what the notification payload already carries in clear. A re-push of a
   recorded ref updates `expires_at` and keeps `seen`. Expired records are pruned on every write,
   and the store holds at most 50, dropping the oldest first. If the write fails, the notification
   is still shown.
2. **The list reads that store and Notification Center together.** Their union covers
   notifications that arrived before this build. Each ref is still fetched live, so the daemon stays
   the source of truth. A ref the daemon calls gone leaves the store and Notification Center
   together.
3. **Seeing the list clears its notifications.** When the list renders while the app is active,
   every listed ask is marked `seen` in the store, and its notifications are removed from
   Notification Center. The ask stays in the list until it is settled.
4. **In front, the app does not re-add a seen ask.** While the app is open, `willPresent` shows
   nothing for a push whose ref is marked `seen`. For an unseen ref it shows a banner and plays a
   sound, but leaves the notification out of Notification Center, because the open list is about
   to show and mark it. This replaces #3579's rule, which decided "already seen" from Notification
   Center.

## Consequences

- An ask you have seen stays in the list and leaves Notification Center. Tapping a notification no
  longer takes its ask off the list.
- The phone now stores ask refs at rest: ids and routes, not content. They are readable only by the
  app and its extension, and only after the first unlock. The same fields already sit in clear in
  every notification payload.
- The app and the extension both read-modify-write `ask-routes`, and they can race. A lost record
  is restored by the next redelivery, which runs every time the app opens. No lock is added.
- When a record's `expires_at` passes, the ask leaves the list until the next app open re-pushes
  it. That is the same window a missed push has today.
- `asks.ts`'s note "nothing here stores an ask" becomes "nothing here stores an ask's content";
  09-mobile.md is updated in the same change.

## Observability & Evaluation

n/a — no agent-facing behaviour changes. Unit tests cover the store's rules: the union, pruning,
the cap, `seen` surviving a re-push, and gone refs being forgotten. nick checks it on the TestFlight
build that carries it. The falsifier: an ask he has seen in the app is still in Notification Center
after the app has been closed and reopened, or it is missing from the list.
