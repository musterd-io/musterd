# PGlite spike — increment 0 of ADR 475

- Date started: 2026-09-29 · Lane `01M3QDPWJV85DFYS6M1DJPNBPP` · Plan:
  [`2026-09-29-cloud-increment-0-pglite-spike.md`](../superpowers/plans/2026-09-29-cloud-increment-0-pglite-spike.md)
- PGlite version: 0.5.8 · bundled Postgres: `PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, 32-bit`
  · Node: v22.23.1
- Machine: Apple M3, 8 GB

Why the spike is reshaped from the spec's wording ([spec §3.3](../superpowers/specs/2026-09-29-musterd-cloud-design.md)):
62 synchronous better-sqlite3 store files; PGlite is Promise-only; the spec's "boot the daemon on
PGlite" is the async conversion itself (see the plan). The four questions below are what two days
can answer; the conversion is sized, not done.

| Question | Pass bar | Result |
| --- | --- | --- |
| Q1 schema loads | every table/index; hand-fixes ≤ 10 | _pending_ |
| Q2 hook path | file-backed p95 ≤ 10 ms/query; boot ≤ 2 s | _pending_ |
| Q3 one SQL text, two drivers | cursor tests green on both | _pending_ |
| Q4 conversion size | counted | _pending_ |

## Q4 — dialect and call-site inventory

Measured 2026-09-29 on `origin/main` ed3e1bef with `node scripts/perf/pglite-dialect-inventory.mjs packages/server/src`
(non-test `.ts` files; substring counts, so a construct inside a comment counts too — this is a ceiling,
not a floor).

Files touching better-sqlite3 or a listed construct: **64**

| construct | count | class |
| --- | --- | --- |
| `json_extract` | 84 | SQLite-only or driver API |
| `json_each` | 0 | SQLite-only or driver API |
| `PRAGMA` | 7 | SQLite-only or driver API |
| `.pragma(` | 8 | SQLite-only or driver API |
| `INSERT OR IGNORE` | 6 | SQLite-only or driver API |
| `INSERT OR REPLACE` | 0 | SQLite-only or driver API |
| `AUTOINCREMENT` | 3 | SQLite-only or driver API |
| `INTEGER PRIMARY KEY` | 2 | SQLite-only or driver API |
| `strftime` | 0 | SQLite-only or driver API |
| `datetime(` | 0 | SQLite-only or driver API |
| `unixepoch` | 0 | SQLite-only or driver API |
| `GLOB` | 0 | SQLite-only or driver API |
| `iif(` | 0 | SQLite-only or driver API |
| `COLLATE NOCASE` | 0 | SQLite-only or driver API |
| `last_insert_rowid` | 0 | SQLite-only or driver API |
| `ON CONFLICT` | 23 | portable |
| `RETURNING` | 6 | portable |
| `.prepare(` | 204 | SQLite-only or driver API |
| `.exec(` | 126 | SQLite-only or driver API |
| `.transaction(` | 54 | SQLite-only or driver API |
| `.changes` | 19 | SQLite-only or driver API |

| file (top 15 by non-portable hits) | hits |
| --- | --- |
| `db/migrations.ts` | 177 |
| `store/residency.ts` | 34 |
| `sync/fold.ts` | 31 |
| `store/members.ts` | 22 |
| `store/teams.ts` | 21 |
| `store/seeds.ts` | 17 |
| `store/oauth.ts` | 15 |
| `store/presence.ts` | 15 |
| `store/nodes.ts` | 11 |
| `store/hostProvisions.ts` | 10 |
| `store/lanes.ts` | 10 |
| `store/audit.ts` | 9 |
| `store/doorbell.ts` | 9 |
| `store/review.ts` | 8 |
| `store/footprint.ts` | 7 |

Reading it: `migrations.ts` alone carries 177 hits — DDL that would be **replaced** by a Postgres
migration ladder, not ported line by line, so the store-code conversion is the other ~63 files at
~470 driver call sites (`.prepare` 204 + `.exec` 126 + `.transaction` 54 + `.changes` 19 + `.pragma`
8, minus migrations' share). `json_extract` at 84 sites is the one SQL-text divergence that matters;
`ON CONFLICT` (23) and `RETURNING` (6) already read as Postgres. Everything else SQLite-only is
single digits.

**Out-of-process readers of `musterd.db`** — break under PGlite's one-process-per-data-directory
rule, and the same list is what the Cloud Postgres path changes anyway:

- `scripts/corpus/snapshot.ts` — copies the live file (and `trace.db`) into a dated snapshot; under
  PGlite it would call `pg_dump`-equivalent on the daemon instead (the daemon must expose it).
- `scripts/dataset/export.ts` — `copyFileSync` of the db, then reads the copy; same fix.
- `scripts/research/*.ts` (six scripts: adr-250-asks-per-pr, adr-250-capability-miss,
  adr-250-repeat-wakes, adr-260-acceptance-eval, frontier-cadence-observational, roster-diversity) —
  open the file read-only with `node:sqlite`; they would read a snapshot, never the live store.
- `scripts/a11y/fixture-team.sh`, `scripts/perf/broadcast-bench-fixture.sh`,
  `scripts/perf/demo-audience-load.mjs` — seed a **fresh** db for a bench or fixture; they would seed
  through the daemon's HTTP surface instead of the file.
- `packages/cli/src/commands/reset.ts` — `copyFileSync` backup of `musterd.db` before a reset;
  becomes "stop daemon, copy the data directory".
- `packages/cli/src/commands/service.ts` — the Node ≥ 22 ABI trap for `better-sqlite3`
  (`service install`); disappears entirely under PGlite (WASM, no native module), which is a
  point **for** one dialect nobody had counted.
- 17 wiki pages quote `sqlite3 ~/.musterd/musterd.db …` one-liners as diagnostics; they would
  become `musterd db query …` or a `psql` against a daemon-exposed socket.

None of these blocks the decision; each is a line item in increment 1 if PGlite wins.

## Q1 — schema on PGlite

_pending (Task 3)_

## Q2 — hook path latency

_pending (Task 4)_

## Q3 — two-driver slice

_pending (Task 5)_

## Decision

_pending (Task 6)_
