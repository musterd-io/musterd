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
| Q1 schema loads | every table/index; hand-fixes ≤ 10 | **pass** — 106/106, 4 hand-fixes (FTS5) |
| Q2 hook path | file-backed p95 ≤ 10 ms/query; boot ≤ 2 s | **fail** — point queries ~1–3 ms p95 pass; boot 3.5–4.2 s and `findGateAsk` 18–38 ms p95 fail |
| Q3 one SQL text, two drivers | cursor tests green on both | **pass** — 8/8, one SQL text |
| Q4 conversion size | counted | ~1,000 call sites, ~70 files, either backend |

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

**Per-module cost, from Q3's port.** `cursors.ts` (85 lines, 3 statements, 1 transaction) → 52 lines
async: `git diff --no-index --stat` says 43 insertions, 76 deletions — effectively every line that
touches the store is rewritten (`await`, params as an array, `tx` callback), and the lines that are
not store calls are untouched. At ~470 driver call sites across ~63 store files that is the whole
store layer rewritten once, module by module, each with its existing tests as the gate. The
transport layer is the second half: `transport/http.ts` is 7,395 lines and references `ctx.db`
481 times — every handler that calls a store function becomes `async` and every store call gets an
`await`, mechanical but total. Order of magnitude for increment 1's store work, either backend:
**~1,000 call sites, ~70 files, one pass.** It is the same number whichever way Q2 decides.

## Q1 — schema on PGlite

**Pass.** `node scripts/perf/pglite-schema.mjs` on 2026-09-29 (schema at migration head of
ed3e1bef, pulled from a fully migrated in-memory SQLite db):

| | count |
| --- | --- |
| statements after rewrite | 106 (42 tables, 64 indexes and triggers) |
| loaded | **106** |
| failed | **0** |
| hand-fixes | **4**, all one feature (bar: ≤ 10) |

Mechanical rewrite rules that were enough for everything else: `INTEGER` → `BIGINT` (with the
`PRIMARY KEY AUTOINCREMENT` → `GENERATED BY DEFAULT AS IDENTITY` special case), `REAL` → `DOUBLE
PRECISION`, `BLOB` → `BYTEA`, drop `WITHOUT ROWID`, `json_extract(col, '$.k')` →
`(col::jsonb ->> 'k')`, and `GENERATED ALWAYS AS (…) VIRTUAL` → `STORED` (Postgres 18 accepts
virtual generated columns but refuses to index them; `messages.in_reply_to` has two indexes).

Two things the first run got wrong that were the tool, not the dialect: (1) `sqlite_master` order is
creation order, and a table a migration rebuilt (`members`, `messages`, `seeds`) lands *after* the
tables that reference it, so the loader runs in passes until no progress — 32 "failures" became 10;
(2) the `json_extract` rule has to run before the literal-aware pass, since its path is itself a
literal.

The one real divergence is **FTS5**: `insights_fts` (a virtual table), its five shadow tables and the
two `AFTER INSERT/DELETE ON messages` triggers that keep it in sync. Postgres has no FTS5; the
hand-fix is a plain table with a generated `tsvector` column and a GIN index, the shadow tables
dropped, and the triggers rewritten as `plpgsql` trigger functions. Under one dialect the insights
search (`store/insights.ts`) is rewritten once against `tsvector`; under two backends it is the one
module that keeps two SQL texts.

Not measured here: data-type semantics at read time (BIGINT comes back from PGlite as a JS number
up to 2^53, `Date.now()` fits) — Q3 exercises that on real reads.

## Q2 — hook path latency

**Fail on the bar as written; the median per-query cost is fine, boot and the tail are not.**
`node scripts/perf/pglite-hookpath.mjs 1 500` on 2026-09-29, Apple M3 / 8 GB, Node 22.23.1, PGlite
0.5.8 — the five queries the PreToolUse gate and the interrupt probe actually run, plus one audit
insert in its own transaction, on the same seed and the same SQL text:

Seed: 50 members · 400 lanes · 18000 messages · 230000 audit rows; 500 rounds after one warm-up.

| query | sqlite p50 / p95 / p99 (ms) | pglite-file p50 / p95 / p99 (ms) | pglite-memory p50 / p95 / p99 (ms) |
| --- | --- | --- | --- |
| `getPolicy` | 0.013 / 0.030 / 0.119 | 0.296 / 0.683 / 1.146 | 0.255 / 0.343 / 0.810 |
| `laneCoveringPath` | 0.192 / 0.445 / 1.293 | 0.998 / 1.679 / 4.212 | 0.863 / 1.296 / 1.588 |
| `getMemberByName` | 0.016 / 0.072 / 0.295 | 0.334 / 0.724 / 1.648 | 0.286 / 0.377 / 0.805 |
| `unreadSince` | 0.019 / 0.082 / 0.676 | 0.369 / 0.759 / 1.341 | 0.320 / 0.429 / 0.843 |
| `findGateAsk` | 0.020 / 0.055 / 1.106 | 15.518 / 37.667 / 74.255 | 12.472 / 16.288 / 20.402 |
| audit insert, own tx | 0.046 / 0.202 / 0.828 | 0.962 / 5.818 / 12.766 | 0.629 / 0.941 / 1.528 |
| boot ms · seed s · disk MB · rss MB | 64 · 7.7 · 44.8 · 69 | 3510 · 109.0 · 180.0 · 100 | 3465 · 85.4 · 0.0 · 140 |

The same run with the expression index a native-Postgres schema would carry for `findGateAsk`
(`CREATE INDEX … ON audit(team_id, ((detail::jsonb ->> 'class')), created_at)`; SQLite gets the
`json_extract` equivalent):

Seed: 50 members · 400 lanes · 18000 messages · 230000 audit rows; 500 rounds after one warm-up; with the json expression index.

| query | sqlite p50 / p95 / p99 (ms) | pglite-file p50 / p95 / p99 (ms) | pglite-memory p50 / p95 / p99 (ms) |
| --- | --- | --- | --- |
| `getPolicy` | 0.009 / 0.016 / 0.031 | 0.326 / 1.466 / 4.374 | 0.363 / 0.863 / 1.786 |
| `laneCoveringPath` | 0.175 / 0.368 / 1.227 | 1.492 / 8.729 / 25.973 | 1.413 / 5.097 / 11.016 |
| `getMemberByName` | 0.014 / 0.029 / 0.813 | 0.507 / 2.331 / 8.903 | 0.369 / 2.718 / 6.834 |
| `unreadSince` | 0.016 / 0.027 / 0.461 | 0.604 / 2.996 / 8.940 | 0.503 / 2.062 / 9.231 |
| `findGateAsk` | 0.017 / 0.033 / 0.214 | 7.731 / 18.506 / 28.593 | 7.152 / 19.628 / 38.796 |
| audit insert, own tx | 0.058 / 0.214 / 1.845 | 1.094 / 4.159 / 9.959 | 0.899 / 4.932 / 11.769 |
| boot ms · seed s · disk MB · rss MB | 16 · 4.8 · 51.3 · 112 | 4167 · 103.3 · 206.1 · 111 | 4364 · 203.9 · 0.0 · 244 |

Against the bar (file-backed p95 ≤ 10 ms per query, boot ≤ 2 s):

| | result |
| --- | --- |
| point queries (`getPolicy`, `getMemberByName`, `unreadSince`) | **pass** — 0.7–3 ms p95, roughly 20× SQLite's 0.03–0.08 ms, invisible beside a 50 ms internet hop but real on a laptop that pays nothing today |
| `laneCoveringPath` (a 100-row scan) | pass in run 1 (1.7 ms), **8.7 ms p95 / 26 ms p99** in run 2 — at the bar |
| `findGateAsk` (`json_extract` on 4,600 candidate rows) | **fail** — 37.7 ms p95 without an index, 18.5 ms with it |
| audit insert, own transaction | pass — 4–6 ms p95 file-backed (SQLite 0.2 ms) |
| boot | **fail** — 3.5–4.2 s for the WASM instance (SQLite 16–64 ms) |
| bulk load | 250k rows in 103–109 s file-backed (2.3k rows/s; SQLite 32–52k rows/s) — a `revive`-sized import is minutes, not seconds |
| disk | 180–206 MB for what SQLite stores in 45–51 MB |

Two things about `findGateAsk` that are the tool's honesty, not PGlite's fault: (1) a one-off
check (60k rows, in-memory, same index) shows the planner **does** take the expression index —
`Index Scan Backward using idx_audit_class`, 0.56 ms p50 / 3.8 ms p95 — so the bench's 7.7 ms p50
at 230k rows is variance I did not run down (PGlite has no autovacuum, and `ANALYZE` did not change
the plan or the time in the check); (2) run 2 is slower than run 1 on *every* backend including
SQLite, so the machine was noisier during it. Neither rescues the bar: **boot alone fails it**, and
boot is the number that matters most for self-hosted, because `packages/server`'s suite opens an
in-memory database per test file (hundreds of them) — at 3.5 s each that is minutes added to every
CI run, on top of a 3.5 s `musterd serve` cold start.

## Q3 — two-driver slice

**Pass.** `packages/server/src/store/cursors.ts` (85 lines) ported to
`scripts/perf/pglite-slice/cursors.mjs` on an async `Driver` interface
(`get / all / run / exec / tx / close`) with two drivers: `sqliteDriver` (better-sqlite3 wrapped in
Promises) and `pgliteDriver` (PGlite; SQL text passed through `sqliteToPostgres` +
`toPgPlaceholders`). The four cursor tests run against both:
`pnpm vitest run scripts/perf/pglite-slice/cursors.test.ts` → **8/8** (2026-09-29).

What one SQL text needed to serve both:

- `?` → `$n` placeholders, rewritten outside string literals (a `'why?'` literal survives — tested).
- `json_extract(col, '$.k')` → `(col::jsonb ->> 'k')` — the same rule Q1 used for DDL.
- **Integer columns come back as JS numbers on both** for `Date.now()`-sized values; the `Number()`
  casts on read cost nothing on SQLite and are the safe form on PGlite (BIGINT beyond 2^53 would be
  a string). `affectedRows` names the write count on PGlite; `changes` on better-sqlite3.
- **Transactions are the one shape difference.** better-sqlite3's `db.transaction(fn)` cannot
  wrap an async body, so the SQLite driver runs `BEGIN` / `COMMIT` / `ROLLBACK` by hand. That is
  correct for one process (the daemon is one process) and it is the honest cost of putting a sync
  engine under an async interface: every transaction still serialises on the event loop, exactly as
  today.

Nothing in the port is engine-specific above the driver.

## Decision

Applied the rule from the plan: Q1 **pass** (106/106, 4 hand-fixes, one feature), Q2 **fail** (boot
3.5–4.2 s against 2 s; `findGateAsk` 18–38 ms p95 against 10 ms; point queries and writes pass), Q3
**pass** (8/8 on both drivers, one SQL text), Q4 ~470 store call sites in ~63 files plus ~480
`ctx.db` references in `transport/http.ts` — **~1,000 call sites, ~70 files, one pass**, the same
number whichever backend the laptop runs.

**Result: two backends.** One async store interface — the Q3 `Driver` shape: `get / all / run /
exec / tx / close`, `?` placeholders in the SQL text, the driver owning the dialect — with a
better-sqlite3 driver for the laptop daemon (unchanged engine, unchanged file, unchanged
out-of-process readers, unchanged 16 ms boot) and a `pg` driver for Cloud. SQL text is shared
where Q1 and Q4 say it can be (everything but `json_extract` and FTS5: the driver rewrites
`json_extract` → `->>`, as the spike does; `store/insights.ts` keeps two texts for FTS5 vs
`tsvector`). ADR 475 decision 3 resolves to "two backends behind one store interface".

Why not one dialect despite Q1 and Q3 passing: the laptop daemon is the product every seat uses
today, and PGlite would charge it 3.5 s per boot (and per test file), 4× the disk, 20× the
per-query cost and a 10× slower bulk load, in exchange for one SQL dialect — and Q4 shows the
dialect is not where the cost is: the async conversion is ~1,000 call sites either way, and the
dialect-specific part is 84 `json_extract` sites the driver rewrites mechanically plus one FTS
module. One dialect would also break every out-of-process reader of `musterd.db` (Q4's list) and
force a `pg_dump`-style export path before any of them worked again.

What PGlite still buys, kept on the table: no native module (the `service install` Node-ABI trap
disappears), and a Postgres-faithful local test double for the Cloud driver — **the `pg` driver's
unit tests can run on PGlite in CI with no Postgres service**, which is the spike's most useful
side-product and is how increment 1 should test its Cloud store.

Falsifiers: PGlite boot under 1 s (a persistent-worker or snapshot-restore mode in a later release)
would reopen one-dialect for the laptop; a `pg`-driver test suite on PGlite that diverges from Neon
in behaviour would demote it from test double to spike curiosity.

`@electric-sql/pglite` stays a root devDependency: it is the test double, not a runtime dependency,
so hard rule 6 is not triggered; if increment 1 imports it from `packages/server` tests it moves to
that package's devDependencies with a line in ADR 002's ledger.
