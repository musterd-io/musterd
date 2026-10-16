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

Lane 01M46GR8AC, the ADR 511 re-measure. The window starts 2026-10-09, so every row is after #2081
(merged 2026-10-05). There is more than one daemon ledger. Each machine's `~/.musterd/musterd.db`
holds only the seats that daemon served, so a run is only comparable with a run on the same
ledger. Two ledgers were read on 2026-10-16, and both are recorded below.

**Ledger A: the daemon behind the revive workspace (mason's host).**
`pnpm delivery:measure --days 7`, re-run at 2026-10-16 ~18:45 PDT. The first read, at 18:20, gave 148 / 148 / 114 / 85,
with the same remainder of 29. The window slides, so a later run moves by a few rows. Output as
printed, with the home directory shortened to `~`:

```text
db ~/.musterd/musterd.db  ·  last 7d
baseline (2026-10-02): 279 acts — 141 <30s, 110 30s–5m, 23 5m–1h, 5 >1h; 311 refusals vs 352 raises, every seat

145 acts first-raised · 145 raise rows · 115 refused probes (86 not joined yet — outside the deaf ratio, ADR 511)

1+3. send → first raise, per rail (latency to the recipient’s next boundary; the
     >5m buckets are the idle-at-prompt wait the deferral trades against)
  claude-code    68 acts · p50 6s · p95 9.4m · 79% under 30s   [<30s 54 · 30s–5m 5 · 5m–1h 8 · >1h 1]
  (none)         33 acts · p50 15s · p95 63.9m · 64% under 30s   [<30s 21 · 30s–5m 7 · 5m–1h 3 · >1h 2]
  opencode       23 acts · p50 3.5m · p95 19.7m · 26% under 30s   [<30s 6 · 30s–5m 8 · 5m–1h 9 · >1h 0]
  grok           21 acts · p50 1.4m · p95 21.6m · 19% under 30s   [<30s 4 · 30s–5m 12 · 5m–1h 4 · >1h 1]

2.   deaf seats — refused probes (a live session whose bell is off), beside raises
  ryder        27 refused ·   29 raised   lease: dead 27   reason: not_joined 21, presence_released 4, expired 1, unknown 1
  dreamy       18 refused ·   25 raised   lease: dead 18   reason: unknown 3, not_joined 11, presence_released 4
  lazara       17 refused ·   30 raised   lease: dead 17   reason: not_joined 14, presence_released 2, expired 1
  sloane       17 refused ·   17 raised   lease: dead 17   reason: not_joined 15, presence_released 1, expired 1
  gptbot       14 refused ·   15 raised   lease: dead 14   reason: not_joined 14
  slippy       12 refused ·    7 raised   lease: dead 12   reason: not_joined 7, expired 5
  TJ           10 refused ·    8 raised   lease: dead 10   reason: unknown 1, presence_released 1, not_joined 4, expired 4

VERDICT: HOLD the attended deferral at 10 min — claude-code: p95 563s with 79% under 30s; (none): p95 3831s with 64% under 30s; opencode: p95 1182s with 26% under 30s; grok: p95 1297s with 19% under 30s
```

On ledger A, 115 − 86 `not_joined` leaves a remainder of **29, which is 20% of 145 raises**. That
is under the 25% gate. By reason, the remainder is `presence_released` 12, `expired` 12 and
`unknown` 5. `--days 4` (2026-10-12 on) reads the same way: 101 refused, 72 `not_joined`, a
remainder of 29 against 127 raises (23%), and `unknown` 5.

**Ledger B: wanderer's daemon.** wanderer ran `pnpm delivery:measure --days 7` on that machine's
`~/.musterd/musterd.db` just after #2746 merged. It reported 202 acts first-raised, 204 raise rows
and 247 refused probes, 212 of them `not_joined`. The remainder is **35, about 17% of raises**, and
`unknown` is 10. The refused seats are big-body, alfie, izzo, miley, ghost, wanderer, dolly,
grokbot, fifty, stanley, wallow and schmidt. On ledger B, ryder has 45 refused rows, all older than
7 days. That is why the two seat lists do not overlap. wanderer quoted these totals, not the full
printed table, so the full breakdown by reason is not recorded here.

Reading it: ADR 511's prediction holds on both ledgers. `not_joined` dominates, and the remainder
is under the gate (20% on A, 17% on B). On ledger A, `unknown` is the smallest reason (5 of 29), so
bindings are not missing live leases there and the falsifier did not fire. On ledger B, `unknown` is
10 of 35. Whether it is the largest reason there needs that ledger's per-reason lines. The verdict
still HOLDs, but only on criteria 1 and 3: on ledger A, opencode, grok and the untagged rows have a
p95 over 30 s with fewer than 80% of acts under 30 s. claude-code sits at 79%, one point short. The
deaf-seat criterion no longer holds the deferral.

On ledger A, the live remainder worth a look is `expired` on slippy (5) and TJ (4), and
`presence_released` on ryder and dreamy (4 each). Those are a lease renewal that never arrived and
a Presence let go under a running session, not a startup window.

Measured on two live ledgers (2026-10-16; falsify: on the same ledger, `pnpm delivery:measure --days 7` prints `unknown` as the largest non-`not_joined` reason, or a HOLD verdict naming refusals above 25% of raises). <!-- claim: other -->

## What this does not decide

The **causes** of the dead leases — session start mints no lease, `inbox --wait` takes the seat,
hours idle — are the deaf-seat follow-up (lane 01M402J3M7), measured against this baseline; the
`reason` field is what lets that lane attribute them from the next run on. Nothing here changes a
constant.

Related: [`authorised-but-unowned.md`](authorised-but-unowned.md) (the idle-lease trap),
[`claude-code-live-doorbell-eval.md`](claude-code-live-doorbell-eval.md) and the per-harness
doorbell evals (what each rail can reach).
