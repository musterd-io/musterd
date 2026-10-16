# Spend controls: the unpriced floor (design)

Lane `01M4SB4D7RTW21W62NKCPDV816`. This is the fifth named follow-up in
[the spend-controls spec](2026-10-12-spend-controls-design.md). The gap it closes: leases that report
no cost burn free under `spend_cap_usd`. The lane brief says the answer is a product decision, not a
default, and has to be specced first. **Status: recommended. Ask `01M50H0C2E` (2026-10-15) was an
empty Approve. It selected no option. C remains the written recommendation.**

## The gap, measured from the code (checked 2026-10-15, read-only)

- The cap counts `cost_usd_total` from `deriveWakeMetrics`
  (`packages/server/src/store/insights.ts`), which sums `cost_usd` per lease and nothing else.
- `unpriced_sessions` sits beside it. That number counts wakes whose session attested an identity
  token (`session_captured`) and whose lease has no `cost_usd`. It is a floor by construction
  (ADR 252). A CLI too old to attest a token leaves nothing behind.
- There are two ways a wake ends up unpriced:
  1. **The harness prints no price it can attest.** Codex prints tokens only. Opencode prints a
     price the host cannot verify (ADR 364). These wakes carry `usage` and `unpriced_reason` on
     `residency.wake_cost`. Every one of them is unpriced, every time.
  2. **The wake never reported.** The lease expired, the run was killed, or the report was refused.
     There is no `wake_cost` row at all, so no tokens either.
- So under a set cap, a team running only codex or opencode seats has no bound at all. A team on
  the native or Claude harness is bounded, except for the wakes that fail to report.

## Options

**A. Keep today's behaviour and say so.** Unpriced wakes stay outside the cap. The cap surface states
the gap (ADR 602 already prints the unpriced line). This costs nothing. It also means a set cap does
not bound a codex team.

**B. Block unpriced wakes whenever a cap is set.** If `spend_cap_usd` is set, a wake on a harness that
cannot attest a price is denied. This bounds the gap fully, but it bundles two choices into one key.
An admin who wants a dollar bound on Claude seats loses every codex seat as a side effect.

**C. Bound unpriced wakes by count, with their own key (recommended).** A second sparse policy key,
`unpriced_wake_cap`, counts unpriced wakes over the same 7-day window and the same deny path as
`spend_cap_usd`:

- **Unset means today's behaviour.** Like the dollar cap, the enforcement path is dead code until an
  admin sets the key.
- **`0` blocks unpriced harnesses explicitly.** This is option B, but as a choice an admin makes per
  team rather than a product default.
- **N > 0 lets N unpriced wakes through per 7 days**, then denies agent actuation the way the dollar
  cap does. Humans pass, recovery is automatic and the audit row has the same shape.
- **What it counts:** `unpriced_sessions` plus the wakes that raised and settled with no
  `wake_cost` row. Counting only `unpriced_sessions` would let an old CLI through for free, which is
  the gap again.
- **Why a count and not tokens.** Tokens exist only for the first kind of unpriced wake, not for
  wakes that never reported. A count is defined for every wake. ADR 364 §4 also keeps dollar prices
  for third-party tokens out until there is an ADR with a host-owned table.

**D. Price third-party tokens from a host-owned table.** This would fold codex and opencode into
the dollar cap. ADR 364 §4 rejected doing that without its own ADR: it needs a table per provider and
model, a rule for models that aren't listed and a rule for subscription seats. It also still leaves
the wakes that never report unbounded. Out of scope here. If it ever lands, C still covers the
remainder.

## Recommendation

C. It turns "block unpriced harnesses" into an explicit per-team decision (`0`). It bounds every
kind of unpriced wake, including ones that never report. It adds no accounting: it reuses the
window, the deny path and the audit shape that increment 2 (`01M4SB4BZBQDHWFWH4RXBNR7CQ`, lazara,
active) is building.

## Record of the ask (2026-10-15)

Ask `01M50H0C2E` asked nick to pick among A–D, and whether a deny notice should name both caps.
The reply was an empty Approve. It selected no option. C remains the written recommendation: a
separate `unpriced_wake_cap` count key, unset keeping today's behaviour, `0` blocking unpriced
harnesses, and one notice naming both caps when both trip. The key and the deny path stay
unauthorized until nick picks in words.

## Delivery

The shape of recommendation C. Unauthorized until nick picks in words.

1. This spec.
2. The policy key `unpriced_wake_cap` (range 0..10000, unset by default). Report display next to the
   dollar cap, same warn state. No enforcement yet. Depends on spend-controls increment 1.
3. Enforcement on the increment-2 deny path. Depends on increment 2 landing.

## Testing

- Unset matches today byte-for-byte. `0` denies the first unpriced agent wake and lets humans
  through. N lets N through, then denies.
- A wake that settles with no `wake_cost` row counts. A wake with `harness_cost_usd: 0` counts
  (ADR 236: a printed zero is not an attested zero).
- A read failure on the enforcement path fails open to measuring, as in the parent spec.

## Out of scope

The parent spec's out-of-scope list holds. So does ADR 461: this meters operational cost and does
not price acts for billing.
