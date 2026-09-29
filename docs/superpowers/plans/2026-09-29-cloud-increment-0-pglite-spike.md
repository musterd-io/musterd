# Cloud increment 0 — PGlite spike: implementation plan

> **For agentic workers:** implement this plan task-by-task in your own seat (musterd lane
> `01M3MT842AQ19VENMPZ8HYAVX2` or its successor; no subagents write). Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** In two days, produce a recorded pass/fail that decides ADR 475 decision 3 — one SQL
dialect (PGlite on the laptop, Postgres in Cloud) or two backends behind one store interface — and
measure the async store conversion that Cloud owes either way.

**Architecture:** Throwaway measurement code under `scripts/perf/`, never in `packages/server`.
Four probes: a dialect inventory of the real store; the real schema loaded into PGlite; the hook
path's real queries benchmarked on better-sqlite3 vs PGlite on the same seeded data; one store
module ported to an async two-driver interface with its existing tests run against both. The result
is a dated page in `docs/perf/` and a Consequences note on ADR 475.

**Tech Stack:** Node ≥ 22, `@electric-sql/pglite` 0.5.x (root devDependency, spike-only; requires
Node ≥ 20), `better-sqlite3` (already present), vitest (root `include` already covers
`scripts/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §3.3, and ADR 475 decision 3
and its Observability & Evaluation "Experiment" paragraph.

## Why the spike is reshaped, and what that changes

The spec says "boot the daemon on PGlite, run the server suite, measure hook-path latency". Measured
on 2026-09-29 (`grep -rl better-sqlite3 packages/server/src | grep -v test | wc -l`): **62 files**
import `better-sqlite3` directly, with **204 `.prepare(`, 126 `.exec(`, 54 `.transaction(`** call
sites — all synchronous. PGlite's API is Promise-only. Booting the daemon on PGlite therefore *is*
the async store conversion, which is weeks, not two days, and is owed by Cloud's Postgres whether or
not PGlite wins. So the spike answers the questions it can answer and sizes the one it cannot:

| Question | Probe | Pass |
| --- | --- | --- |
| Q1 Does the real schema run on Postgres? | Task 3: current DDL → PGlite | every table and index loads after a mechanical rewrite; hand-fixes ≤ 10 |
| Q2 Is PGlite fast enough for the hook path on a laptop? | Task 4: hook-path queries on seeded data | file-backed PGlite p95 ≤ 10 ms per query and boot ≤ 2 s (today's gate does a network round trip per call and `/inbox/interrupt-check` is documented sub-50 ms) |
| Q3 Can one SQL text serve both drivers behind an async interface? | Task 5: `cursors.ts` on two drivers | the existing cursor tests pass on both drivers with one SQL text and one placeholder rewrite |
| Q4 What does the async conversion cost, and who else reads `musterd.db`? | Task 2 + Task 5 | a counted inventory and a per-module cost from the slice |

Decision rule, recorded in Task 6: Q1 and Q3 pass and Q2 passes → **one dialect** (PGlite on the
laptop, Postgres in Cloud, one store layer). Q2 fails or Q1 needs > 10 hand-fixes → **two backends**
behind the interface Task 5 shapes. Either way Q4's number is the size of increment 1's store work.

## Global Constraints

- No spike code lands in `packages/server/src` (arch trees are drift-checked; the spike is throwaway).
- `@electric-sql/pglite` is a **root `devDependency`** for the spike only; promoting it to a runtime
  dependency of `@musterd/server` needs its ADR 002-style note (hard rule 6, already flagged in ADR
  475 Consequences).
- Never touch a real `~/.musterd/musterd.db`; every probe seeds its own data (`MUSTERD_DB` is not
  read).
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`.
- Every commit ends with `Co-authored-by: fifty <fifty@revive.musterd>`.
- Vocabulary: Member / Seat / Lane / Scope as `brand.md` §5; "surface" never means files.

## Review Focus

1. **A bench run on a cold WASM instance** reports first-query compile time as query latency; every
   PGlite timing must discard a warm-up round (Task 4 test pins that warm-up runs).
2. **`json_extract` in 83 call sites** is the single largest dialect divergence; the inventory must
   count it separately from the rest so the result page can say what "one dialect" costs (Task 2
   test pins the construct list).
3. **PGlite allows one process per data directory.** Anything that opens `musterd.db` from outside
   the daemon (`corpus:snapshot`, archaeology, `sqlite3` in runbooks) breaks under PGlite; Task 2
   lists those readers so the decision sees them.
4. **A placeholder rewrite (`?` → `$n`) that ignores `?` inside string literals** corrupts SQL
   silently; Task 5's driver test includes a literal containing `?`.
5. **A seeded dataset far smaller than revive's** (17.7k messages, 228k audit rows) makes every
   backend look fast; Task 4 seeds at revive's order of magnitude and records the row counts in the
   report.

---

### Task 1: Take PGlite as a spike devDependency and open the result page

**Files:**

- Modify: `package.json` (root `devDependencies`)
- Create: `docs/perf/pglite-spike.md`

**Interfaces:**

- Produces: the `@electric-sql/pglite` import for Tasks 3–5; the result page every later task appends to.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add -Dw @electric-sql/pglite@^0.5.8
node -e "import('@electric-sql/pglite').then(async m => { const db = new m.PGlite(); console.log((await db.query('select version()')).rows[0]); await db.close(); })"
```

Expected: a line starting `PostgreSQL 17` (record the exact string; it goes on the result page).

- [ ] **Step 2: Open the result page with the questions and the decision rule**

```markdown
# PGlite spike — increment 0 of ADR 475

- Date started: 2026-09-30 · Lane `01M3MT842AQ19VENMPZ8HYAVX2` · Plan: `docs/superpowers/plans/2026-09-29-cloud-increment-0-pglite-spike.md`
- PGlite version: <from Step 1> · bundled Postgres: <from Step 1> · Node: <`node -v`>
- Machine: <`sysctl -n machdep.cpu.brand_string`>, <RAM>

Why the spike is reshaped from the spec's wording: 62 synchronous better-sqlite3 store files; PGlite is
Promise-only; the spec's "boot the daemon on PGlite" is the async conversion itself (see the plan).

| Question | Pass bar | Result |
| --- | --- | --- |
| Q1 schema loads | every table/index; hand-fixes ≤ 10 | _pending_ |
| Q2 hook path | file-backed p95 ≤ 10 ms/query; boot ≤ 2 s | _pending_ |
| Q3 one SQL text, two drivers | cursor tests green on both | _pending_ |
| Q4 conversion size | counted | _pending_ |

## Q4 — dialect and call-site inventory
_pending (Task 2)_

## Q1 — schema on PGlite
_pending (Task 3)_

## Q2 — hook path latency
_pending (Task 4)_

## Q3 — two-driver slice
_pending (Task 5)_

## Decision
_pending (Task 6)_
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml docs/perf/pglite-spike.md
git commit -m "spike(pglite): take @electric-sql/pglite as a root devDependency; open the result page (ADR 475 inc 0)

Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 2: Dialect and call-site inventory (Q4)

**Files:**

- Create: `scripts/perf/pglite-dialect-inventory.mjs`
- Create: `scripts/perf/pglite-dialect-inventory.test.ts`
- Modify: `docs/perf/pglite-spike.md` (Q4 section)

**Interfaces:**

- Produces: `inventory(rootDir) → { byConstruct: Record<string, number>, byFile: Record<string, number>, files: number }` and a CLI that prints a markdown table.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/perf/pglite-dialect-inventory.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSTRUCTS, inventory } from './pglite-dialect-inventory.mjs';

describe('pglite dialect inventory', () => {
  it('counts each SQLite-only construct and every better-sqlite3 call site, skipping tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-'));
    mkdirSync(join(root, 'store'));
    writeFileSync(
      join(root, 'store', 'a.ts'),
      [
        "import Database from 'better-sqlite3';",
        "db.prepare(\"SELECT json_extract(detail, '$.x') FROM t\").all();",
        'db.exec("PRAGMA foreign_keys = ON");',
        'db.transaction(() => db.prepare("INSERT OR IGNORE INTO t VALUES (?)").run(1))();',
        'db.pragma("journal_mode = WAL");',
        'const n = db.prepare("DELETE FROM t").run().changes;',
      ].join('\n'),
    );
    writeFileSync(join(root, 'store', 'a.test.ts'), 'db.prepare("PRAGMA x")');
    const r = inventory(root);
    expect(r.files).toBe(1);
    expect(r.byConstruct.json_extract).toBe(1);
    expect(r.byConstruct.PRAGMA).toBe(1);
    expect(r.byConstruct['INSERT OR IGNORE']).toBe(1);
    expect(r.byConstruct['.prepare(']).toBe(3);
    expect(r.byConstruct['.exec(']).toBe(1);
    expect(r.byConstruct['.transaction(']).toBe(1);
    expect(r.byConstruct['.pragma(']).toBe(1);
    expect(r.byConstruct['.changes']).toBe(1);
    expect(r.byFile['store/a.ts']).toBeGreaterThan(0);
  });

  it('pins the construct list so the report cannot silently drop one', () => {
    expect(CONSTRUCTS).toEqual([
      'json_extract',
      'json_each',
      'PRAGMA',
      '.pragma(',
      'INSERT OR IGNORE',
      'INSERT OR REPLACE',
      'AUTOINCREMENT',
      'INTEGER PRIMARY KEY',
      'strftime',
      'datetime(',
      'unixepoch',
      'GLOB',
      'iif(',
      'COLLATE NOCASE',
      'last_insert_rowid',
      'ON CONFLICT',
      'RETURNING',
      '.prepare(',
      '.exec(',
      '.transaction(',
      '.changes',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/perf/pglite-dialect-inventory.test.ts`
Expected: FAIL — cannot resolve `./pglite-dialect-inventory.mjs`.

- [ ] **Step 3: Write the inventory**

```js
// scripts/perf/pglite-dialect-inventory.mjs
// Counts SQLite-only SQL constructs and better-sqlite3 call sites under a source root. Spike-only
// (ADR 475 increment 0): the number is the size of the store conversion, whichever backend wins.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Order matters only for the report. `ON CONFLICT` and `RETURNING` are Postgres-valid and are
 * counted so the page can say how much of the SQL is already portable. */
export const CONSTRUCTS = [
  'json_extract', 'json_each', 'PRAGMA', '.pragma(', 'INSERT OR IGNORE', 'INSERT OR REPLACE',
  'AUTOINCREMENT', 'INTEGER PRIMARY KEY', 'strftime', 'datetime(', 'unixepoch', 'GLOB', 'iif(',
  'COLLATE NOCASE', 'last_insert_rowid', 'ON CONFLICT', 'RETURNING', '.prepare(', '.exec(',
  '.transaction(', '.changes',
];

const PORTABLE = new Set(['ON CONFLICT', 'RETURNING']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

function countOccurrences(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function inventory(rootDir) {
  const byConstruct = Object.fromEntries(CONSTRUCTS.map((c) => [c, 0]));
  const byFile = {};
  let files = 0;
  for (const file of walk(rootDir)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('better-sqlite3') && !CONSTRUCTS.some((c) => text.includes(c))) continue;
    files++;
    let fileTotal = 0;
    for (const c of CONSTRUCTS) {
      const n = countOccurrences(text, c);
      byConstruct[c] += n;
      if (!PORTABLE.has(c)) fileTotal += n;
    }
    byFile[relative(rootDir, file)] = fileTotal;
  }
  return { byConstruct, byFile, files };
}

export function renderMarkdown(r) {
  const rows = CONSTRUCTS.map((c) => `| \`${c}\` | ${r.byConstruct[c]} | ${PORTABLE.has(c) ? 'portable' : 'SQLite-only or driver API'} |`);
  const top = Object.entries(r.byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([f, n]) => `| \`${f}\` | ${n} |`);
  return [
    `Files touching better-sqlite3 or a listed construct: **${r.files}**`, '',
    '| construct | count | class |', '| --- | --- | --- |', ...rows, '',
    '| file (top 15 by non-portable hits) | hits |', '| --- | --- |', ...top,
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('pglite-dialect-inventory.mjs')) {
  const root = process.argv[2] ?? 'packages/server/src';
  console.log(renderMarkdown(inventory(root)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run scripts/perf/pglite-dialect-inventory.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the inventory on the real store and list out-of-process readers of `musterd.db`**

```bash
node scripts/perf/pglite-dialect-inventory.mjs packages/server/src
grep -rn "musterd\.db\|\.musterd/musterd" scripts packages/cli/src docs/operations docs/wiki --include='*.ts' --include='*.mjs' --include='*.sh' --include='*.md' | grep -v "\.test\.ts" | cut -d: -f1 | sort -u
```

Paste the markdown table under **Q4** on `docs/perf/pglite-spike.md`, then a bullet list titled
"Out-of-process readers of `musterd.db` (break under PGlite's one-process rule)" with every file the
second command printed and one clause each on what it does with the file.

- [ ] **Step 6: Commit**

```bash
git add scripts/perf/pglite-dialect-inventory.mjs scripts/perf/pglite-dialect-inventory.test.ts docs/perf/pglite-spike.md
git commit -m "spike(pglite): dialect + call-site inventory of the store, out-of-process db readers (Q4)

Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 3: The real schema on PGlite (Q1)

**Files:**

- Create: `scripts/perf/pglite-schema.mjs`
- Create: `scripts/perf/pglite-schema.test.ts`
- Modify: `docs/perf/pglite-spike.md` (Q1 section)

**Interfaces:**

- Consumes: `openDb(':memory:')` from `packages/server/src/db/open.ts` (via `@musterd/server` dist — build first).
- Produces: `sqliteToPostgres(ddl: string) → string` (mechanical rewrite) and `loadSchema(pg, statements) → { ok: string[], failed: {sql, error}[] }`.

- [ ] **Step 1: Write the failing test for the mechanical rewrite**

```ts
// scripts/perf/pglite-schema.test.ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { loadSchema, splitStatements, sqliteToPostgres } from './pglite-schema.mjs';

describe('sqliteToPostgres', () => {
  it('rewrites the constructs the inventory found, and nothing inside string literals', () => {
    const ddl = `CREATE TABLE t (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  body TEXT DEFAULT 'INTEGER PRIMARY KEY',
  ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1))
);
CREATE INDEX i ON t(ts);`;
    const out = sqliteToPostgres(ddl);
    expect(out).toContain('id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    expect(out).toContain('ts BIGINT NOT NULL');
    expect(out).toContain("DEFAULT 'INTEGER PRIMARY KEY'");
    expect(out).not.toContain('AUTOINCREMENT');
  });

  it('drops PRAGMA lines and keeps statement count otherwise', () => {
    const stmts = splitStatements('PRAGMA foreign_keys=ON;\nCREATE TABLE a (x TEXT);\nCREATE TABLE b (y TEXT);');
    expect(stmts).toEqual(['CREATE TABLE a (x TEXT)', 'CREATE TABLE b (y TEXT)']);
  });
});

describe('loadSchema', () => {
  it('reports each statement as ok or failed with the Postgres error', async () => {
    const pg = new PGlite();
    const r = await loadSchema(pg, ['CREATE TABLE a (x TEXT)', 'CREATE TABLE a (x TEXT)']);
    expect(r.ok).toEqual(['CREATE TABLE a (x TEXT)']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toMatch(/already exists/);
    await pg.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/perf/pglite-schema.test.ts`
Expected: FAIL — cannot resolve `./pglite-schema.mjs`.

- [ ] **Step 3: Write the rewrite and loader**

```js
// scripts/perf/pglite-schema.mjs
// Q1 of the PGlite spike: does musterd's CURRENT schema (every migration applied) load on Postgres
// after a mechanical rewrite? Spike-only; the rewrite is deliberately dumb so the count of what it
// cannot fix is the finding.
import { PGlite } from '@electric-sql/pglite';

/** Split on `;` at line end, drop PRAGMAs and empties. Good enough for DDL SQLite emits. */
export function splitStatements(sql) {
  return sql
    .split(/;\s*\n|;\s*$/)
    .map((s) => s.trim())
    .filter((s) => s && !/^PRAGMA\b/i.test(s));
}

/** Rewrite outside single-quoted literals only. */
function outsideLiterals(sql, fn) {
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

export function sqliteToPostgres(ddl) {
  return outsideLiterals(ddl, (s) =>
    s
      .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
      .replace(/\bINTEGER PRIMARY KEY\b/g, 'BIGINT PRIMARY KEY')
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
      .replace(/\bBLOB\b/g, 'BYTEA')
      .replace(/\bWITHOUT ROWID\b/g, '')
      .replace(/\bjson_extract\(([^,]+),\s*'\$\.([A-Za-z0-9_]+)'\)/g, "($1::jsonb ->> '$2')"),
  );
}

export async function loadSchema(pg, statements) {
  const ok = [];
  const failed = [];
  for (const sql of statements) {
    try {
      await pg.exec(sql);
      ok.push(sql);
    } catch (e) {
      failed.push({ sql, error: String(e?.message ?? e) });
    }
  }
  return { ok, failed };
}

/** Pull the current DDL out of a fully migrated in-memory SQLite db. */
export function currentSqliteDdl(db) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name")
    .all()
    .map((r) => r.sql)
    .join(';\n');
}

if (process.argv[1] && process.argv[1].endsWith('pglite-schema.mjs')) {
  const { openDb } = await import('../../packages/server/dist/index.js');
  const sqlite = openDb(':memory:');
  const ddl = currentSqliteDdl(sqlite);
  const stmts = splitStatements(sqliteToPostgres(ddl));
  const pg = new PGlite();
  const r = await loadSchema(pg, stmts);
  console.log(`statements: ${stmts.length} · ok: ${r.ok.length} · failed: ${r.failed.length}`);
  for (const f of r.failed) console.log(`\n--- ${f.error}\n${f.sql.slice(0, 400)}`);
  await pg.close();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/perf/pglite-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run it against the real schema; hand-fix and count**

```bash
pnpm --filter @musterd/server build
node scripts/perf/pglite-schema.mjs
```

For each failed statement: classify it (CHECK expression, expression index, `json_extract` in an
index, a reserved word, a type) and add **either** a rewrite rule to `sqliteToPostgres` (if it is
mechanical and generalises) **or** a line to a `HAND_FIXES` array at the top of the script:
`{ match: /CREATE INDEX idx_x/, replace: '…' }`, applied after the rewrite. Stop when
`failed: 0` or when `HAND_FIXES.length > 10` (that is a Q1 fail; record it).

Under **Q1** on the result page record: statement count, tables, indexes, the rewrite rules
added, each hand-fix with one clause on why Postgres refused it, and the pass/fail against
"hand-fixes ≤ 10".

- [ ] **Step 6: Commit**

```bash
git add scripts/perf/pglite-schema.mjs scripts/perf/pglite-schema.test.ts docs/perf/pglite-spike.md
git commit -m "spike(pglite): the current schema on PGlite — mechanical rewrite, hand-fix count (Q1)

Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 4: Hook-path latency, better-sqlite3 vs PGlite on the same data (Q2)

**Files:**

- Create: `scripts/perf/pglite-hookpath.mjs`
- Create: `scripts/perf/pglite-hookpath.test.ts`
- Modify: `docs/perf/pglite-spike.md` (Q2 section)

**Interfaces:**

- Consumes: `sqliteToPostgres`, `splitStatements` from Task 3 (the bench seeds the **same** minimal tables on both, not the full schema, so the numbers isolate the engine).
- Produces: `runBench({ backend: 'sqlite'|'pglite-file'|'pglite-memory', dir, scale, rounds }) → Report` with `Report = { backend, boot_ms, rows: {members, lanes, messages, audit}, queries: Record<name, {p50, p95, p99, n}>, write_commit_ms: {p50, p95}, rss_mb, disk_mb }`.

The five queries are the ones the gate and the interrupt probe actually run (read on 2026-09-29):
`getPolicy` (`packages/server/src/store/teams.ts:708`, one row by team id), `laneCoveringPath`
(`store/lanes.ts:834`, open lanes for a team then glob-match in JS), `getMemberByName`
(`store/members.ts`, unique index hit), the interrupt check's unread count (`messages` after the
seat's cursor `created_at`), and `findGateAsk` (`store/gateAsk.ts:19`, a `json_extract` on
`detail`). Plus one write: a single `audit` insert in its own transaction, which
`docs/perf/daemon-load-baseline.md` measured at 0.026 ms on SQLite.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/perf/pglite-hookpath.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERY_NAMES, runBench } from './pglite-hookpath.mjs';

describe('pglite hook-path bench', () => {
  it('produces a full report for each backend at a tiny scale, with a warm-up round discarded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-'));
    for (const backend of ['sqlite', 'pglite-memory', 'pglite-file'] as const) {
      const r = await runBench({ backend, dir, scale: 0.001, rounds: 3 });
      expect(r.backend).toBe(backend);
      expect(r.boot_ms).toBeGreaterThan(0);
      expect(r.rows.messages).toBeGreaterThan(0);
      for (const q of QUERY_NAMES) {
        expect(r.queries[q].n).toBe(3); // rounds counted; the warm-up round is not
        expect(r.queries[q].p95).toBeGreaterThanOrEqual(r.queries[q].p50);
      }
      expect(r.write_commit_ms.p50).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a literal ? inside the seeded SQL survives the placeholder rewrite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-'));
    const r = await runBench({ backend: 'pglite-memory', dir, scale: 0.001, rounds: 1 });
    expect(r.rows.lanes).toBeGreaterThan(0); // the lanes seed carries a title with '?'
  }, 60_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/perf/pglite-hookpath.test.ts`
Expected: FAIL — cannot resolve `./pglite-hookpath.mjs`.

- [ ] **Step 3: Write the bench**

```js
// scripts/perf/pglite-hookpath.mjs
// Q2 of the PGlite spike: the PreToolUse gate's own queries on better-sqlite3 vs PGlite, same seed,
// same SQL text. `scale: 1` is revive's order of magnitude on 2026-09-29 (50 members, 400 lanes,
// 18k messages, 230k audit rows). Run:  node scripts/perf/pglite-hookpath.mjs [scale] [rounds]
import { mkdirSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { splitStatements, sqliteToPostgres } from './pglite-schema.mjs';

const DDL = `
CREATE TABLE teams (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, policy_json TEXT NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, left_at INTEGER);
CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
CREATE TABLE lanes (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, owner_seat TEXT, scope_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_lanes_team_state ON lanes(team_id, state);
CREATE TABLE messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_member TEXT, act TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_messages_team_to_created ON messages(team_id, to_member, created_at);
CREATE TABLE audit (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, verb TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_audit_team_verb ON audit(team_id, verb, created_at);
`;

export const QUERY_NAMES = ['getPolicy', 'laneCoveringPath', 'getMemberByName', 'unreadSince', 'findGateAsk'];

const QUERIES = {
  getPolicy: ['SELECT policy_json FROM teams WHERE id = ?', (s) => [s.team]],
  laneCoveringPath: ["SELECT id, title, owner_seat, scope_json FROM lanes WHERE team_id = ? AND state IN ('claimed','active','blocked')", (s) => [s.team]],
  getMemberByName: ['SELECT * FROM members WHERE team_id = ? AND name = ?', (s) => [s.team, 'seat-7']],
  unreadSince: ['SELECT count(*) AS n FROM messages WHERE team_id = ? AND to_member = ? AND created_at > ?', (s) => [s.team, 'seat-7', s.cursorTs]],
  findGateAsk: ["SELECT id FROM audit WHERE team_id = ? AND verb = 'action.gate' AND json_extract(detail, '$.class') = ? ORDER BY created_at DESC LIMIT 1", (s) => [s.team, 'deploy']],
};

/** `?` → `$1..$n` outside single-quoted literals (Review Focus 4). */
export function toPgPlaceholders(sql) {
  let n = 0;
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : part.replace(/\?/g, () => `$${++n}`))).join('');
}

function ulidish(i) { return String(i).padStart(26, '0'); }

function seedRows(scale) {
  const team = 'team-1';
  const members = Math.max(3, Math.round(50 * scale));
  const lanes = Math.max(3, Math.round(400 * scale));
  const messages = Math.max(10, Math.round(18_000 * scale));
  const audit = Math.max(10, Math.round(230_000 * scale));
  return { team, members, lanes, messages, audit, cursorTs: Date.now() - 3_600_000 };
}

async function openBackend(backend, dir) {
  const t0 = performance.now();
  if (backend === 'sqlite') {
    const db = new Database(join(dir, 'bench.db'));
    db.pragma('journal_mode = WAL');
    const exec = async (sql) => { db.exec(sql); };
    const all = async (sql, params) => db.prepare(sql).all(...params);
    const run = async (sql, params) => { db.prepare(sql).run(...params); };
    // better-sqlite3's db.transaction() cannot wrap an async body; BEGIN/COMMIT by hand keeps one
    // call shape across both engines (the same finding Task 5's driver records).
    const tx = async (fn) => { db.exec('BEGIN'); try { await fn({ run }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
    return { exec, all, run, tx, close: async () => db.close(), boot_ms: performance.now() - t0, file: join(dir, 'bench.db') };
  }
  const pg = backend === 'pglite-file' ? new PGlite(join(dir, 'pgdata')) : new PGlite();
  await pg.waitReady;
  const exec = async (sql) => { await pg.exec(sql); };
  const all = async (sql, params) => (await pg.query(toPgPlaceholders(sql), params)).rows;
  const run = async (sql, params) => { await pg.query(toPgPlaceholders(sql), params); };
  const tx = async (fn) => pg.transaction(async (t) => { await fn({ run: async (sql, params) => { await t.query(toPgPlaceholders(sql), params); } }); });
  return { exec, all, run, tx, close: async () => pg.close(), boot_ms: performance.now() - t0, file: backend === 'pglite-file' ? join(dir, 'pgdata') : null };
}

async function seed(b, backend, s) {
  const ddl = backend === 'sqlite' ? DDL : sqliteToPostgres(DDL);
  for (const stmt of splitStatements(ddl)) await b.exec(stmt);
  await b.run('INSERT INTO teams VALUES (?, ?, ?)', [s.team, 'revive', JSON.stringify({ enforcement: { classes: [{ class: 'deploy', posture: 'block' }] } })]);
  for (let i = 0; i < s.members; i++) await b.run('INSERT INTO members VALUES (?, ?, ?, ?, NULL)', [`m${i}`, s.team, `seat-${i}`, 'agent']);
  for (let i = 0; i < s.lanes; i++) await b.run('INSERT INTO lanes VALUES (?, ?, ?, ?, ?, ?, ?)', [`l${i}`, s.team, `lane ${i} — why?`, i % 4 === 0 ? 'active' : 'done', `seat-${i % s.members}`, JSON.stringify([`packages/p${i % 9}/**`]), Date.now()]);
  const now = Date.now();
  await b.tx(async (t) => {
    const r = t ?? b;
    for (let i = 0; i < s.messages; i++) await r.run('INSERT INTO messages VALUES (?, ?, ?, ?, ?)', [ulidish(i), s.team, `seat-${i % s.members}`, 'message', now - (s.messages - i) * 1000]);
    for (let i = 0; i < s.audit; i++) await r.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?)', [`a${ulidish(i)}`, s.team, i % 50 === 0 ? 'action.gate' : 'claim.occupied', JSON.stringify({ class: i % 100 === 0 ? 'deploy' : 'merge', seat: `seat-${i % s.members}` }), now - (s.audit - i) * 100]);
  });
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }
function summarize(samples) { const s = [...samples].sort((a, b) => a - b); return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), n: s.length }; }

function dirSizeMb(p) {
  if (!p) return 0;
  const st = statSync(p);
  if (st.isFile()) return st.size / 1e6;
  return readdirSync(p).reduce((acc, f) => acc + dirSizeMb(join(p, f)), 0);
}

export async function runBench({ backend, dir, scale = 1, rounds = 200 }) {
  mkdirSync(dir, { recursive: true });
  const s = seedRows(scale);
  const b = await openBackend(backend, dir);
  await seed(b, backend, s);
  const queries = {};
  // Warm-up: one full pass, discarded (Review Focus 1 — WASM first-call compile is not query latency).
  for (const q of QUERY_NAMES) await b.all(QUERIES[q][0], QUERIES[q][1](s));
  for (const q of QUERY_NAMES) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now();
      await b.all(QUERIES[q][0], QUERIES[q][1](s));
      samples.push(performance.now() - t0);
    }
    queries[q] = summarize(samples);
  }
  const writes = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await b.tx(async (t) => { await (t ?? b).run('INSERT INTO audit VALUES (?, ?, ?, ?, ?)', [`w${i}-${Date.now()}`, s.team, 'lane.gate', '{}', Date.now()]); });
    writes.push(performance.now() - t0);
  }
  const report = {
    backend, boot_ms: b.boot_ms,
    rows: { members: s.members, lanes: s.lanes, messages: s.messages, audit: s.audit },
    queries, write_commit_ms: summarize(writes),
    rss_mb: process.memoryUsage().rss / 1e6, disk_mb: dirSizeMb(b.file),
  };
  await b.close();
  return report;
}

export function renderMarkdown(reports) {
  const head = `| query | ${reports.map((r) => `${r.backend} p50 / p95 / p99 (ms)`).join(' | ')} |`;
  const sep = `| --- | ${reports.map(() => '---').join(' | ')} |`;
  const rows = QUERY_NAMES.map((q) => `| \`${q}\` | ${reports.map((r) => `${r.queries[q].p50.toFixed(2)} / ${r.queries[q].p95.toFixed(2)} / ${r.queries[q].p99.toFixed(2)}`).join(' | ')} |`);
  const write = `| audit insert, own tx | ${reports.map((r) => `${r.write_commit_ms.p50.toFixed(3)} / ${r.write_commit_ms.p95.toFixed(3)} / —`).join(' | ')} |`;
  const meta = `| boot ms · disk MB · rss MB | ${reports.map((r) => `${r.boot_ms.toFixed(0)} · ${r.disk_mb.toFixed(1)} · ${r.rss_mb.toFixed(0)}`).join(' | ')} |`;
  const r0 = reports[0];
  return [`Seed: ${r0.rows.members} members · ${r0.rows.lanes} lanes · ${r0.rows.messages} messages · ${r0.rows.audit} audit rows; ${r0.queries.getPolicy.n} rounds after one warm-up.`, '', head, sep, ...rows, write, meta].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('pglite-hookpath.mjs')) {
  const scale = Number(process.argv[2] ?? 1);
  const rounds = Number(process.argv[3] ?? 200);
  const dir = join(process.env.TMPDIR ?? '/tmp', `pglite-hookpath-${Date.now()}`);
  const reports = [];
  for (const backend of ['sqlite', 'pglite-file', 'pglite-memory']) reports.push(await runBench({ backend, dir: join(dir, backend), scale, rounds }));
  console.log(renderMarkdown(reports));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/perf/pglite-hookpath.test.ts`
Expected: PASS (2 tests). If `findGateAsk` fails on PGlite with a `json_extract` error, the
Task 3 rewrite is applied to DDL only — add `toPgPlaceholders(sqliteToPostgres(sql))` in the
PGlite `all`/`run` wrappers so the query text gets the same `json_extract` rule, and note on the
result page that the store's 83 `json_extract` sites need exactly that rewrite.

- [ ] **Step 5: Run at scale 1 and record**

```bash
node scripts/perf/pglite-hookpath.mjs 1 500 | tee /tmp/pglite-hookpath.md
```

Paste the table under **Q2** on the result page with the machine and Node version, and the
verdict against the bar: **file-backed PGlite p95 ≤ 10 ms on every query, boot ≤ 2000 ms**. Also
record the ratio PGlite/SQLite per query; that ratio is what the laptop daemon would pay.

- [ ] **Step 6: Commit**

```bash
git add scripts/perf/pglite-hookpath.mjs scripts/perf/pglite-hookpath.test.ts docs/perf/pglite-spike.md
git commit -m "spike(pglite): gate-path queries on better-sqlite3 vs PGlite, seeded at revive scale (Q2)

Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 5: One store module on an async two-driver interface (Q3, and Q4's per-module cost)

**Files:**

- Create: `scripts/perf/pglite-slice/driver.mjs`
- Create: `scripts/perf/pglite-slice/cursors.mjs`
- Create: `scripts/perf/pglite-slice/cursors.test.ts`
- Modify: `docs/perf/pglite-spike.md` (Q3 section, Q4 per-module cost)

**Interfaces:**

- Consumes: `toPgPlaceholders` from Task 4; `sqliteToPostgres` from Task 3.
- Produces: `Driver = { get(sql, params) → Promise<row|undefined>, all(sql, params) → Promise<row[]>, run(sql, params) → Promise<{changes:number}>, tx(fn: (d: Driver) → Promise<T>) → Promise<T>, close() }`, `sqliteDriver(path)`, `pgliteDriver(dataDir|undefined)`; an async `getCursor(d, memberId)` / `setCursor(d, memberId, messageId)` with the same SQL text on both.

The module is `packages/server/src/store/cursors.ts` (85 lines): one `get`, one `SELECT … FROM
messages`, one upsert, and a call into `appendReplicatedEvent` from `audit.ts`. The slice inlines a
minimal `appendReplicatedEvent` (one insert) so the port stays inside one file; the point is the
shape and the count, not fidelity to audit.

- [ ] **Step 1: Write the failing tests, parameterised over both drivers**

```ts
// scripts/perf/pglite-slice/cursors.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pgliteDriver, sqliteDriver, type Driver } from './driver.mjs';
import { getCursor, migrate, setCursor } from './cursors.mjs';

const drivers: Array<[string, () => Promise<Driver>]> = [
  ['sqlite', async () => sqliteDriver(join(mkdtempSync(join(tmpdir(), 'cur-')), 'x.db'))],
  ['pglite', async () => pgliteDriver(undefined)],
];

describe.each(drivers)('cursors on %s', (_name, open) => {
  let d: Driver;
  afterEach(async () => { await d?.close(); });

  it('a seat that never read has a zero cursor', async () => {
    d = await open();
    await migrate(d);
    expect(await getCursor(d, 'm1')).toEqual({ member_id: 'm1', last_read_message_id: null, last_read_ts: 0, updated_at: 0 });
  });

  it('setCursor reads the position off the message row and records an audit event in one transaction', async () => {
    d = await open();
    await migrate(d);
    await d.run('INSERT INTO messages (id, team_id, created_at) VALUES (?, ?, ?)', ['msg1', 't1', 1234]);
    const c = await setCursor(d, 'm1', 'msg1');
    expect(c.last_read_message_id).toBe('msg1');
    expect(c.last_read_ts).toBe(1234);
    expect((await d.all('SELECT verb FROM audit WHERE detail LIKE ?', ['%msg1%'])).length).toBe(1);
  });

  it('an unknown message id throws and leaves no audit row', async () => {
    d = await open();
    await migrate(d);
    await expect(setCursor(d, 'm1', 'nope')).rejects.toThrow(/unknown message id/);
    expect(await d.all('SELECT 1 FROM audit', [])).toEqual([]);
  });

  it("a literal '?' in SQL text is not a placeholder", async () => {
    d = await open();
    await migrate(d);
    const rows = await d.all("SELECT 'why?' AS s WHERE ? = 1", [1]);
    expect(rows[0].s).toBe('why?');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/perf/pglite-slice/cursors.test.ts`
Expected: FAIL — cannot resolve `./driver.mjs`.

- [ ] **Step 3: Write the driver**

```js
// scripts/perf/pglite-slice/driver.mjs
// Q3 of the PGlite spike: the smallest async interface both engines can sit behind. Spike-only.
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { sqliteToPostgres } from '../pglite-schema.mjs';
import { toPgPlaceholders } from '../pglite-hookpath.mjs';

export function sqliteDriver(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  const d = {
    async get(sql, params) { return db.prepare(sql).get(...params); },
    async all(sql, params) { return db.prepare(sql).all(...params); },
    async run(sql, params) { return { changes: db.prepare(sql).run(...params).changes }; },
    async exec(sql) { db.exec(sql); },
    // better-sqlite3 transactions are synchronous; an async body cannot be wrapped in db.transaction.
    // BEGIN/COMMIT by hand keeps the same call shape as PGlite. This is the one place the two
    // drivers differ, and it is the finding: a sync engine under an async interface serialises
    // every transaction on the event loop by construction — fine for one process, and exactly
    // what the daemon does today.
    async tx(fn) {
      db.exec('BEGIN');
      try { const r = await fn(d); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async close() { db.close(); },
  };
  return d;
}

export async function pgliteDriver(dataDir) {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const prep = (sql) => toPgPlaceholders(sqliteToPostgres(sql));
  const wrap = (q) => ({
    async get(sql, params) { return (await q.query(prep(sql), params)).rows[0]; },
    async all(sql, params) { return (await q.query(prep(sql), params)).rows; },
    async run(sql, params) { return { changes: (await q.query(prep(sql), params)).affectedRows ?? 0 }; },
    async exec(sql) { await q.exec(prep(sql)); },
  });
  const d = {
    ...wrap(pg),
    async tx(fn) { return pg.transaction((t) => fn({ ...wrap(t), tx: () => { throw new Error('nested tx'); }, close: async () => {} })); },
    async close() { await pg.close(); },
  };
  return d;
}
```

- [ ] **Step 4: Port `cursors.ts` onto it**

```js
// scripts/perf/pglite-slice/cursors.mjs
// packages/server/src/store/cursors.ts (85 lines on 2026-09-29) ported to the async Driver.
// Diff against the original is the per-module conversion cost for Q4.

export async function migrate(d) {
  await d.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  await d.exec(`CREATE TABLE inbox_cursors (member_id TEXT PRIMARY KEY, last_read_message_id TEXT, last_read_ts INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  await d.exec(`CREATE TABLE audit (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, verb TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}

export async function getCursor(d, memberId) {
  const row = await d.get('SELECT * FROM inbox_cursors WHERE member_id = ?', [memberId]);
  return row
    ? { ...row, last_read_ts: Number(row.last_read_ts), updated_at: Number(row.updated_at) }
    : { member_id: memberId, last_read_message_id: null, last_read_ts: 0, updated_at: 0 };
}

async function appendReplicatedEvent(d, teamId, verb, detail) {
  await d.run('INSERT INTO audit (id, team_id, verb, detail, created_at) VALUES (?, ?, ?, ?, ?)', [
    `${Date.now()}-${Math.random().toString(36).slice(2)}`, teamId, verb, JSON.stringify(detail), Date.now(),
  ]);
}

export async function setCursor(d, memberId, lastReadMessageId) {
  return d.tx(async (t) => {
    const row = await t.get('SELECT team_id, created_at FROM messages WHERE id = ?', [lastReadMessageId]);
    if (!row) throw new Error(`setCursor: unknown message id ${lastReadMessageId}`);
    const now = Date.now();
    await t.run(
      `INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at`,
      [memberId, lastReadMessageId, Number(row.created_at), now],
    );
    await appendReplicatedEvent(t, row.team_id, 'inbox.cursor', { member_id: memberId, last_read_message_id: lastReadMessageId });
    return getCursor(t, memberId);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass on both drivers**

Run: `pnpm vitest run scripts/perf/pglite-slice/cursors.test.ts`
Expected: PASS (8 tests: 4 × 2 drivers). Two things that may surface, and what each means for
the result page: PGlite returns `BIGINT` columns as strings or bigints (the `Number(...)` casts
above are the finding — every integer column read needs one under one-dialect); `affectedRows`
naming differs by PGlite version (adjust the driver, note it).

- [ ] **Step 6: Record Q3 and the per-module cost**

```bash
wc -l packages/server/src/store/cursors.ts scripts/perf/pglite-slice/cursors.mjs
git diff --no-index --stat packages/server/src/store/cursors.ts scripts/perf/pglite-slice/cursors.mjs
```

Under **Q3**: pass/fail; the one SQL text served both; which casts or driver quirks were needed.
Under **Q4** add: lines changed for one 85-line module; multiply by the Task 2 file count for an
order-of-magnitude on the whole store, and state the transport layer's share (every HTTP/WS handler
that calls a store function becomes `await`, `packages/server/src/transport/http.ts` alone is the
largest file — give its `.prepare(`/store-call count from Task 2's `byFile`).

- [ ] **Step 7: Commit**

```bash
git add scripts/perf/pglite-slice docs/perf/pglite-spike.md
git commit -m "spike(pglite): cursors.ts on an async two-driver interface — same SQL, both engines green (Q3)

Co-authored-by: fifty <fifty@revive.musterd>"
```

---

### Task 6: Decide, record, and close the spike

**Files:**

- Modify: `docs/perf/pglite-spike.md` (Decision section, the summary table's Result column)
- Modify: `docs/decisions/475-cloud-hosted-teams-postgres.md` (Consequences: dated note)
- Modify: `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §3.3 (one dated line)

`docs/perf/` has no index; the ADR note is the pointer to the result page.

- [ ] **Step 1: Fill the Decision section with the rule applied**

```markdown
## Decision

Applied the rule from the plan: Q1 <pass/fail: N hand-fixes>, Q2 <pass/fail: worst p95 X ms on
`<query>`, boot Y ms>, Q3 <pass/fail>. Q4: <files> files, <call sites> call sites, ~<lines> lines
per module → an estimated <range> for the whole store plus transport.

**Result: one dialect** — the laptop daemon moves to PGlite and Cloud to Postgres behind one async
store layer.
— or —
**Result: two backends** — one async store interface (the Task 5 `Driver` shape) with a
better-sqlite3 driver for the laptop and a `pg` driver for Cloud; SQL text is shared where the
inventory says it can be and per-driver where it cannot (`json_extract`: <n> sites).

Falsifiers: <the number that, if it moves, reverses this — e.g. "file-backed p95 above 10 ms at
2× revive's row counts" or "more than N hand-fixes appear when migrations 1–<latest> are ported for
real">.

Out-of-process readers of `musterd.db` (Q4 list) <are / are not> a blocker: <one line>.
```

- [ ] **Step 2: Add the dated note to ADR 475 and the spec**

In `docs/decisions/475-cloud-hosted-teams-postgres.md` under `## Consequences`, append:

```markdown
- _2026-10-0N — increment 0 result:_ the PGlite spike ([`docs/perf/pglite-spike.md`](../perf/pglite-spike.md))
  was reshaped from "boot the daemon on PGlite" — impossible in two days with 62 synchronous
  better-sqlite3 store files — to four measured questions; decision 3 resolves to **<one dialect /
  two backends>**. The async store conversion is owed either way and is sized there (<n> files,
  <n> call sites). `@electric-sql/pglite` <stays a spike devDependency / needs its ADR 002 note at
  increment 1>.
```

In the spec §3.3, after the paragraph ending "which is why it cannot run in parallel or later.":

```markdown
_Result (2026-10-0N): <one dialect / two backends> — `docs/perf/pglite-spike.md`._
```

- [ ] **Step 3: Fast gates, commit, push, PR**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add docs/perf/pglite-spike.md docs/decisions/475-cloud-hosted-teams-postgres.md docs/superpowers/specs/2026-09-29-musterd-cloud-design.md
git commit -m "docs(adr-475): increment 0 result — PGlite spike decides <one dialect / two backends>

Refs ADR-475

Co-authored-by: fifty <fifty@revive.musterd>"
git push -u origin spike/pglite
gh pr create --title "Cloud increment 0 — PGlite spike result (ADR 475)" --body "..." && gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 4: Lane bookkeeping**

`lane_submit` the lane with `{pr, sha, authorized_by: 'nick'}`; follow the reply. Then write the
increment 1 plan (`docs/superpowers/plans/2026-10-0N-cloud-increment-1-app-tier.md`) — its store
tasks depend on this result, which is why it is not in this document.

---

## Self-review

- **Spec coverage.** §3.3's three measurements: "boot the daemon on PGlite" → reshaped and
  justified in the preamble, sized by Q4; "run the server suite" → Q1 (schema) + Q3 (one module's
  suite on both drivers), with the honest gap stated; "measure hook-path latency against SQLite" →
  Q2 with the real gate queries. ADR 475 Obs&Eval's pass/fail wording is amended by Task 6's note.
- **Placeholders.** None: every task has its test and its code; Task 6's `<…>` are values the run
  produces, not work left undone.
- **Type consistency.** `toPgPlaceholders` and `sqliteToPostgres` are defined in Tasks 4 and 3 and
  imported by 5 with those names; `Driver.run` returns `{changes}` in both drivers; `QUERY_NAMES`
  is the same list in the bench and its test.
- **Review Focus.** 1 → Task 4 test pins `n === rounds` after a discarded warm-up; 2 → Task 2 test
  pins `json_extract` as its own construct; 3 → Task 2 Step 5 lists the readers; 4 → Task 5's
  literal-`?` test; 5 → Task 4 seeds at scale 1 and prints the counts in the table.
