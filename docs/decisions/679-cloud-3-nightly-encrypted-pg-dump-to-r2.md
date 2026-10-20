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
- _(2026-10-20, lane `01M3Z42KWHFJJPKJRBH2FX5GMD`, nick's direction: the R2 bucket `musterd-cloud-backups` lives in the existing Cloudflare account behind a bucket-scoped R2 token rather than a second Cloudflare account; every object is gzipped and AES-256-GCM encrypted client-side with AAD bound to the object path (`teams/<slug>/coordination/<date>.json.gz.enc` kept 30d, `teams/<slug>/trace/<date>.json.gz.enc` kept 7d, `console/<date>.json.gz.enc` kept 30d without sessions/auth_transactions/rate_limits), plus optional full `pg_dump` archives under `pg_dump/` when `MUSTERD_BACKUP_PG_DUMP=1`.)_

## Observability & Evaluation

- **Traces:** `cloud_backup_completed` structured log line per run with `{ date, teams, uploaded, total_bytes, pruned }`.
- **Eval:** `packages/server/src/cloud/backup.test.ts` exercises `scripts/cloud/backup.mjs` end-to-end against PGlite + a local SigV4 R2 server (AES-256-GCM + AAD encryption, 30d/7d retention pruning, and `restoreSnapshot` onto a fresh database).
- **Experiment:** Falsify: `pnpm -C packages/server exec vitest run src/cloud/backup.test.ts` fails, or an uploaded object in R2 decodes without the key or survives past its 30d/7d retention window.