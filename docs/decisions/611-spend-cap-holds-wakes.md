# 611 — spend cap holds new agent wakes

- Status: accepted
- Date: 2026-10-15
- Lane: `01M4SB4BZBQDHWFWH4RXBNR7CQ`
- Builds on: [ADR 602](602-spend-cap-display.md)

## Context

ADR 602 stores `spend_cap_usd` and shows it beside the report's 7-day priced total, `cost_usd_total`. Point 8 of that record says nothing is denied. The spend-controls spec's increment 2 is the deny: while that total is at or over the cap, agent actuation that would spend is held, a human still passes, the team sees a notice naming the cap, the total, and the window, and the hold ends on its own when the rolling window falls under.

The spend is a new wake lease. `POST /holds/check` denies a merge while `merges_paused` is set. A merge is not this spend, and a stored hold would need someone to clear it. The spec's recovery has no manual reset.

`deriveWakeMetrics` walks one message per woken act. ADR 576 moved that walk off the long transaction because it blocked the daemon. The host poll runs about every 10 seconds. Calling the whole function there would put the walk back on that path.

`insights.ts` imports `residency.ts`. Reading the cap from inside residency would cycle those modules.

## Problem

A set cap changes the report and changes nothing a host can lease. An agent seat keeps receiving new wakes, including a dream and a provisioned first wake, after the 7-day priced total has reached the number the team set.

## Decision

1. The gate is the wake-lease poll. `POST /teams/:slug/residency/wake-leases` reads the breach once and passes it into `claimWakeLeases`. It is not a check on `POST /holds/check`, and it is not Gate A or Gate B. Those gates see tool calls. Tool calls are not this spend.

2. `readSpendCapBreach` returns null when the cap is unset, when the priced total is null, or when the total is under the cap. It returns the cap, the total, and the window when `cost_usd_total >= spend_cap_usd`. Equality is over, the same comparison ADR 602 uses for `spend_over_cap`.

3. The total is `pricedWakeCostUsd`: the same lease-cost fold `deriveWakeMetrics` uses for `cost_usd_total`, from `WAKE_AUDIT_SQL`, and nothing else. A `residency.wake_cost` row wins over the primary report's field. Unpriced sessions stay out of the total.

4. While the breach is non-null, a seat whose `kind` is not `human` and whose plan is non-null gets that plan cleared after the plan is chosen. That includes a dream and a provisioned first wake. The plan is cleared before `writeSeatPass` mints a lease, so the nightly dream count, the hourly cap, and `first_wake_at` are not consumed. A human keeps the plan. A live lease is left in place. That in-flight lease is the overshoot the spec accepts.

5. The deny is one `action.gate` row per seat per episode. `actor` is null, `target` is the seat, `result` is `deny`, and `detail` is `{ cause: 'spend_cap', outcome: 'denied_held', cap_usd, total_usd, window_days, reason }`. The episode is open while the newest local row for that seat, among `action.gate` rows with `cause: 'spend_cap'` and `residency.wake_leased` rows, is the gate row. A later lease closes it. A second poll in an open episode still withholds and does not append another row. A raced double poll may write two rows. That is accepted.

6. The notice is the report's over line, on the CLI and on the MCP digest. When over, the line adds `agent wakes held` and `window Nd` between `OVER` and `measured wake cost, not payments`. Under, unset, and `no priced spend` stay as ADR 602 wrote them. No stored hold. No new protocol field. No feature-epoch bump. `action` is already an open string.

7. A throw from the cap read or the cost read is logged as `spend cap read failed open` and the poll proceeds with no breach. The reader does not throw.

8. The per-seat `budget_usd` report flag is not enforced. Payments are not intercepted. The host-provision budget is a different number and is not read here.

## Consequences

- An admin who set a cap in ADR 602 now has that number enforced on new non-human wakes. A human still wakes. An unset cap still denies nothing.
- Cost that lands after a lease was minted can sit over the cap until that lease ends. The next poll then holds. The test asserts the total is over the cap, not equal to it.
- Files outside the lane's listed scope: `packages/server/src/store/residency.ts` (apply the breach it is given), `packages/server/src/store/insights.ts` (the shared cost fold), `packages/cli/src/commands/report.ts` and `packages/mcp/src/tools/insights.ts` (the over line), `packages/cli/src/commands/team.ts` (the setter no longer says nothing is denied).
- Approvals for a costly act sit on lane `01M4SB4CJPTCSCYK3X8KGY2W33`. The unpriced floor sits on lane `01M4SB4D7RTW21W62NKCPDV816`.

Follows-up: 01M4SB4CJPTCSCYK3X8KGY2W33
Follows-up: 01M4SB4D7RTW21W62NKCPDV816

## Observability & Evaluation

- **Traces:** `action.gate` rows with `detail.cause` `spend_cap`. One per seat per episode. The report's over line is the notice a person reads.
- **Eval:** at the cap, a due agent gets no lease and one deny row, and a second poll adds no row. A human on the same poll still gets a lease. An unset cap and a null priced total do not deny. Aging the cost row out of the window restores the lease. A thrown read returns null. A dream and a provisioned first wake are withheld without spending the night or `first_wake_at`. A lease minted under the cap is still leased after a later cost row puts the total over the cap.
- **Experiment:** none. Whether the hold changes what the team spends is the number the report already shows.
