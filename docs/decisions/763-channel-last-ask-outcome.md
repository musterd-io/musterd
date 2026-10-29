# 763 — The protocol words an away channel's last ask

- Status: accepted
- Date: 2026-10-29

## Context

The app channel skipped an ask in five cases without any trace: delivery off, below the tier floor,
human present, no binding, relay down. On 2026-10-29 a test ask left no log line at all, and it took
reading the server code to see why (lane 01M64DSKT3). The daemon now records each outcome as a
`channel.ask_outcome` audit row and returns the latest one per channel as `lastAsk` on
`GET /channels/settings`. Two surfaces print it: `musterd notify channels` and /live's Away channels
block.

## Problem

The CLI and /live import only `@musterd/protocol` across package boundaries. If each wrote its own
sentence for the five reasons, the two would drift. Adding the wording to the protocol is a protocol
change, and that needs an ADR.

## Decision

`@musterd/protocol` gains `channelOutcome.ts`, exported from the barrel and from the zod-free
subpath `@musterd/protocol/channel-outcome`. It holds:

- `AskSkipReason`: `delivery_off`, `below_tier_floor`, `present`, `no_binding`,
  `relay_not_connected`.
- `LastAskOutcome`: `{at, ask, outcome: sent | skipped | failed, reason}`.
- `lastAskLine(last, now)`: the sentence, e.g. "last ask 2m ago: not sent — you were at your desk
  (Only while I'm away)", or null when no ask was routed there yet.

These are plain types and a formatter. No zod schema is added and no frame or envelope changes.
`lastAsk` is an additive field on an HTTP response the protocol does not schema, so an older
client ignores it, and an older daemon omits it, which both surfaces handle.

/live imports the subpath, as it already does for `approval-contracts`. The barrel would carry zod
into /live's bundle: the first push measured total JS at 410 KB against a 371 KB budget.

## Consequences

- Both surfaces say the same thing, and a new reason is worded in one place.
- The audit row is the record. Nothing new is stored, and there is no migration.
- A reason added on the daemon without a `WHY` entry would not type-check, so the wording cannot
  fall behind the cases.

## Observability & Evaluation

- **Traces:** `channel.ask_outcome` rows (target the human; detail channel, ask, outcome, reason)
  and the `away_app_skipped {reason}` log line.
- **Eval:** `channelOutcome.test.ts` covers every reason's wording. `appAdapter.test.ts` asserts the
  recorded outcomes for sent, delivery off and below the floor, and that a human who never paired a
  phone gets no rows.
- **Experiment:** n/a — wording and a record, not a tunable.
