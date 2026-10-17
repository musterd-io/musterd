# 639 — unpriced_wake_cap is a display-only team policy key

- Status: accepted
- Date: 2026-10-17
- Lane: `01M50M8W8FJ5EQ15RF934F6BHS`
- Builds on: [the unpriced-floor spec](../superpowers/specs/2026-10-15-spend-unpriced-floor-design.md) (lane `01M4SB4D7RTW21W62NKCPDV816`). Nick chose option C on 2026-10-17, in words to alfie: "okay lets go with your recommendation". Ask `01M50H0C2E` (2026-10-15) was an empty Approve and selected no option.

## Context

Leases that report no positive cost sit outside `spend_cap_usd`. The spec's option C adds one team number, `unpriced_wake_cap`, beside that dollar cap. Unset keeps today's behavior. `0` blocks unpriced harnesses. N lets N unpriced wakes through per 7 days. Nick chose that shape, plus one notice that names both caps when both trip. This record is the key and the report line. The notice is lane `01M50M90ST4TQWKEBP5TQ56V0B`.

`GET /policy` is admin-only. The report is team-readable. A policy fetch at render time would hide the cap from every non-admin.

`spend_approval_usd` does not cover this. That ask runs on the gateway's running cost. An unpriced wake never raises it.

The key ships unset. This record sets no number on the revive team.

## Problem

Without a stored key, the notice lane has nothing to read, and the team cannot see a count an admin chose. A default of 0 would block unpriced harnesses on every team. Counting only `unpriced_sessions` would leave a wake that settled with no session token outside the number. Treating a printed `cost_usd` of 0 as priced would do the same (ADR 236). Comparing the count with `>` would let the Nth unpriced wake through and would leave a cap of 0 quiet.

## Decision

1. `PolicySchema` gains `unpriced_wake_cap`: an integer from 0 through `UNPRICED_WAKE_CAP_MAX` (10_000), optional, no default. 0 is a real cap. Negatives, non-integers, NaN, Infinity, and values above the ceiling are rejected. `getPolicy` does not invent a number. `unpricedWakeCap` returns null for absence and returns 0 for a stored 0. `sparsifyPolicy` keeps both, because the key has no schema default.

2. The count is unique by `lease_id` over the same 7-day wake audit rows the dollar cap reads. A lease counts when no row has `cost_usd > 0` and either some row has `session_captured`, or the lease settled. Settled means `wake_failed`, `wake_cost`, `wake_exhausted`, or `wake_report_rejected`, or a `woke` row whose `cost_usd` is present, or any row whose `cost_usd` is 0. An in-flight `woke` with no cost and no session token does not count. `wake_deferred` does not count. A row with no `lease_id` is skipped. `unpriced_sessions` stays the narrower ADR 252 floor and is not rewritten.

3. Over means `count >= cap`, the same equality ADR 602 uses for the dollar cap. A cap of 0 with a count of 0 is over. A missing cap is not over.

4. `deriveReport` copies `unpriced_wake_cap`, `unpriced_wake_count`, and `unpriced_over_cap` onto `wake` only when the key is set. The count is read then, from those audit rows. When the key is unset, all three fields are omitted, so the report JSON matches a report from before this field. `deriveWakeMetrics` does not read the key.

5. The CLI report prints `unpriced wakes N · cap N OVER|under · display only` when the key is set, on a quiet window and on an active one. OVER uses the warn state. The line does not say `agent wakes held`. The ADR 252 unpriced-sessions sentence is unchanged. `musterd report residency` uses the same renderer. The MCP report digest prints the same words, without color, and a quiet window that has only this key still prints the line. _(Amended 2026-10-17: ADR 641 drops `display only`. A count at or over the cap adds `agent wakes held` on that line, unless the dollar cap is also over, in which case one following line names both caps, each total, and the window. See ADR 641.)_

6. `musterd team policy --unpriced-wake-cap <n|off>` is the human write path, the same read-merge-write `POST /policy` as the other knobs. `off` deletes the key. The policy view always shows the line: `unset`, or `N wakes / 7d`. It does not say `default`. Absence is not a shipped number.

7. No feature-epoch bump. The fields are optional. An older client strips them. An older daemon omits them. No new audit action. A set or cleared cap is the existing `policy.change` row, and the stored detail is the sparse doc.

8. Nothing is denied. _(Amended 2026-10-17: ADR 641 holds new non-human wakes on the wake-lease poll when the key is set. A human still passes. See ADR 641.)_ Lane `01M50M90ST4TQWKEBP5TQ56V0B` is the deny path and the one notice that names each cap, its total, and the window when both trip.

9. A count is coarse. It cannot tell a cheap Codex wake from an expensive one, and a crashed wake that never reported sits in the same count. The number is a count bound.

## Consequences

- An admin sets one integer, or leaves the key absent. The report shows the count beside the cap and says nothing is denied.
- _(2026-10-17.)_ [ADR 641](641-unpriced-wake-cap-holds-wakes.md) holds new agent wakes when the key is set. The report line drops `display only`. When only the count is over, the line says `agent wakes held`. When both caps are over, one following line names each cap, its total, and the window.
- The dollar-cap line and the approval line are unchanged. Setting this key does not move `spend_over_cap`.
- The policy view gains one line on every team. The report text and the report JSON do not, until a cap is set.
- A cap of 0 on a quiet window prints OVER. Decision 3 is the comparison the deny path reads.
- `unpriced_sessions` can be smaller than `unpriced_wake_count`. The sessions number still counts only a captured lease with no cost row. The cap count also includes a settled lease with no positive cost, including a printed 0.

## Observability & Evaluation

- **Traces:** a set or cleared cap is the existing `policy.change` audit row. No new audit action. No new trace event.
- **Eval:** the protocol accepts 0 and 10_000, rejects -1, 1.5, NaN, Infinity, and 10_001, and `parse({})` leaves the key unset. `sparsifyPolicy` keeps 0. The report omits the three fields when the key is unset. With the cap set, a captured unpriced lease, a settled lease with no cost, and a printed 0 each count once; a positive cost, an in-flight `woke`, and a deferral do not. Count 3 against cap 2 and against cap 3 is over; against cap 4 it is under. Cap 0 with count 0 is over. `deriveWakeMetrics` does not carry the fields. The CLI line contains `display only` and does not contain `agent wakes held`. _(2026-10-17: that line assertion is the display commit. ADR 641's tests expect the hold words.)_
- **Experiment:** none. Whether a team sets a number, and whether the count changes what it spends, is outside this decision. The deny path is lane `01M50M90ST4TQWKEBP5TQ56V0B`.
