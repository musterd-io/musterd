# 635 — spend_approval_usd is a display-only team policy key

- Status: accepted
- Date: 2026-10-16
- Lane: `01M531GZGV8WRTNXWM32SPACK3`
- Builds on: [the spend-approval spec](../superpowers/specs/2026-10-16-spend-approval-threshold-design.md) (lane `01M4SB4CJPTCSCYK3X8KGY2W33`, nick chose option A on 2026-10-16)

## Context

The spec adds one team number, `spend_approval_usd`, beside `spend_cap_usd`. Unset means today's gateway behavior. The number is a per-wake threshold on the gateway's running cost. Nick chose option A: one blocking approve ask per non-human wake when that running cost reaches the threshold. This record is the key and the report line. The hold is lane `01M531H8WGX270MZRR5KN08XPS` and is outside this decision.

`GET /policy` is admin-only. The report is team-readable. A policy fetch at render time would hide the threshold from every non-admin.

The bounds match `spend_cap_usd`: finite, greater than 0, at most `SPEND_CAP_USD_MAX`. Zero is rejected. Approving every wake with no observed dollar is a different control, and the spec leaves it out.

## Problem

Without a stored key, the hold lane has nothing to read, and the team cannot see the threshold an admin chose. A default of 0 would be a threshold nobody chose. Comparing the number to the 7-day `cost_usd_total` would describe the weekly cap, which is a different control.

## Decision

1. `PolicySchema` gains `spend_approval_usd`: finite, greater than 0, at most `SPEND_CAP_USD_MAX` (1_000_000), optional, no default. Cents are allowed. 0, negatives, NaN, Infinity, and values above the ceiling are rejected. The ceiling is the same fat-finger guard as ADR 602.

2. Unset is the absence of the key. `getPolicy` does not invent a number. `spendApprovalUsd` returns null for absence and never coerces it to 0. `sparsifyPolicy` keeps a value someone set, because the key has no schema default.

3. `deriveReport` copies the threshold onto `wake` only when it is set, as `spend_approval_usd`. There is no over flag. The 7-day total is the cap's comparison, and this key is a per-wake gateway threshold. When the key is unset, the field is omitted. `deriveWakeMetrics` does not read it.

4. The CLI report prints its own line when the key is set: `approval $N per wake · gateway running cost · display only`. A quiet window keeps the existing "no wakes" line and adds this line after the cap line, when a cap is also set. An unset key adds nothing. `musterd report residency` uses the same renderer. The MCP report digest prints the same words, without color, and adds nothing when the key is unset.

5. `musterd team policy --spend-approval <usd|off>` is the human write path, the same read-merge-write `POST /policy` as the other knobs. `off` deletes the key. The policy view says `unset` or `$N per wake at the gateway`. It does not say `default`: absence is not a shipped number.

6. No feature-epoch bump. The field is optional. An older client strips it. An older daemon omits it, and the newer client renders the report it already rendered.

7. Nothing is held. No gateway reads this key. Lane `01M531H8WGX270MZRR5KN08XPS` is the hold.

## Consequences

- _(2026-10-16)_ Reserved as 634 on draft PR #2757. Main took 634 for Cloud client admission (PR #2756) before this change landed, so this record is 635.
- An admin sets one number. The report shows it as a per-wake gateway threshold and says the hold is not on yet.
- The weekly cap line is unchanged. Setting this key does not move `spend_over_cap`.
- The policy view gains one line on every team, including a team with no threshold. The report text and the report JSON do not, until a threshold is set.
- A set or cleared threshold is the existing `policy.change` audit row. The stored detail is the sparse doc, so the key is on that row only when an admin set it.

## Observability & Evaluation

- **Traces:** a set or cleared threshold is the existing `policy.change` audit row. No new audit action.
- **Eval:** the protocol rejects 0, negatives, non-finite values, and values above 1_000_000, and `parse({})` leaves the key unset. The report omits `spend_approval_usd` when the key is unset and copies the number when it is set. The CLI report text contains no `approval $` until the key is set, then shows `display only`. `deriveWakeMetrics` does not carry the key.
- **Experiment:** none. Whether the line changes what a team spends is outside this decision. The hold lane is where a wake actually waits.
