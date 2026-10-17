# 641 — unpriced_wake_cap holds new agent wakes

- Status: accepted
- Date: 2026-10-17
- Lane: `01M50M90ST4TQWKEBP5TQ56V0B`
- Builds on: [ADR 639](639-unpriced-wake-cap-display.md), [ADR 611](611-spend-cap-holds-wakes.md)
- Supersedes: [ADR 639](639-unpriced-wake-cap-display.md) decision 5, the `display only` report line and the sentence that the line does not say `agent wakes held`, and decision 8's opening "Nothing is denied". The key, the count, and the report fields stay.

## Context

ADR 639 stores `unpriced_wake_cap` and prints the 7-day unpriced count beside it. Decision 8 of that record leaves the deny, and the notice that names both caps, to this lane. Nick chose option C on 2026-10-17, in words to alfie: "okay lets go with your recommendation". Ask `01M50H0C2E` (2026-10-15) was an empty Approve and selected no option.

Unset keeps today's behavior. `0` blocks unpriced harnesses. N lets N unpriced wakes through per 7 days, then denies. A human still passes. The hold ends when the rolling window falls under the cap. When the dollar cap and this count are both over, one notice names each cap, its total, and the window.

The count is the fold ADR 639 already defines: unique by `lease_id` over the 7-day wake audit, no positive `cost_usd`, and either `session_captured` or settled. A printed `cost_usd` of 0 counts (ADR 236). `unpriced_sessions` stays the narrower ADR 252 floor.

The key ships unset. This record sets no number on the revive team.

## Problem

A set cap changes the report and changes nothing a host can lease. An agent seat keeps receiving new wakes, including a dream and a provisioned first wake, after the 7-day unpriced count has reached the number the team set. Two separate hold phrases, one on each measurement line, would name that deny twice when both caps trip.

## Decision

1. The gate is the wake-lease poll, the same post as ADR 611. `POST /teams/:slug/residency/wake-leases` reads each cap once and passes both into `claimWakeLeases`. `POST /holds/check`, Gate A, and Gate B stay off this path.

2. `readSpendCapBreach` is unchanged. `readUnpricedWakeBreach` returns null when the cap is unset or when the count is under the cap. It returns the cap, the count, and the window when `count >= cap`, including `0 >= 0`. The count is `unpricedWakeCount`. A missing cap is not over.

3. Each reader has its own try. A throw logs `spend cap read failed open` or `unpriced wake cap read failed open`, and that reader returns null. The other reader still applies. An unset unpriced cap returns before the count scan. A set cap loads the wake audit again, separate from the dollar read. The poll's derivation also reads policy. That second scan is accepted.

4. While either breach is non-null, a seat whose `kind` is not `human` and whose plan is non-null gets that plan cleared after the plan is chosen. That includes a dream and a provisioned first wake. The plan is cleared before `writeSeatPass` mints a lease, so the nightly dream count, the hourly cap, and `first_wake_at` are not consumed. A human keeps the plan. A live lease is left in place. That in-flight lease is the overshoot ADR 611 accepts.

5. The deny is one `action.gate` row per seat per episode. `actor` is null, `target` is the seat, `result` is `deny`, and `outcome` is `denied_held`. The cause is `spend_cap` when only the dollar cap is over, `unpriced_wake_cap` when only the count is over, and `wake_spend` when both are over on that poll. The dollar-only detail stays the ADR 611 shape: `cap_usd`, `total_usd`, `window_days`, and the same reason string. The count-only detail is `{ cause: 'unpriced_wake_cap', outcome: 'denied_held', cap, count, window_days, reason }`, and the reason is `unpriced wake cap N: Nd unpriced wakes N is at the cap. New agent wakes are held. A human still passes.` The combined detail adds `unpriced_cap` and `unpriced_count` beside the dollar fields, and the reason names the window, the dollar cap and its total, and the unpriced cap and its count. The episode is open while the newest local row for that seat, among `action.gate` rows whose cause is one of those three and `residency.wake_leased` rows, is the gate row. A later lease closes it. A second poll in an open episode still withholds and does not append another row. A cap that starts tripping while the episode is already open for the other cause writes no second row. A raced double poll may write two rows. That is accepted.

6. The notice is the report, on the CLI and on the MCP digest. Under, the unpriced line is `unpriced wakes N · cap M under`. When only the count is over, that line adds `agent wakes held` and `window Nd`. When only the dollar cap is over, the cost line keeps ADR 611's `agent wakes held · window Nd`. When both are over, each measurement line names OVER and omits the hold phrase, and one following line reads `agent wakes held · window Nd · cap $X.XX total $Y.YY · unpriced wakes N cap M`. `agent wakes held` appears once. A quiet window whose priced total is null is not a dollar breach. A quiet window at cap 0 with count 0 is the single-cap unpriced notice. The ADR 252 unpriced-sessions sentence is unchanged. The ADR 635 approval line still says `display only`. The policy set hint says agent wakes are held when the 7-day count reaches the cap, and a human still passes. The off hint stays the ADR 639 sentence. The policy view stays `unset` or `N wakes / 7d`. No new protocol field. No feature-epoch bump. `action` is already an open string, and a set or cleared cap stays the existing `policy.change` row.

7. A count is coarse. It cannot tell a cheap Codex wake from an expensive one, and a crashed wake that never reported sits in the same count. The bound is the count. A dollar total is a different number.

8. The revive team keeps the key unset.

## Consequences

- An admin who set the key in ADR 639 now has that number enforced on new non-human wakes. A human still wakes. An unset key still denies nothing on this path.
- Cost or a zero-cost row that lands after a lease was minted can sit over the cap until that lease ends. The next poll then holds.
- The report notice names both caps when both are over, including while the open episode's audit row names only the cause that opened it.
- Files: `packages/server/src/protocol/gate.ts` (the second reader), `packages/server/src/transport/http.ts` (the poll passes both), `packages/server/src/store/residency.ts` (withhold and the three causes), `packages/cli/src/commands/report.ts` and `packages/mcp/src/tools/insights.ts` (the notice), `packages/cli/src/commands/team.ts` (the set hint). Protocol comments on the key name this record. No schema change.

## Observability & Evaluation

- **Traces:** `action.gate` rows with `detail.cause` `spend_cap`, `unpriced_wake_cap`, or `wake_spend`. One per seat per episode. The report line is the notice a person reads.
- **Eval:** cap 0 with count 0 gives the human a lease and the agent one `unpriced_wake_cap` row, and a second poll adds no row. Cap 1 with count 0 leases; after that lease is reported with `cost_usd` 0, the next poll denies and a second poll adds no row. An unset cap does not deny a zero-cost row. A positive cost does not spend the count. Both caps over write one `wake_spend` row whose detail carries the dollar fields and `unpriced_cap` / `unpriced_count`, and a second poll adds nothing. A live lease minted under the cap stays leased after a later zero-cost row, and no gate row is written while it is live. A thrown unpriced read returns null and logs `unpriced wake cap read failed open`. A dream at cap 0 gets no lease and does not spend the night. The CLI and MCP under line does not contain `display only` or `agent wakes held`. Cap 0 contains `OVER`, `agent wakes held`, and the window. When both caps are over, one line contains `agent wakes held` and names both numbers. The set hint says agent wakes are held and a human still passes. The approval line still contains `display only`.
- **Experiment:** none. Whether the hold changes what the team spends is the count the report already shows.
