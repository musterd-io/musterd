# Cloud 3 Restore Drill — R2 Encrypted Backups onto Fresh Postgres

- **Date:** 2026-10-20 · **Lane:** `01M3Z4408C3T72EY3H92JQST01` · **Refs:** ADR 679, Cloud spec §7 ("A backup nobody has restored is a guess.")
- **Source bucket:** `musterd-cloud-backups` in Cloudflare R2 (`teams/revive/coordination/2026-10-20.json.gz.enc` + `teams/revive/trace/2026-10-20.json.gz.enc`)
- **Target database:** Fresh temporary Postgres 17.11 databases `musterd_drill_mvh0ztnr` and `musterd_drill_mvh0ztnr_trace` on Neon (`aws-us-east-1`), migrated from scratch with `migratePostgres` (v118) and `migrateTracePostgres` (v4), then dropped after verification.
- **Command:** `node scripts/cloud/drill.mjs --wrangler`

## Procedure

1. **Discover newest complete backup pair per team in R2:** `selectNewestTeamDumps` lists `teams/` in `musterd-cloud-backups` and selects the latest date with both a `coordination` and a `trace` object (`2026-10-20` for `revive`).
2. **Download and authenticate ciphertext:** Fetches both objects from R2 and runs `decryptDump(blob, key, objectKey)`, checking the `MSB1` magic header, AES-256-GCM authentication tag, and AAD bound to the exact R2 object path before gunzipping.
3. **Provision and migrate fresh databases:** Creates `musterd_drill_<id>` and `musterd_drill_<id>_trace`, runs `migratePostgres` (baseline v80 + ladder v81–v118) and `migrateTracePostgres` (baseline v3 + ladder v4), and grants `musterd_app` and `musterd_operator` to the login users.
4. **Restore and verify under tenant-scoped RLS:** `restoreSnapshot` loads all 54 team-owned tables inside a single transaction (ordering `teams` → `members` → `goals` → dependent tables with `SAVEPOINT` passes, skipping `GENERATED ALWAYS` columns `insights.tsv` and `messages.in_reply_to`). The drill then queries through `mainDriver.forTeam(team.id)` (`musterd_app` role, RLS active) to confirm the restored team and member count match the snapshot, and through `mainDriver.forTeam('__drill_other_tenant__')` to confirm cross-tenant reads return `0` rows.
5. **Run the Postgres verification suite:** Runs `src/db/pg/tenancy.test.ts`, `src/db/pg/migrate.test.ts`, `src/db/pg/drift.test.ts`, and `src/cloud/backup.test.ts`.
6. **Teardown:** Drops `musterd_drill_<id>` and `musterd_drill_<id>_trace` with `DROP DATABASE ... WITH (FORCE)`.

## Recorded Result (2026-10-20)

```json
{"msg":"cloud_restore_drill_completed","date":"2026-10-20","drill_databases":["musterd_drill_mvh0ztnr","musterd_drill_mvh0ztnr_trace"],"schema_versions":{"main":118,"trace":4},"teams_restored":[{"slug":"revive","date":"2026-10-20","coordination_bytes":1910,"trace_bytes":177,"tables":54,"coordination_rows_inserted":11,"trace_rows_inserted":0,"members_verified":3,"rls_leak_rows":0}],"suite_passed":true,"duration_ms":51948}
```

### Bugs caught and fixed by the first real-Neon drill

Running `scripts/cloud/drill.mjs` against real Neon Postgres (rather than PGlite alone) exposed two real restore bugs that PGlite did not trip:

| Bug | Why PGlite missed it | Fix in `scripts/cloud/backup.mjs` |
| --- | --- | --- |
| `permission denied to set parameter "session_replication_role"` | PGlite runs as superuser; Neon's project owner is `neon_superuser` (not `rds_superuser` / `SUPERUSER`) and cannot set `session_replication_role = 'replica'`. | Replaced `session_replication_role` with topological table ordering (`teams` → `members` → `goals` → child tables) and multi-pass `SAVEPOINT` retries inside the restore transaction. |
| `cannot insert a non-DEFAULT value into column "in_reply_to"` / `"row_seq"` | Our unit test fixture had no `messages` or `insights` rows, whereas the live `revive` dump on Neon had `messages` rows carrying the `GENERATED ALWAYS` column `in_reply_to` (and `insights.tsv`), and `trace_events.row_seq` is `GENERATED ALWAYS AS IDENTITY`. | `restoreSnapshot` queries `information_schema.columns WHERE is_generated = 'ALWAYS'` (plus `messages.in_reply_to` and `insights.tsv`), omits generated expression columns from the `INSERT` column list, and uses `OVERRIDING SYSTEM VALUE` so identity columns (`trace_events.row_seq`) restore verbatim. |

## Falsifier

Re-run `node scripts/cloud/drill.mjs --wrangler`: if R2 holds no complete backup pair, if AES-256-GCM decryption or `restoreSnapshot` fails on a fresh Neon database, if `rls_leak_rows !== 0`, or if the verification suite exits non-zero, this drill record is falsified.
