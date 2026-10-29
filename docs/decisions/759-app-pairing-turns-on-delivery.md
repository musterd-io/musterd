# 759 — Confirming an app pairing turns its delivery on

- Status: accepted
- Date: 2026-10-29

## Context

The away-channels design (`docs/superpowers/specs/2026-10-15-away-channels-design.md`, Channel
settings) says that nothing is on by default. With no `member_channel_settings` row, a channel
neither delivers asks nor takes answers, and `store/channelSettings.ts` implements exactly that.

On 2026-10-29 nick paired a phone through the app channel. He scanned the QR and confirmed the
phone's key with his passkey (ADR 676 §5). The phone showed "Paired as nick.", and then no ask ever
reached it. Delivery was still off, and nothing said so. He found the toggle in `/live` only after
reading the server code (lane 01M64DSFZ4).

## Problem

For Slack, the rule is right: a binding there names a destination someone else may be able to
read, so a separate opt-in makes sense. For the app channel, the rule makes the human consent
twice. The pairing exists for one reason, which is to get asks on that phone. The human has already
approved it with their own passkey over the phone's key. After that, a second switch is a step
nobody expects, and missing it means losing asks without any sign.

## Decision

When the human confirms an **app** pairing, the daemon turns that channel's `deliver` and `answer`
on for them, in the same call as the confirmation.

- `presence_gating` and any `tier_floor` the human already set are kept. A first pairing gets the
  default, which is gating on, so the phone is pinged only while the human is away (ADR 155).
- The change is written through `setChannelSettings`, so it is audited as
  `channel.settings.changed` with the human as actor, right after `channel.app_paired`.
- Every other channel keeps "nothing is on by default". A Slack binding still needs its own opt-in.
- Turning either switch off afterwards works as before. A later re-pairing turns them on again,
  because re-pairing is a fresh consent.

## Consequences

- A freshly paired phone gets asks immediately, while the human is away.
- The design spec's "nothing is on by default" now has one exception, the app channel on confirm.
  The spec is a frozen design doc, so this ADR records the exception, and `03-server.md` states it.
- Someone who paired a phone and deliberately switched delivery off will find it on again if they
  pair again. That is the intended reading of re-pairing.

## Observability & Evaluation

- **Traces:** each confirmation now writes two audit rows, `channel.app_paired` followed by
  `channel.settings.changed` with `deliver: true, answer: true`.
- **Eval:** `store/appPairing.test.ts` asserts the settings after a confirmed pairing.
- **Experiment:** n/a — a consent rule, not a tunable.
