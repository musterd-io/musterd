# Spend controls: approval above a threshold (design)

Lane `01M4SB4CJPTCSCYK3X8KGY2W33`. Fourth named follow-up in
[the spend-controls spec](2026-10-12-spend-controls-design.md). The parent keeps the team cap as
the aggregate bound and leaves this lane for a human approval when one wake gets expensive.
**Status: proposed.** The recommendation is option A. The decision is nick's.

The lane title says "costly acts". The spend this spec bounds is a wake's priced provider
calls. A protocol act is a different thing, and this document means the calls.

## The gap, measured from the code (checked 2026-10-16, read-only)

A set `spend_cap_usd` holds the next non-human wake once the 7-day priced total is over the
cap ([ADR 611](../../decisions/611-spend-cap-holds-wakes.md)). A lease already minted keeps
running. The parent spec says exactness would need a pre-authorization, and names this lane
as that follow-up.

The dollar is known in one place before the next call spends another one. The metering
gateway sums priced usage as responses pass and, once `budget_usd` is reached, refuses the
next request with 402 ([ADR 583](../../decisions/583-metering-gateway-not-a-loop.md)
Decision 4; `packages/cli/src/host/gateway.ts`). That refusal ends the call. It does not ask
anyone.

Two limits sit on that fact:

- Harnesses that bypass the gateway have no running dollar. ADR 583 Decision 2 records them
  unpriced, with a reason. ADR 583 Decision 7 leaves interactive sessions outside the gateway.
- `budget_usd` is a per-wake host bound. ADR 611 point 8 leaves it unenforced as a team
  control, and leaves the host-provision budget as a different number. The team cap does not
  read either one.

So a team can stop new wakes at a weekly total, and a host can stop one wake at its own
budget. Nothing asks an admin to let a single wake continue past a team threshold.

## Options

**A. One blocking approval per wake, at the gateway (recommended).** A new sparse policy
key, `spend_approval_usd`. When a non-human wake's gateway running cost reaches it, the host
holds the next provider call and sends one `ask`.

- **Unset means today's behaviour.** The gateway still enforces `budget_usd`. The approval
  path stays dead until an admin sets the key.
- **The ask is `species: approve`, `tier: blocking`.** ADR 147 defines `approve` as the admin
  gate for a costly action, and only `blocking` holds on silence. A lower tier would spend
  on silence, which removes the approval.
- **Routing stays ADR 147.** Admin humans receive it. `ask_fallback_to_nonadmin` is the
  existing fallback and this spec does not change it.
- **Accept** releases the held call and the rest of that wake. One ask per wake.
- **Decline** refuses later provider calls on that wake, with the gateway's existing 402
  shape and a distinct code `musterd_spend_approval_declined`. The wake can finish on what
  it already has.
- **Silence holds.** The seat records `ask.held` and re-notifies, per ADR 147. The call
  stays unforwarded. If the wake process ends during the hold, later calls are refused and
  the audit says the wake ended during the hold.
- **`wait`** extends the clock, as ADR 147 already specifies.
- **Humans pass.** The host arms the threshold only for a non-human seat. A human wake is
  unchanged. This matches ADR 611 point 4.
- **The team cap still holds new wakes.** An accept does not raise `spend_cap_usd` and does
  not clear a cap breach.
- **`budget_usd` still refuses on its own number.** The ask fires only when the approval
  threshold is reached and `budget_usd` still allows the next call. With `budget_usd` unset,
  the approval threshold is the only gateway gate.
- **The crossing call is already spent.** The gateway prices a call after the response
  (`gateway.ts`). The next call is the one that waits. That overshoot is the same kind the
  parent spec accepts for a lease minted under the cap.
- **The ask names dollars, the seat, and the lease.** It carries no prompt and no provider
  payload. The gateway still holds no credential (ADR 583 Decision 5). The host, which
  already has the seat, sends the ask and tells the gateway to wait.
- **Read at wake start.** A policy change mid-wake applies on the next wake.
- **Range.** The same bounds as `spend_cap_usd`: finite, greater than 0, at most
  `SPEND_CAP_USD_MAX` (`packages/protocol/src/credentials.ts`). Zero is rejected. Approving
  every wake with no observed dollar is a different control.

**B. Re-ask on every further multiple of the threshold in the same wake.** Same hold, same
tier, a new ask each time the running cost crosses another step. A $2 threshold on a long
wake becomes a series of blocking asks. Use this when one accept for the rest of the wake
is too wide.

**C. Hold the next wake from the previous wake's attested cost.** If the seat's last priced
wake cost is at or over the threshold, the wake-lease poll withholds the next non-human
lease and raises the same ask. This uses audit rows only, so it covers a harness the
gateway never priced. It approves the wake after the expensive one. The expensive wake has
already finished.

**D. Ask before every agent wake once the key is set.** The threshold would do no work.
Outside this lane.

## Recommendation

A. It asks about a dollar the gateway has already observed, and it stops the next provider
call. C asks about the following wake. B is A with an ask on every later step; the lane
asks for a threshold, and one accept covers the rest of that wake. The team cap remains
the aggregate bound.

A harness with no gateway dollar never raises this ask. That gap stays with the unpriced
floor ([2026-10-15-spend-unpriced-floor-design.md](2026-10-15-spend-unpriced-floor-design.md)).

## Delivery

1. This spec. It stays proposed until nick picks A, B, or C.
2. After that pick: the policy key and a report line when the key is set. No hold yet.
   The key is a protocol field, so the build lane writes its own ADR. Depends on this spec
   being accepted.
3. The hold, the ask, and the audit row, on the path the decision names. Depends on step 2.
   For A or B that path is the gateway. For C it is the wake-lease poll.

## Testing

- Unset matches today. A non-human wake under the threshold completes with no ask.
- At the threshold, the next provider call is not forwarded, one `ask` exists, and a second
  call in the same wake does not send a second ask (option A).
- Accept lets the held call through. Decline answers 402 with
  `musterd_spend_approval_declined` and forwards nothing further on that wake.
- Silence leaves the call held and records `ask.held`.
- A human wake at the same running cost sends no ask.
- A team over `spend_cap_usd` still withholds the next non-human lease after an accept on
  an earlier wake.
- A gateway bypass records no ask. A thrown policy read leaves the wake on today's gateway
  path and logs the failure.

## Out of scope

The parent spec's out-of-scope list holds, including payments and usage-based billing
(ADR 461). So does ADR 583 Decision 7 for interactive sessions. This spec does not price a
bypassed harness, does not change `budget_usd`, and does not add a per-seat team cap.
