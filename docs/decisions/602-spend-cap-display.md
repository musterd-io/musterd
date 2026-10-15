# 602 — spend_cap_usd is a display-only team policy key

- Status: accepted
- Date: 2026-10-15
- Lane: `01M4S0WNZ5CM73HHKV4VAMTAQ3`
- Builds on: [the spend-controls spec](../superpowers/specs/2026-10-12-spend-controls-design.md) (lane `01M4RSW1D09R89RVSARG8PKXND`)

## Context

The spec asks for one team number, `spend_cap_usd`, beside `sponsored_agent_cap`. Unset means unbounded. The number it is compared to is the report's 7-day priced total, `cost_usd_total` from `deriveWakeMetrics`. This record is that key and the display. Enforcement is lane `01M4SB4BZBQDHWFWH4RXBNR7CQ` and is not decided here.

`GET /policy` is admin-only. The report is team-readable. Drawing the cap from a policy fetch would hide it from every non-admin, and a failed policy read would fail the report.

`sponsored_agent_cap` defaults to 3. A number here would be the wrong shape of default. The spec says a team that never chose a cap stays unbounded, and 0 would mean "no spend" to any reader that treats the field as a bound.

The spec names a validation range and does not pick the numbers.

## Problem

Without a stored key, the team cannot see a cap, and lane `01M4SB4BZBQDHWFWH4RXBNR7CQ` has nothing to read. A default of 0, or rendering the cap from the admin policy route, both miss the spec: the first is a bound nobody chose, the second is invisible to the team and can throw the report.

## Decision

1. `PolicySchema` gains `spend_cap_usd`: finite, greater than 0, at most `SPEND_CAP_USD_MAX` (1_000_000), optional, no default. Cents are allowed. 0, negatives, NaN, Infinity, and values above the ceiling are rejected. The ceiling is a fat-finger guard in the spirit of ADR 459's cap of 100, scaled to dollars.

2. Unset is the absence of the key. `getPolicy` does not invent a number. `spendCapUsd` returns null for absence and never coerces it to 0. `sparsifyPolicy` keeps a value someone set, because the key has no schema default.

3. `deriveReport` copies the cap onto `wake` only when it is set, as `spend_cap_usd` and `spend_over_cap`. `spend_over_cap` is true when `cost_usd_total` is a number and that number is at or above the cap. A null total is not over. When the cap is unset, both keys are omitted, so the report JSON matches a report from before this field.

4. `deriveWakeMetrics` does not read the cap. The per-seat `over_budget` flag is unchanged. It still means a wake passed the seat's own `budget_usd` report bound, and it still stops nothing.

5. The CLI report prints the cap beside the 7-day total. At or over the cap: `OVER`. Below it: `under`. A null total: `no priced spend`, which is not a warn. The line says the figure is measured wake cost, not payments. A quiet window with a cap set keeps the existing "no wakes" line and adds the cap line after it. A quiet window with no cap stays that one line. `musterd report residency` uses the same renderer. The MCP report digest prints the same words, without color, and adds nothing when the cap is unset. _(Amended 2026-10-15: when the line says OVER, [ADR 611](611-spend-cap-holds-wakes.md) also prints `agent wakes held` and names the window. Under, unset, and `no priced spend` stay as written here.)_

6. `musterd team policy --spend-cap <usd|off>` is the human write path, the same read-merge-write `POST /policy` as the other knobs. `off` deletes the key. The policy view says `unset (unbounded)` or `$N of measured wake cost, 7d`. It does not say `default`: absence is not a shipped number.

7. No feature-epoch bump. The fields are optional. An older client strips them. An older daemon omits them, and the newer client renders the report it already rendered.

8. Nothing is denied. No gate reads this key. _(Amended 2026-10-15: [ADR 611](611-spend-cap-holds-wakes.md) is the gate. This point stands for the key and the display shipped here.)_

## Consequences

- An admin sets one number. The report shows it next to the 7-day priced total and says when that total is at or over the cap.
- Unpriced wakes stay outside the total. The existing unpriced line is that statement. The cap line does not invent a dollar figure for them.
- Cost that arrives after the wakes that spent it can sit under the cap until the report lands. The spec accepts that overshoot. This record does not close it.
- The policy view gains one line on every team, including a team with no cap. The report text and the report JSON do not, until a cap is set.
- _(2026-10-15)_ [ADR 611](611-spend-cap-holds-wakes.md) holds new agent wakes while the 7-day priced total is at or over the cap. The over line names that hold. Humans still pass. Unset still denies nothing.
- Files past the lane's listed three: `packages/protocol/src/insights.ts` (the report fields), `packages/server/src/store/insights.ts` (attach them in `deriveReport`), `packages/cli/src/commands/team.ts` (the flag), `packages/mcp/src/tools/insights.ts` (the same words on the digest). The report is where a non-admin reads the cap. The flag is how a human sets it.

## Observability & Evaluation

- **Traces:** a set or cleared cap is the existing `policy.change` audit row. The stored detail is the sparse doc, so the key is on that row only when an admin set it. No new audit action.
- **Eval:** the protocol rejects 0, negatives, non-finite values, and values above 1_000_000, and `parse({})` leaves the key unset. The report omits `spend_cap_usd` when the cap is unset and sets `spend_over_cap` from the priced total when it is set. The CLI report text contains no `cap $` until a cap is set, then shows `OVER`, `under`, or `no priced spend`.
- **Experiment:** none. Whether showing the number changes what the team spends is a question for lane `01M4SB4BZBQDHWFWH4RXBNR7CQ`, which is outside this decision.
