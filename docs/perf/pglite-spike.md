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
| Q2 hook path | file-backed p95 ≤ 10 ms/query; boot ≤ 2 s | **pass** — every query ≤ 1.2 ms p95; reopen 93 ms (create 4.6 s, once per install) |
| Q3 one SQL text, two drivers | cursor tests green on both | **pass** — 8/8, one SQL text |
| Q4 conversion size | counted | ~730 call sites, ~70 files, either backend |

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
migration ladder, not ported line by line — so the store-code conversion is the other ~63 files at
**~250 driver call sites** (`.prepare` 204 + `.exec` 126 + `.transaction` 54 + `.changes` 19 +
`.pragma` 8 = 411, minus migrations' 177). `ON CONFLICT` (23) and `RETURNING` (6) already read as
Postgres. Everything else SQLite-only is single digits — except `json_extract`, which is **not** one
mechanical rewrite (review finding I4): of the 84 sites, **16 use a nested path**
(`'$.gate.fingerprint'`, `'$.lane_review.lane'`, `'$.event.detail.lane'` — the flat `'$.k'` →
`->> 'k'` rule leaves them untouched and Postgres refuses them), **3 compare the extracted value to
a number** (`json_extract(meta, '$.urgent') = 1` in `store/interruptCandidates.ts`, on the hook
path; `->>` returns text, so this is a type error or a silent mismatch on Postgres), and **3 `LIKE`
sites** rely on SQLite's case-insensitive `LIKE`, which Postgres's is not. A driver-level rewrite
therefore needs a JSON-path parser (`#>>` with an array path) and type-aware casts, and the `LIKE`
sites need `ILIKE` or an explicit `lower()`. That layer is small, but under two backends it is
kept forever; it is counted here so the decision does not undercount it.

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
not store calls are untouched (the 43/76 line count is inflated by dropped doc comments, and the
port folds `applyCursorAdvance` into `setCursor` and adds a transaction the original does not have —
it is a shape sample, not a faithful port). At ~250 driver call sites across ~63 store files that is
the whole store layer rewritten once, module by module, each with its existing tests as the gate.
The transport layer is the second half: `transport/http.ts` is 7,395 lines and references `ctx.db`
481 times — every handler that calls a store function becomes `async` and every store call gets an
`await`, mechanical but total. Order of magnitude for increment 1's store work, either backend:
**~730 call sites, ~70 files, one pass.** It is the same number whichever way Q2 decides.

## Q1 — schema on PGlite

**Pass.** `node scripts/perf/pglite-schema.mjs` on 2026-09-29 (schema at migration head of
ed3e1bef, pulled from a fully migrated in-memory SQLite db):

| | count |
| --- | --- |
| statements after rewrite | 106 (42 tables, 64 indexes and triggers) |
| loaded | **106** |
| failed | **0** |
| hand-fixes | **4 rules touching 8 statements**, all one feature (bar: ≤ 10) |

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

**Pass on the bar — after the review caught two measurement errors in the first run.** The
first run (kept below for the record) reported a 3.5–4.2 s "boot" and an 18–38 ms p95 on
`findGateAsk`, and the first draft of this page called both fails. The whole-branch review found
that (1) "boot" timed **creating** a database in an empty directory — `initdb` plus WASM start —
not reopening one, which is what `musterd serve` does on every start but the first; (2) the bench
never ran `ANALYZE`, and PGlite has no autovacuum, so a bulk-loaded table had no planner
statistics; (3) the three backends shared one process, so later ones inherited the earlier ones'
heap. The corrected bench (`node scripts/perf/pglite-hookpath.mjs 1 500`, 2026-09-29, Apple M3 /
8 GB, Node 22.23.1, PGlite 0.5.8 — `ANALYZE` after seed, a measured **reopen** of the file-backed
directory, each backend in its own child process):

Seed: 50 members · 400 lanes · 18000 messages · 230000 audit rows; 500 rounds after one warm-up; ANALYZE after seed; each backend in its own process.

| query | sqlite p50 / p95 / p99 (ms) | pglite-file p50 / p95 / p99 (ms) | pglite-memory p50 / p95 / p99 (ms) |
| --- | --- | --- | --- |
| `getPolicy` | 0.012 / 0.030 / 0.222 | 0.190 / 0.337 / 0.915 | 0.158 / 0.247 / 0.497 |
| `laneCoveringPath` | 0.238 / 0.937 / 4.132 | 0.712 / 1.214 / 1.856 | 0.619 / 1.077 / 1.969 |
| `getMemberByName` | 0.016 / 0.059 / 0.390 | 0.251 / 0.469 / 0.832 | 0.191 / 0.265 / 0.609 |
| `unreadSince` | 0.034 / 0.104 / 0.723 | 0.250 / 0.468 / 0.905 | 0.219 / 0.322 / 0.618 |
| `findGateAsk` | 0.034 / 0.118 / 0.852 | 0.236 / 0.339 / 0.708 | 0.205 / 0.287 / 0.667 |
| audit insert, own tx | 0.050 / 0.223 / 0.776 | 0.393 / 0.721 / 1.133 | 0.359 / 0.692 / 0.889 |
| create ms · reopen ms · seed s · disk MB · rss MB | 88 · — · 3.2 · 44.8 · 109 | 4587 · 93 · 55.7 · 180.1 · 310 | 1456 · — · 97.7 · 0.0 · 247 |

Against the bar (file-backed p95 ≤ 10 ms per query, boot ≤ 2 s):

| | result |
| --- | --- |
| every query, file-backed | **pass** — 0.34–1.2 ms p95; roughly 5–20× SQLite at p50, all sub-millisecond at p50 |
| `findGateAsk` (stand-in) | **pass** — 0.34 ms p95 with statistics; the first run's 18–38 ms was the missing `ANALYZE`, not the engine |
| audit insert, own transaction | pass — 0.7 ms p95 (SQLite 0.2 ms) |
| **reopen** an existing data directory | **pass** — **93 ms** (SQLite 88 ms) — this is the daemon's real start cost |
| create a new data directory | 4.6 s file-backed, 1.5–5.9 s in-memory — `initdb` inside WASM; paid once per install, and once per **in-memory** test database |
| in-memory `clone()` / `loadDataDir()` of a seeded instance | 0.5 s each (measured separately) — a template instance makes per-test-file cost ~0.5 s, not 4 s |
| bulk load, row-at-a-time `query()` | 250k rows in 56 s file-backed (4.5k rows/s; SQLite 3.2 s) — import of a `revive`-sized `musterd.db` is minutes; `COPY`/multi-row inserts were not measured |
| disk | 180 MB for what SQLite stores in 45 MB (includes a fresh cluster's catalog and WAL) |
| resident memory, process with the seeded db open | **310 MB** file-backed, 247 MB in-memory (SQLite 109 MB) |

Two honesty notes on the stand-in: `findGateAsk` is **not** the gate's real query
(`store/gateAsk.ts` reads `messages` with `act = 'ask'` and a *nested* path
`json_extract(meta, '$.gate.fingerprint')`, ordered by `ts`); the bench's `audit`/`$.class` query
has the same shape (indexed equality prefix, JSON filter, order + limit) over 4,600 candidates.
And every bench number is one machine, one run per configuration; the first run's PGlite p95s moved
2–5× between two runs that the corrected harness attributes to shared-process heap and missing
statistics, and a reader should treat sub-millisecond differences as noise.

<details>
<summary>First run, kept for the record (shared process, no ANALYZE, "boot" = create)</summary>

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

</details>

## Q3 — two-driver slice

**Pass.** `packages/server/src/store/cursors.ts` (85 lines) ported to
`scripts/perf/pglite-slice/cursors.mjs` on an async `Driver` interface
(`get / all / run / exec / tx / close`) with two drivers: `sqliteDriver` (better-sqlite3 wrapped in
Promises) and `pgliteDriver` (PGlite; SQL text passed through `sqliteToPostgres` +
`toPgPlaceholders`). Four cursor tests run against both:
`PGLITE_SPIKE=1 pnpm vitest run scripts/perf/pglite-slice/cursors.test.ts` → **8/8** (2026-09-29).
Honest scope: these are four tests written for the port (zero cursor, set-from-row + audit,
unknown id + rollback, literal `?`), not the module's existing `cursorReceiptOrder.test.ts` (8
tests, one of which reaches the `$.urgent = 1` typed comparison above) — porting those was more
than the slice's budget, and the bar was "the existing tests", so Q3 passes a weaker bar than the
plan wrote.

What one SQL text needed to serve both:

- `?` → `$n` placeholders, rewritten outside string literals (a `'why?'` literal survives — tested).
- `json_extract(col, '$.k')` → `(col::jsonb ->> 'k')` — the same rule Q1 used for DDL.
- **Integer columns come back as JS numbers on both** for `Date.now()`-sized values; the `Number()`
  casts on read cost nothing on SQLite and are the safe form on PGlite (BIGINT beyond 2^53 would be
  a string). `affectedRows` names the write count on PGlite; `changes` on better-sqlite3.
- **Transactions are the one shape difference, and the SQLite side is not yet safe.**
  better-sqlite3's `db.transaction(fn)` cannot wrap an async body, so the spike's SQLite driver runs
  `BEGIN` / `COMMIT` / `ROLLBACK` by hand. That is **not** equivalent to today (review finding I5):
  today's `db.transaction(fn)` is synchronous and nothing can interleave; with an async body every
  `await` yields the event loop, so another request's statements can run inside the open
  transaction on the same connection, and a second `tx()` fails with "cannot start a transaction
  within a transaction". The spike never hits it because its tests run one at a time. Increment 1's
  real SQLite driver needs one of: a **transaction queue** (one `tx` at a time, the next awaits), or
  a rule that transaction bodies are synchronous and the driver runs them under
  `db.transaction(fn)` while only the surrounding call is `async`. The second is closer to today's
  semantics and is the recommended shape.

Nothing else in the port is engine-specific above the driver.

## Decision

**2026-09-29 — nick chose two backends**, overruling the rule's "one dialect" below on footprint:
the development laptop is memory- and disk-constrained, and the local daemon should be exactly
what self-hosted users run. better-sqlite3 stays local, `pg` serves Cloud, the store suite runs on
both drivers (PGlite as the `pg` test double, in-memory, test-time only). The two-backend
falsifier below (translation layer under ~300 lines, nested-path and typed-compare sites tested)
is now the one that applies. The rest of this section is the record the choice was made from.

**By the plan's rule the spike says one dialect.** Q1 pass, Q2 pass (after the review's
corrections), Q3 pass, Q4 counted. The first draft of this page said "two backends" on a Q2 fail
that was the bench's error; that draft was reviewed, corrected, and is superseded here.

The rule was written before the numbers existed, so the judgment that goes with it is recorded
too, for nick to confirm or overrule (this reverses what fifty reported to him on 2026-09-29
before the review):

**For one dialect (PGlite on the laptop, `pg` in Cloud, one store layer):**

- One SQL dialect, one store layer, one set of store tests — and the tests run on the *real*
  engine, so a bug found locally is a Cloud bug and vice versa. No permanent translation layer
  (Q4's nested `json_extract` paths, typed comparisons, `LIKE` semantics, FTS5 vs `tsvector` are
  each rewritten once, not kept twice).
- No native module: the `service install` Node-ABI trap (Q4) disappears; the CLI ships one
  artefact for every Node ≥ 20.
- The daemon's real start is 93 ms; per-query cost is sub-millisecond; the gate's budget is 1.5 s.

**For two backends (better-sqlite3 stays on the laptop):**

- Zero regression risk for every seat today; every out-of-process reader of `musterd.db` (Q4's
  list: corpus snapshot, dataset export, six research scripts, fixtures, `reset`, 17 wiki
  one-liners) keeps working unchanged. Under one dialect each needs a daemon-exposed dump or a
  `pg_dump` path first.
- **Memory**: 310 MB resident with a `revive`-scale database open, against 109 MB — on an 8 GB
  laptop running three or four agent harnesses, that is the number most likely to be felt.
- **Disk** 4× and **bulk writes** ~17× slower row-at-a-time: import, and the sync/fold path
  under ADR 325 federation, get slower; `COPY` may close most of that gap and was not measured.
- PGlite is 0.5.x, single-connection, WASM: a maturity bet the laptop daemon would carry for
  every user, where better-sqlite3 is boring.
- FTS5 → `tsvector` is a rewrite of `store/insights.ts` either way in Cloud; one dialect just
  makes it the only version.

**Falsifiers either way**, so the choice can be re-tested rather than argued: for one dialect,
resident memory under 200 MB with the `revive` db open after the store conversion, and a
`COPY`-based import of `musterd.db` under a minute; for two backends, a dialect-translation layer
that stays under ~300 lines with the nested-path and typed-compare sites covered by tests.

Whichever nick picks, three things are settled by the spike and carry into increment 1:

1. The **async store interface** is the Q3 `Driver` shape (`get / all / run / exec / tx / close`,
   `?` placeholders, the driver owns the dialect), and it is **~730 call sites in ~70 files, one
   pass** — the same work under either choice.
2. The SQLite side of that interface, if kept, needs a **transaction queue or synchronous
   transaction bodies** (Q3's finding); the spike's BEGIN/COMMIT-around-`await` is not safe.
3. `pg`-driver tests run on **PGlite in CI** with no Postgres service, from a cloned template
   instance (~0.5 s per file). Under one dialect that is simply the suite.

`@electric-sql/pglite` stays a root devDependency (test-time only) under the two-backend choice.
