# Delivery measurement — the §5 read that governs the wake host's attended-session deferral

The reach-and-boundaries §5 criteria read from the ledger alone (`pnpm delivery:measure`), with the verdict rule and each dated run; the attended deferral stays at 10 minutes until refusals fall.

## What is measured, and from what

`interrupt.raised` carries the act id and the rail (harness); the act's `created_at` in `messages`
gives **send → first raise** per act, per rail — criterion 1 (mid-turn latency) and criterion 3
(idle-at-prompt wait) are the same distribution read twice. `interrupt.refused` is a live session
whose bell is off — a valid credential with a dead or missing lease — per seat; criterion 2 (no
deaf seats). Since lane 01M3TAKT16 (2026-10-03) the refused row also carries a `reason`:
`none_presented` (session start minted no lease), `revoked` (rotate, halt, a daemon bounce),
`expired` (the renewal never reached it), `presence_released`, or `unknown` (a token this daemon
never minted — a stale token after a reset).

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

## What this does not decide

The **causes** of the dead leases — session start mints no lease, `inbox --wait` takes the seat,
hours idle — are the deaf-seat follow-up (lane 01M402J3M7), measured against this baseline; the
`reason` field is what lets that lane attribute them from the next run on. Nothing here changes a
constant.

Related: [`authorised-but-unowned.md`](authorised-but-unowned.md) (the idle-lease trap),
[`claude-code-live-doorbell-eval.md`](claude-code-live-doorbell-eval.md) and the per-harness
doorbell evals (what each rail can reach).
