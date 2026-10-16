# 636 — the gateway holds one provider call at spend_approval_usd

- Status: accepted
- Date: 2026-10-16
- Lane: `01M531H8WGX270MZRR5KN08XPS`
- Builds on: [the spend-approval spec](../superpowers/specs/2026-10-16-spend-approval-threshold-design.md) (nick chose option A on 2026-10-16) and [ADR 635](635-spend-approval-display.md)

## Context

[ADR 635](635-spend-approval-display.md) stores `spend_approval_usd` and prints it on the report. Option A holds the next provider call when a non-human wake's gateway running cost reaches that number, and asks once for approval. The key is on main. This record is the hold.

`GET /policy` is admin-only. A host key receives 403. The team report is readable with the seat credential, and `wake.spend_approval_usd` is on it when an admin set the key.

## Problem

A stored threshold the gateway never reads leaves the wake running past the number an admin set. Reading it from `GET /policy` fails for the host. A refusal recorded as `budget_exhausted` would describe the seat budget, which is a different number. A second ask on every later call would repeat a decision the spec already made once per wake.

## Decision

1. The hold arms for `agent` and `service` only. A human passes. A missing kind, or a kind read that throws, arms nothing and logs `spend approval kind unread`. The wake then uses today's gateway.

2. The threshold is read once, at wake start, from `GET /report` with the seat credential (`wake.spend_approval_usd`). A missing credential, or a thrown read, logs `spend approval policy read failed` and starts today's gateway with no ask. A mid-wake policy change applies on the next wake. `--no-gateway` skips the kind read, the report read, and the gateway.

3. The budget gate stays first. The hold runs only when `spent >= spend_approval_usd` and `budget_usd` still allows the call. One shared promise covers the wake. Accept forwards the held call and every later call in the wake, with no second ask. Decline, and a wake that ends during the hold, answer 402 with code `musterd_spend_approval_declined`. Those refusals leave `budget_exhausted` false and leave `refused` unchanged.

4. One ask per wake: act `ask`, species `approve`, tier `blocking`. The body names the seat, the lease, the spent dollars, the threshold, and the lane when `lane_id` is set. The body carries no prompt and no provider payload. A `wait` extends the clock by `parseDuration`. The word `indefinite` extends by another blocking window. On the blocking timeout the seat sends `status_update` with `ask_outcome: held` and `ask_ref` (the server writes `ask.held`) and a `message` with the same body, then keeps the call held.

5. When the wake ends during the hold, `WakeCompletion.reason` is `wake ended during the spend approval hold`. The supplementary wake report copies `body.reason` onto the `residency.wake_cost` detail. No new audit action. Silence stays the existing `ask.held` row.

6. A gateway bypass (`--no-gateway`) and a gateway that fails to start record no ask. The callback runs only from the gateway.

7. Accept leaves `budget_usd` and `spend_cap_usd` unchanged. [ADR 611](611-spend-cap-holds-wakes.md) still withholds the next non-human lease when the team cap is spent.

8. While a call is held the request stays paused, so `Authorization` and the body stay unread. `close` aborts the hold's signal and waits for the callback to settle, so the 402 is written before the sockets are destroyed. The callback returns `wake_ended` when the signal aborts.

## Consequences

- [ADR 635](635-spend-approval-display.md) item 7 still says nothing is held. The amendment marker on that item points here. The report line still says `display only`. This lane leaves the report strings in place. The gateway reads the key from the team report.
- The host key cannot call `GET /policy`. The seat credential is the read.
- A human passes. An unreadable kind fails closed, with no ask.
- `ask.held` is silence. The wake-ended sentence is `detail.reason` on `residency.wake_cost`. When the primary report already carried `cost_usd` or `duration_ms`, the loop skips the supplement, and that sentence is absent from a second row.
- Accept leaves `spend_cap_usd` where it was and leaves a breach in place.

## Observability & Evaluation

- **Traces:** `ask.raised` carries species `approve` and tier `blocking`. Silence adds `ask.held`. A wake that ends during the hold adds `residency.wake_cost` with `detail.reason` set to the sentence above.
- **Eval:** the spec's testing bullets. Under the threshold, no ask. At the threshold, one ask, and a second call sends no further ask. Accept forwards. Decline answers 402 `musterd_spend_approval_declined` and forwards nothing further. Silence records `ask.held` and stays held. A human sends no ask. Accept leaves `budget_exhausted` false and leaves `budget_usd` unchanged. A bypass and a thrown policy read record no ask. Close during the hold puts the sentence on the supplement.
- **Experiment:** none. Whether a person accepts is the point of the ask.
