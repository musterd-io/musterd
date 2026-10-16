# Delivery measurement — the §5 read that governs the wake host's attended-session deferral

The reach-and-boundaries §5 criteria read from the ledger alone (`pnpm delivery:measure`), with the verdict rule and each dated run; the attended deferral stays at 10 minutes while the verdict reads HOLD. Since 2026-10-16 refusals are under the gate and the rail latencies are what hold it.

## What is measured, and from what

`interrupt.raised` carries the act id and the rail (harness); the act's `created_at` in `messages`
gives **send → first raise** per act, per rail — criterion 1 (mid-turn latency) and criterion 3
(idle-at-prompt wait) are the same distribution read twice. `interrupt.refused` is a live session
whose bell is off — a valid credential with a dead or missing lease — per seat; criterion 2 (no
deaf seats). Since lane 01M3TAKT16 (2026-10-03) the refused row also carries a `reason`:
`none_presented` (session start minted no lease), `revoked` (rotate, halt, a daemon bounce),
`expired` (the renewal never reached it), `presence_released`, or `unknown` (a token this daemon
never minted — a stale token after a reset).

Corrected 2026-10-05 ([ADR 511](../decisions/511-not-joined-is-not-deaf.md)): `unknown` was
mostly NOT a stale token. A lease row is deleted with its Presence, so a session start presenting
the previous session's lease found no row. All but one of the 27 refusals from 2026-10-03 to
2026-10-05 were that. They now read `not_joined` when no unheld Presence holds the seat, and the
verdict does not count them. `unknown` is kept for a lease the daemon cannot place while a Presence
does hold the seat. (Measured 2026-10-05; falsify: post-merge rows where `unknown` outnumbers
`not_joined`.)

The verdict rule lives in the script, so a run reads the same way whoever runs it: **HOLD** the
attended deferral while refusals exceed 25% of raises in the window, or any rail's p95 is over
30 s with fewer than 80% of its acts under 30 s. Shrinking is a lane with its own number, never this
script's output.

## Runs

Each run is dated, with the command, the table the script printed, and the verdict it gave.

### 2026-10-03 — 14 days: HOLD

`pnpm delivery:measure --days 14` on the laptop daemon's `~/.musterd/musterd.db`.

| rail          | acts | p50  | p95    | under 30 s | <30s | 30s–5m | 5m–1h | >1h |
| ------------- | ---- | ---- | ------ | ---------- | ---- | ------ | ----- | --- |
| (no rail tag) | 128  | 35 s | 21.0 m | 46%        | 59   | 57     | 12    | 0   |
| claude-code   | 105  | 24 s | 36.6 m | 51%        | 54   | 38     | 9     | 4   |
| grok          | 20   | 8 s  | 1.9 m  | 65%        | 13   | 7      | 0     | 0   |
| opencode      | 17   | 2 s  | 9.6 m  | 71%        | 12   | 4      | 1     | 0   |

270 acts first-raised, 346 raise rows, **316 refused probes** — refusals are 91% of raises, on
every seat (big-body 63, izzo 53, dolly 42, stanley 32, ryder 30, miley 23, fifty 20, ghost 16,
sloane 14, wanderer 8, schmidt 7, gptbot 3, grokbot 3, lazara 2). Every refusal's lease state was
`dead` but one (`missing`); none carried a reason yet — the rows predate the field.

Reading it: the p50s say the rails reach a busy seat within one boundary (claude-code 24 s, grok
8 s, opencode 2 s); the p95s and the 5m–1h buckets say the recipient was idle at the prompt, which
is the number the deferral trades against, not a rail defect. The verdict is HOLD on criterion 2
alone: a third of the team's probes in a fortnight were refused for a dead lease. The `(no rail
tag)` rows are raises written before the rail was stamped (ADR 423 inc 2) and are not a fifth
harness.

Measured on the live ledger (2026-10-03; falsify: `pnpm delivery:measure --days 14` prints a HOLD verdict naming refusals above 25% of raises; a clean read would print the criteria-read-clean line instead). <!-- claim: other -->

### 2026-10-16 — 7 days: HOLD on latency only, refusals under the gate

`pnpm delivery:measure --days 7` on the laptop daemon's `~/.musterd/musterd.db` (lane 01M46GR8AC,
the ADR 511 re-measure). The window starts 2026-10-09, so every row is after #2081 (merged
2026-10-05).

| rail          | acts | p50   | p95    | under 30 s | <30s | 30s–5m | 5m–1h | >1h |
| ------------- | ---- | ----- | ------ | ---------- | ---- | ------ | ----- | --- |
| claude-code   | 68   | 6 s   | 9.4 m  | 79%        | 54   | 5      | 8     | 1   |
| (no rail tag) | 37   | 20 s  | 63.9 m | 57%        | 21   | 11     | 3     | 2   |
| opencode      | 23   | 3.5 m | 19.7 m | 26%        | 6    | 8      | 9     | 0   |
| grok          | 20   | 1.4 m | 21.6 m | 20%        | 4    | 11     | 4     | 1   |

148 acts first-raised, 148 raise rows, 114 refused probes. 85 of them are `not_joined` (75%), so
the remainder is **29, which is 20% of raises**, under the 25% gate. By reason, the remainder is
`presence_released` 12, `expired` 12 and `unknown` 5. Per seat: ryder 27, dreamy 18, lazara 17,
sloane 17, gptbot 14, slippy 12, TJ 9. Every refused probe's lease state was `dead`.

Reading it: ADR 511's prediction holds. `not_joined` dominates, and `unknown` is the smallest
reason (5 of 114), so bindings are not missing live leases and the falsifier did not fire. The
verdict still HOLDs, but only on criteria 1 and 3: opencode, grok and the untagged rows have a p95
over 30 s with fewer than 80% of acts under 30 s. claude-code sits at 79%, one point short. The
deaf-seat criterion no longer holds the deferral. `--days 4` (2026-10-12 on) reads the same way:
100 refused, 71 `not_joined`, remainder 29 against 128 raises (23%), `unknown` 5.

The live remainder worth a look is `expired` on slippy (5) and TJ (4), and `presence_released` on
ryder and dreamy (4 each). Those are a lease renewal that never arrived and a Presence let go under
a running session, not a startup window.

Measured on the live ledger (2026-10-16; falsify: `pnpm delivery:measure --days 7` prints
`unknown` as the largest non-`not_joined` reason, or a HOLD verdict naming refusals above 25% of
raises). <!-- claim: other -->

## What this does not decide

The **causes** of the dead leases — session start mints no lease, `inbox --wait` takes the seat,
hours idle — are the deaf-seat follow-up (lane 01M402J3M7), measured against this baseline; the
`reason` field is what lets that lane attribute them from the next run on. Nothing here changes a
constant.

Related: [`authorised-but-unowned.md`](authorised-but-unowned.md) (the idle-lease trap),
[`claude-code-live-doorbell-eval.md`](claude-code-live-doorbell-eval.md) and the per-harness
doorbell evals (what each rail can reach).
