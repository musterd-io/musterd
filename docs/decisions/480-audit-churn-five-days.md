# 480 — Audit churn window is 5 days: supersedes ADR 478 decision 1's 30-day figure

- Status: accepted — 2026-09-29 (nick, in session, on the first live pass's numbers)
- Date: 2026-09-29
- Lane: `01M3QS3HMCW2D74S7P01GMDKS2` (goal `cloud`) — the ADR 478 implementation lane, whose first
  live pass produced the numbers below
- Deciders: nick; fifty (guardian; ran the pass and put the choice)
- Supersedes: the "older than 30 days" figure in [ADR 478](478-local-store-retention.md) Decision 1.
  Everything else in ADR 478 — the two classes, the churn allow-list, the corpus-watermark gate, the
  archive-before-delete, the rows kept whatever their age, the trace window, `sync_log` untouched —
  stands unchanged.
- Relates to: [ADR 445](445-agent-traces-captured-local-first.md) (the watermark shape),
  [`docs/perf/local-store-footprint.md`](../perf/local-store-footprint.md) (the sizing this
  corrects)

## Context

ADR 478 set the churn window at 30 days from a sizing that counted `audit` rows older than 7 days
(212,337 of 333,596) and read them as old. The first live pass on nick's laptop (2026-09-29 17:28,
build `5526043`) archived **9,183 rows** — the whole over-30-day churn set. Bucketed by age on the
live store afterwards:

| churn rows aged | rows | ~row bytes |
| --- | --- | --- |
| 0–7 days | 118,727 | 21 MB |
| 7–14 days | 80,474 | 17 MB |
| 14–30 days | 102,542 | 21 MB |
| over 30 days | 6 | — |

The store began writing churn at today's rate in September; almost none of it is a month old. At
30 days the reaper frees under 1 MB today and settles `audit` at roughly a month of churn — a
steady state near today's size, not the reduction the laptop needs.

## Problem

The window is the only number in ADR 478 that decides how much disk the laptop gets back and when,
and the number was set from a misread of the age distribution. No daemon read depends on churn past
the two latest-per-seat rows ADR 478 already keeps (checked query by query there, pinned by
`auditReadersOfChurnActions`), so the window is a footprint choice, not a correctness one.

## Decision

1. **Churn-class `audit` rows are pruned when older than 5 days** (still: and below the corpus
   watermark on an archiving machine; still: archived before deletion; still: the kept rows of ADR
   478 §1 are kept). `AUDIT_CHURN_RETENTION_MS` defaults to 5 days; `MUSTERD_AUDIT_CHURN_RETENTION_MS`
   overrides it per daemon, as before.
2. **Nothing else moves.** Trace content stays at 7 days (ADR 478 §3); `sync_log` stays untouched
   (ADR 478 §2); the falsifiers of ADR 478 apply with the new figure substituted.

## Consequences

- ADR 478 Decision 1 carries a dated amendment marker pointing here; its text is otherwise
  unchanged.
- On the dev laptop the next pass takes ~183,000 rows (~60 MB with indexes, ~0.4 MB gzipped per
  10,000 rows in the archive); a pass is capped at 100,000 rows, so it completes over two daily
  passes or two `musterd store prune` runs. `musterd store compact` is worth running once after
  that — not before.
- The research corpus loses nothing on an archiving machine (watermark); on a machine that never
  snapshotted, churn between 5 and 30 days old now lives in `~/.musterd/archive/` rather than the
  live store — `corpus:snapshot --include-archive` captures it.
- A daemon reader that needs churn between 5 and 30 days old would be the falsifier; the source-scan
  test would fail its build first.

## Observability & Evaluation

- **Traces:** same as ADR 478 — one `store.pruned` audit row per team per pass, `/health`
  `db_bytes` / `archive_bytes`; nothing new is emitted.
- **Eval:** dataset = the dev laptop's live store (2026-09-29, 328,790 audit rows after the first
  pass); baseline = the bucket table above. Pass: after two passes and one `compact`, `musterd.db`
  minus `sync_log_bytes` is under 100 MB, and the server suite is green with the 5-day default.
- **Experiment:** 30 days on the dev laptop: daily growth of `musterd.db` minus `sync_log` under
  1 MB/day (ADR 478's bar, unchanged). Above it, the allow-list is leaking, not the window.
