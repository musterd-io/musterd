# 786 — Audit folds host-key polling: one `bootstrap_credential.used` row per host per hour

- Status: accepted
- Date: 2026-11-02

## Context

Every request a `musterd host` loop authenticates with its host key writes a
`bootstrap_credential.used` audit row ([ADR 395](395-wake-actuator-host-credential.md) names it as
the trace of a successful wake-lease poll; [ADR 344](344-host-scoped-bootstrap-credentials.md)
shipped the row). The loop polls three endpoints — wake leases, the residency pull, provisions —
every 10 s, so one host is 1,100–1,400 rows an hour, every hour.

[ADR 478](478-local-store-retention.md) put the action in the churn class and
[ADR 480](480-audit-churn-five-days.md) set the window to five days, so the rows do leave. Measured
on `musterd-agent-delta-2`'s joiner store on 2026-11-02 (lane 01M6DAD44Z): 149,227 live
`bootstrap_credential.used` rows, every one under five days old, none older — 58% of the 257,890-row
`audit` table on a 2 GB machine; the archive grows ~1.3 MB a day of gzip for them; the WAL had
reached 127 MB between restarts. The prune is doing its job. The rows are the problem: 31,000 a day
that all say the same thing — this key, this host, still polling.

Nothing reads them individually. `recordBootstrapCredentialUse` stamps `first_used_at` on the
credential row itself, and that stamp — not the audit — is what cutover readiness reads
([ADR 350](350-retire-legacy-team-bootstrap-key.md)). The audit row's one reader is a human asking
"was this key used, for which host, when".

## Problem

A trace that is written once per request carries no more information than one written once per
window with a count, and costs a joiner 31k inserts, 31k archive lines and a WAL churn a day per
host. Dropping the row loses ADR 395's trace; keeping it per request keeps the bloat. The call
sites are four (`transport/http.ts` ×2, `transport/ws.ts`) and the same shape each time.

## Decision

1. **The fold lives in `appendAudit`**, not at the call sites. When the action is
   `bootstrap_credential.used` and the team already holds a locally written row for the same
   `target` (the credential id) whose `ts` is within the last hour
   (`HOST_KEY_USE_FOLD_WINDOW_MS`), that row takes the use: its `detail` gains `uses` (the count,
   starting at 2) and `last_ts` (this use's time). No row is inserted. The row's own `ts` stays
   the window's first use, so a window is one hour from the first use it recorded, and a
   credential writes at most 24 rows a day.
2. **Only local rows fold** (`origin_seq = 0`). A replicated row is a peer's fact and is never
   edited here (ADR 331's absence-vs-gap rule holds; the unique `(origin_node, origin_seq)` row
   stays what the peer wrote).
3. **The shape of a single use is unchanged.** A first use in a window is the same row as before
   — `{ use, target }` and no `uses` — so every existing reader and the archive format read as
   they did. `uses`/`last_ts` are additive.
4. **Nothing else folds.** The fold is keyed on the one action; a `bootstrap_credential.used` with
   no `target` is appended as-is. Any other churn action that wants the same treatment names
   itself here by amending this ADR, not by generalising the hook.
5. **Readers pin.** `auditReadersOfChurnActions` now reports `store/audit.ts` as a reader of
   `bootstrap_credential.used`; the pin in `retention.test.ts` records it, with the reason it is
   safe: the fold reads only the last hour, inside any retention window.

## Consequences

- A polling host writes ≤24 `bootstrap_credential.used` rows a day instead of ~31,000; the
  five-day live set per host falls from ~150k rows to ~120. The archive's monthly file shrinks by
  the same ratio. `recordBootstrapCredentialUse` and `first_used_at` are untouched.
- The WAL growth between restarts on delta-2 (127 MB) is not explained by this ADR; after this
  ships, a WAL that still grows points at checkpoint starvation from the read-only worker
  connections, and is its own lane. `musterd.db`'s 271 MB file does not shrink on its own: SQLite
  keeps the freed pages until `musterd store compact` (ADR 478 §4).
  Follows-up: deferred — delta-2's WAL above 50 MB a week after this ships (2026-11-02)
- A reader that counted rows to measure polling rate (none in the daemon; the census one-liners
  in the wiki) reads `SUM(json_extract(detail,'$.uses'))` with `COALESCE(…, 1)` from now on.
- ADR 395's Observability line ("`bootstrap_credential.used` … on a successful wake-lease poll")
  gets a dated note: on a successful poll *or* a count on the window's row.

## Observability & Evaluation

- **Traces:** the row itself — `detail.uses` and `detail.last_ts` on a folded row. `/health`'s
  store sizes and the daily `audit_churn_pruned` log line (`rows`) on a joiner show the drop.
- **Eval:** `store/auditFold.test.ts` — three uses in a window are one row with `uses: 3`; a
  second credential, a replicated row and a use past the window each start a new row; a use with
  no target is appended unchanged. The readers pin in `retention.test.ts` names `store/audit.ts`.
- **Experiment:** delta-2's next `audit_churn_pruned` lines after redeploy. Baseline 2026-11-02:
  9,687 rows pruned a day with 149k live `bootstrap_credential.used`. Pass: within six days of
  the redeploy the live count of that action on the machine is under 500 and the daily prune
  under 3,000 rows. Falsified if the live count stays above 10k — then the fold is not reaching
  the call sites (a path that appends without `appendAudit`), and this ADR's Decision 1 is wrong
  about where the fold belongs.
