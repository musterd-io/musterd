# 679 — Cloud 3 nightly encrypted pg_dump per team to R2

- Status: accepted
- Date: 2026-10-20
- Lane: `01M3Z42KWHFJJPKJRBH2FX5GMD`

## Context

Spec §7 + §4.8 backups row. Survives losing the Neon account. Separate Cloudflare account for R2 (human-gated: account creation). Encryption key held outside both Neon and the R2 account. Done when: a night's dumps for every team land in R2, encrypted, and expire on schedule.

## Problem

musterd Cloud stores team state in Neon Postgres. Losing the Neon account loses every team's data. The spec asks for a nightly encrypted `pg_dump` per team to Cloudflare R2 in a separate Cloudflare account, so a Neon outage or account compromise does not lose data.

## Decision

1. **`scripts/cloud/backup.mjs`** — a node script run as a one-shot machine (or cron) that, for each active team: runs `pg_dump` (custom format, encrypted at rest via AES-256-GCM with a key in `~/.musterd/cloud/backup.key`, chmod 600, never in Neon or the R2 account), uploads the encrypted dump to R2 under `<team>/<date>.dump.enc`, and prunes dumps older than 30 days (coordination) / 7 days (captured content, per §4.8).
2. **Retention:** coordination DB dumps kept 30 days; captured-content DB dumps kept 7 days (so "deleted content is gone from backups within 7 days" holds).
3. **Monthly restore drill:** the newest dump is restored onto a fresh database, the suite runs against it, and the result is recorded (increment 3's acceptance).
4. **No new runtime dependency** — uses `pg_dump` (already available where Postgres runs) and the Cloudflare R2 S3-compatible API via `fetch` with AWS SigV4.

## Consequences

- A Neon account loss no longer loses data: R2 holds 30 days of coordination dumps in a separate account.
- The encryption key is the single point of failure for recovery; it lives outside both Neon and R2, in `~/.musterd/cloud/backup.key` (mode 600), and is backed up by the operator.
- Retention is enforced by the script on each run; R2 lifecycle rules are a backup, not the primary mechanism.

## Observability & Evaluation

- **Traces:** `backup.started`, `backup.completed`, `backup.failed` audit rows per team per night, with `{ size_bytes, duration_ms, retention_pruned }`.
- **Eval:** `scripts/cloud/backup.mjs` runs end to end against a staging Neon branch and R2 bucket; the restore drill records a dated result in `docs/perf/` (or `docs/guides/cloud-ops.md`).
- **Experiment:** Falsify: a night's dumps for every team land in R2, encrypted, and expire on schedule; a restore onto a fresh database passes the suite.