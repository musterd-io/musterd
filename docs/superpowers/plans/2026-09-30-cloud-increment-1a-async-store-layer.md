# Cloud increment 1A — the async store layer (one driver interface, two backends) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`, in the implementer's own seat and lane — this repo does not dispatch writing subagents (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every store read and write in `@musterd/server` goes through one async `Driver` interface, `better-sqlite3` behind it on the laptop and PGlite (as the Postgres double) in tests, with the whole server suite green on both — and **no behaviour change** for any self-hosted daemon.

**Architecture:** A `Driver` (`get / all / run / exec / tx / close`, `?` placeholders, the driver owns its dialect) replaces the raw `better-sqlite3` handle on `Ctx`. The SQLite driver wraps the existing handle and serialises transactions with a queue, so semantics stay exactly today's. A ≤300-line dialect translator turns the SQLite-flavoured SQL text into Postgres text once per statement; the PGlite driver applies it. Store modules convert **leaf-first, in dependency clusters**, each cluster's existing tests re-run on both drivers before the next cluster starts; a transition-only `raw` escape hatch lets a converted module call an unconverted one synchronously, and the last task deletes it.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), better-sqlite3 (runtime), `@electric-sql/pglite` 0.5.x (devDependency, tests only), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §3.3 / §9 (increment 1); `docs/decisions/475-cloud-hosted-teams-postgres.md`; `docs/decisions/479-two-store-backends.md` (the shape this plan implements); `docs/perf/pglite-spike.md` Q3/Q4 (the measured call-site inventory and the transaction finding).

## Scope check — increment 1 is four plans, this is the first

Increment 1 ("app tier + Postgres + cloud mode, with the test issuer") is four independently shippable subsystems. Each later one depends on this one and on nothing else in the list:

| plan | delivers | done when |
| --- | --- | --- |
| **1A — this plan** | async `Driver`, SQLite driver, dialect translator, PGlite test double, the ~70-file store conversion | server suite green on **both** drivers in CI; self-hosted daemon behaviour unchanged (falsifier below) |
| 1B — Postgres for real | `pg` driver over a pool, a real Postgres migration ladder (expand/contract, ADR 475 §10), RLS on every team-owned table, `SET LOCAL` team context per transaction, the **tenancy leak test** (spec §8.2) | tenancy test green as the app role through the pooler with alternating tenants |
| 1C — cloud mode | `MUSTERD_MODE=cloud` and its six effects (spec §5): loopback audit + test issuer (JWKS), host-name isolation, rate limits, ok/not-ok `/health` with stable 503 sentences, boot-time schema guard | loopback audit test + 503 test green (spec §8.3, §8 "increment 1") |
| 1D — deploy + acceptance | Fly app tier (N ≥ 2) over Neon behind Cloudflare, LISTEN/NOTIFY presence fan-out, the load test and the rolling-schema deploy | spec §8.1 and §8.4 green |

1B–1D get their own plans when 1A lands; their interfaces to 1A are named in this plan's `Produces` blocks so nothing here has to be reopened.

## Global Constraints

- **No behaviour change for self-hosted.** Falsifier: the full server + cli suites pass on the SQLite driver with **zero test-assertion edits** other than `await`/async plumbing; `/health` shape, `daemon.log` lines and the gate hook path timing are unchanged (gate p95 measured before/after on the dev laptop with `scripts/perf/pglite-hookpath.mjs`'s query set).
- **One async interface**: `get / all / run / exec / tx / close`, `?` placeholders, the driver owns the dialect (ADR 479 §2). No module above the driver may branch on dialect except `store/teamMemory.ts` (FTS5 vs `tsvector`, ADR 479 Consequences).
- **The dialect translation layer stays under ~300 lines** with the nested-`json_extract` and typed-comparison sites covered by tests (ADR 479 §4 — the falsifier of the whole two-backend decision; a test pins the line count).
- **SQLite transactions keep today's semantics**: nothing interleaves inside an open transaction (spike Q3 finding; ADR 479 §2 "transaction queue").
- **PGlite is not a runtime dependency**: it stays a devDependency; `packages/server/dist` must not import it (a test greps the bundle).
- **No new runtime dependency without an ADR** (hard rule 6). This plan adds none: `better-sqlite3` stays; PGlite moves from the root `devDependencies` to `packages/server` `devDependencies` (still dev).
- **`@musterd/protocol` untouched** (hard rule 1). Nothing here is protocol.
- **Docs in the same commit** (hard rule 3): `docs/architecture/03-server.md` file tree (drift-checked by `arch-trees:check`) gains a described line for every new file; `01-data-model.md` gets a "two dialects" paragraph; ADR 479 Consequences gets a dated note with the measured translator line count.
- Node ≥ 22 for the daemon (better-sqlite3 ABI, AGENTS.md trap) — unchanged.
- Vocabulary: `pnpm vocab:check` — no `template` (use "pre-seeded"), work-item nouns are Goal / Lane.

## Review Focus

1. **A store call issued while another request's transaction is open on the SQLite driver.** Expected: it waits for the commit and then runs — never executes inside the foreign transaction, never throws "cannot start a transaction within a transaction". Pinned in Task 1 (`sqliteDriver.test.ts` "concurrent tx serialise", "run() during an open tx waits").
2. **A nested `json_extract` path or a numeric comparison on an extracted value, on Postgres.** Expected: `'$.gate.fingerprint'` reads the nested key; `json_extract(meta,'$.urgent') = 1` matches a JSON number `1`. Pinned in Task 2 (`dialect.test.ts`) and exercised end-to-end by `interruptCandidates` / `gateAsk` / `delivery` tests on the PGlite driver (Tasks 9, 7).
3. **A `LIKE` that today relies on SQLite's case-insensitivity.** Expected: same matches on Postgres. Pinned in Task 2 (`LIKE` → `ILIKE` rewrite test) and by the 4 sites' existing tests on PGlite.
4. **A `BIGINT` epoch-millis column read back from PGlite.** Expected: a JS `number`, not a string, everywhere a timestamp is compared or subtracted. Pinned in Task 3 (`pgliteDriver.test.ts` "integers come back as numbers") — the driver installs a BIGINT parser; no `Number()` sprinkling in modules.
5. **A store function that throws inside `tx()`.** Expected: the transaction rolls back on both drivers, the error propagates unchanged, and the next `tx()` on the same driver starts clean. Pinned in Task 1 and Task 3 ("throw inside tx rolls back and the driver is reusable").

---

## The conversion recipe (applied by every store task; written once)

The transformation is mechanical. Every conversion task below applies these rules to its files; a task lists only what is *specific* to its files (transactions, `json_extract` shapes, dialect branches, callers outside the store).

**Signatures.**

```ts
// before
export function listFoo(db: Database, teamId: string): FooRow[] { … }
// after
export async function listFoo(db: Driver, teamId: string): Promise<FooRow[]> { … }
```

`import type Database from 'better-sqlite3'` → `import type { Driver } from '../db/driver.js'`.

**Statements.**

| before | after |
| --- | --- |
| `db.prepare<[A,B], R>(sql).get(a, b)` | `await db.get<R>(sql, [a, b])` |
| `db.prepare<[A], R>(sql).all(a)` | `await db.all<R>(sql, [a])` |
| `db.prepare<[A]>(sql).run(a).changes` | `(await db.run(sql, [a])).changes` |
| `db.prepare(sql).run(a)` (result unused) | `await db.run(sql, [a])` |
| `db.exec(sql)` | `await db.exec(sql)` |
| `db.pragma(…)` in a store module | move to `db/open.ts` (SQLite-only, at open) or `sqliteDriver` |
| `const stmt = db.prepare(sql); for (…) stmt.run(x)` | `for (…) await db.run(sql, [x])` — the driver caches prepared statements by SQL text |
| `.get()` with no params | `await db.get<R>(sql)` (params default `[]`) |

**Transactions.**

```ts
// before
const apply = db.transaction((a: A) => { …sync body… ; return r; });
return apply(a);
// after
return db.tx(async (t) => { …same body, every statement on `t` and awaited… ; return r; });
```

Inside the body **every** statement goes through `t`, never the outer `db` (on SQLite the outer handle would wait on the queue → deadlock; the driver throws `DriverError('outer handle used inside tx')` in test builds to catch it). Store helpers called inside a body take `t` as their `db` argument — that is why helpers take `Driver`, not a concrete class.

**Callers.** Every caller of a converted function gains `await` and becomes `async` up to the nearest already-async boundary (http handlers already are; ws message handlers, reaper ticks, sync loops and `index.ts` wiring become `async` with a `.catch` that logs — the exact spot is named in the task that owns the caller). TypeScript enforces this: an un-awaited Promise where a value was expected is a type error, so **`pnpm -C packages/server exec tsc --noEmit` is the completeness check** after every task.

**Transition escape hatch.** Until Task 24, `SqliteDriver` exposes `raw: Database.Database`. A converted module that must call a not-yet-converted synchronous function passes `asRaw(db)` (throws on a non-SQLite driver — so that module's tests stay SQLite-only until its callee converts). Task 24 deletes `asRaw` and the grep must be empty.

**Tests.** A converted module's test file switches from

```ts
const db = openDb(':memory:');
```

to

```ts
import { withDrivers } from '../db/testing.js';
withDrivers('lanes', (open) => {
  let db: Driver;
  beforeEach(async () => { db = await open(); });
  afterEach(async () => { await db.close(); });
  it('…', async () => { … await … });
});
```

`withDrivers` runs the block under `describe.each` over the drivers named by `MUSTERD_TEST_DRIVER` (`sqlite` | `pglite` | `both`; default `both` from Task 24 on, `sqlite` before it — so CI stays green while clusters convert; a converted test file passes `{ pglite: true }` to opt in early once its dependency closure is converted). Tests that boot a whole server keep `createServer({ db: openDb(':memory:') })` — `createServer` accepts a raw handle and wraps it (Task 4) — and are SQLite-only until Task 24 flips the default.

**Per-task loop.** (1) convert the files; (2) `pnpm -C packages/server exec tsc --noEmit` until clean; (3) run the cluster's tests on SQLite; (4) if the closure is converted, opt the tests into PGlite and run `MUSTERD_TEST_DRIVER=pglite`; (5) `pnpm lint` on the files; (6) commit `refactor(store): <cluster> on the async Driver (1A task N)`.

---

### Task 1: The `Driver` interface and the SQLite driver with a transaction queue

**Files:**
- Create: `packages/server/src/db/driver.ts`
- Create: `packages/server/src/db/sqliteDriver.ts`
- Create: `packages/server/src/db/sqliteDriver.test.ts`
- Modify: `docs/architecture/03-server.md` (file tree: two described lines)

**Interfaces:**
- Consumes: `better-sqlite3`'s `Database` (existing).
- Produces:
  ```ts
  export type Params = ReadonlyArray<string | number | bigint | null | Uint8Array>;
  export interface Driver {
    readonly dialect: 'sqlite' | 'postgres';
    get<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R | undefined>;
    all<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R[]>;
    run(sql: string, params?: Params): Promise<{ changes: number }>;
    exec(sql: string): Promise<void>;
    tx<T>(fn: (t: Driver) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  }
  export class DriverError extends Error { constructor(msg: string, readonly code: 'outer_handle_in_tx' | 'not_sqlite' | 'closed') }
  export function sqliteDriver(db: Database.Database): SqliteDriver;   // SqliteDriver implements Driver, has `raw: Database.Database`
  export function asRaw(db: Driver): Database.Database;               // transition-only; throws DriverError('not_sqlite')
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/db/sqliteDriver.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DriverError, asRaw, sqliteDriver } from './sqliteDriver.js';

function fresh() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return sqliteDriver(raw);
}

describe('sqliteDriver', () => {
  it('get/all/run/exec round-trip with ? placeholders and report changes', async () => {
    const d = fresh();
    expect(d.dialect).toBe('sqlite');
    expect(await d.run('INSERT INTO t (v) VALUES (?)', ['a'])).toEqual({ changes: 1 });
    await d.exec("INSERT INTO t (v) VALUES ('b')");
    expect(await d.get<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])).toEqual({ v: 'a' });
    expect(await d.all<{ v: string }>('SELECT v FROM t ORDER BY id')).toEqual([{ v: 'a' }, { v: 'b' }]);
    expect(await d.get('SELECT v FROM t WHERE id = ?', [99])).toBeUndefined();
  });

  it('tx commits, and a throw inside rolls back and leaves the driver reusable', async () => {
    const d = fresh();
    await d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['a']);
    });
    await expect(
      d.tx(async (t) => {
        await t.run('INSERT INTO t (v) VALUES (?)', ['b']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await d.all('SELECT v FROM t')).toEqual([{ v: 'a' }]);
    await d.tx(async (t) => t.run('INSERT INTO t (v) VALUES (?)', ['c']));
    expect((await d.all('SELECT v FROM t')).length).toBe(2);
  });

  it('two concurrent tx() calls serialise — the second sees the first committed', async () => {
    const d = fresh();
    const order: string[] = [];
    const a = d.tx(async (t) => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      await t.run('INSERT INTO t (v) VALUES (?)', ['a']);
      order.push('a-end');
    });
    const b = d.tx(async (t) => {
      order.push('b-start');
      const n = await t.get<{ n: number }>('SELECT COUNT(*) AS n FROM t');
      order.push(`b-sees-${n!.n}`);
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-sees-1']);
  });

  it('a statement on the outer handle during an open tx waits for the commit', async () => {
    const d = fresh();
    const seen: number[] = [];
    const tx = d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['a']);
      await new Promise((r) => setTimeout(r, 20));
    });
    const outside = d.get<{ n: number }>('SELECT COUNT(*) AS n FROM t').then((r) => seen.push(r!.n));
    await Promise.all([tx, outside]);
    expect(seen).toEqual([1]); // ran after commit, not inside
  });

  it('nested tx is a savepoint: inner rollback keeps the outer work', async () => {
    const d = fresh();
    await d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['outer']);
      await t.tx(async (t2) => {
        await t2.run('INSERT INTO t (v) VALUES (?)', ['inner']);
        throw new Error('inner');
      }).catch(() => undefined);
    });
    expect(await d.all('SELECT v FROM t')).toEqual([{ v: 'outer' }]);
  });

  it('using the outer handle from inside a tx body is a DriverError', async () => {
    const d = fresh();
    await expect(
      d.tx(async () => {
        await d.run('INSERT INTO t (v) VALUES (?)', ['x']); // wrong handle
      }),
    ).rejects.toBeInstanceOf(DriverError);
  });

  it('asRaw hands back the better-sqlite3 handle and refuses anything else', () => {
    const d = fresh();
    expect(asRaw(d)).toBe(d.raw);
    expect(() => asRaw({ ...d, dialect: 'postgres' } as never)).toThrow(DriverError);
  });

  it('close() makes every call a DriverError("closed")', async () => {
    const d = fresh();
    await d.close();
    await expect(d.get('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C packages/server exec vitest run src/db/sqliteDriver.test.ts`
Expected: FAIL — `Cannot find module './sqliteDriver.js'`.

- [ ] **Step 3: Write `driver.ts`**

```ts
// packages/server/src/db/driver.ts
/**
 * The one store interface (ADR 479 §2): every read and write in the server goes through it, and the
 * driver owns the dialect. `?` placeholders everywhere; a Postgres driver renumbers them. Params are
 * an array, never spread. `tx` hands the body a Driver bound to the transaction — statements inside
 * the body go through THAT handle (the SQLite driver serialises; the outer handle would wait).
 */
export type Params = ReadonlyArray<string | number | bigint | null | Uint8Array>;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  get<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R | undefined>;
  all<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R[]>;
  run(sql: string, params?: Params): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (t: Driver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DriverErrorCode = 'outer_handle_in_tx' | 'not_sqlite' | 'closed';

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: DriverErrorCode,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
```

- [ ] **Step 4: Write `sqliteDriver.ts`**

```ts
// packages/server/src/db/sqliteDriver.ts
import type Database from 'better-sqlite3';
import { DriverError, type Driver, type Params } from './driver.js';

/**
 * better-sqlite3 behind the async Driver. Every statement is synchronous underneath; the Promise is
 * the interface, not concurrency. Transactions are a QUEUE (ADR 479 §2 / spike Q3): one `tx` runs
 * at a time, statements from outside an open tx wait for its commit, and the body's statements go
 * through the tx handle — so today's "nothing interleaves inside db.transaction(fn)" holds exactly.
 * Nested tx = SAVEPOINT.
 */
export interface SqliteDriver extends Driver {
  readonly dialect: 'sqlite';
  /** Transition-only (plan 1A Task 24 removes it): the raw handle for not-yet-converted callees. */
  readonly raw: Database.Database;
}

export function sqliteDriver(raw: Database.Database): SqliteDriver {
  const stmts = new Map<string, Database.Statement>();
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  let closed = false;
  // The queue: the promise of the currently open transaction, or null.
  let open: Promise<unknown> | null = null;
  let depth = 0;

  const assertOpen = () => {
    if (closed) throw new DriverError('driver is closed', 'closed');
  };
  const wait = async () => {
    while (open) await open.catch(() => undefined);
  };

  // `insideTx` true ⇒ this handle belongs to the running tx and never waits.
  const make = (insideTx: boolean): Driver & { raw: Database.Database } => {
    const guard = async () => {
      assertOpen();
      if (insideTx) return;
      if (open && depth > 0 && currentBodyRunning) {
        throw new DriverError('outer handle used inside tx — use the tx handle', 'outer_handle_in_tx');
      }
      await wait();
    };
    return {
      dialect: 'sqlite',
      raw,
      async get<R>(sql: string, params: Params = []) {
        await guard();
        return prep(sql).get(...(params as unknown[])) as R | undefined;
      },
      async all<R>(sql: string, params: Params = []) {
        await guard();
        return prep(sql).all(...(params as unknown[])) as R[];
      },
      async run(sql: string, params: Params = []) {
        await guard();
        return { changes: Number(prep(sql).run(...(params as unknown[])).changes) };
      },
      async exec(sql: string) {
        await guard();
        raw.exec(sql);
      },
      async tx<T>(fn: (t: Driver) => Promise<T>): Promise<T> {
        assertOpen();
        if (insideTx) {
          // nested: savepoint on the same connection, same queue slot
          const name = `sp${++depth}`;
          raw.exec(`SAVEPOINT ${name}`);
          try {
            const r = await fn(make(true));
            raw.exec(`RELEASE ${name}`);
            return r;
          } catch (e) {
            raw.exec(`ROLLBACK TO ${name}`);
            raw.exec(`RELEASE ${name}`);
            throw e;
          } finally {
            depth--;
          }
        }
        await wait();
        let release!: () => void;
        open = new Promise<void>((r) => (release = r));
        depth = 1;
        currentBodyRunning = true;
        raw.exec('BEGIN');
        try {
          const r = await fn(make(true));
          raw.exec('COMMIT');
          return r;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        } finally {
          depth = 0;
          currentBodyRunning = false;
          open = null;
          release();
        }
      },
      async close() {
        await wait();
        closed = true;
        stmts.clear();
        raw.close();
      },
    };
  };
  let currentBodyRunning = false;
  const outer = make(false) as SqliteDriver;
  return outer;
}

/** Transition-only (Task 24 deletes it): a converted module calling a still-synchronous callee. */
export function asRaw(db: Driver): Database.Database {
  const raw = (db as Partial<SqliteDriver>).raw;
  if (db.dialect !== 'sqlite' || !raw) throw new DriverError('this path is SQLite-only during the store conversion', 'not_sqlite');
  return raw;
}
```

Note for the implementer: the "outer handle inside tx" detection is a heuristic — the outer handle is used while a tx body is running on this connection. It exists to catch the deadlock at development time (a test that hangs is worse than one that throws). Keep it.

- [ ] **Step 5: Run the tests**

Run: `pnpm -C packages/server exec vitest run src/db/sqliteDriver.test.ts`
Expected: 8 passed. If "outer handle" test hangs instead of throwing, the guard ordering is wrong: `assertOpen` → outer-in-tx check → `wait()`.

- [ ] **Step 6: Arch tree + commit**

Add to `docs/architecture/03-server.md` under `db/`:

```
    driver.ts         // ADR 479 §2: the one async store interface — Driver {get, all, run, exec, tx, close}, `?` placeholders, the driver owns the dialect; DriverError
    sqliteDriver.ts   // better-sqlite3 behind Driver: prepared-statement cache by SQL text, a transaction QUEUE (one tx at a time, outside statements wait for the commit, nested = SAVEPOINT) so today's db.transaction semantics hold exactly; `raw` + asRaw are transition-only (plan 1A Task 24 removes them)
```

```bash
git add packages/server/src/db/driver.ts packages/server/src/db/sqliteDriver.ts packages/server/src/db/sqliteDriver.test.ts docs/architecture/03-server.md
git commit -m "feat(db): async Driver interface and the SQLite driver with a transaction queue (1A task 1)"
```

---

### Task 2: The dialect translator (SQLite SQL text → Postgres), under 300 lines

**Files:**
- Create: `packages/server/src/db/dialect.ts`
- Create: `packages/server/src/db/dialect.test.ts`
- Modify: `docs/architecture/03-server.md`

**Interfaces:**
- Produces: `export function toPostgres(sql: string): string` (memoised by input text) and `export const DIALECT_SOURCE_LINE_BUDGET = 300`.
- Consumed by: Task 3's PGlite driver; plan 1B's `pg` driver (same function).

Rules, each with a test (they come from spike Q3/Q4 — `scripts/perf/pglite-hookpath.mjs` `toPgPlaceholders` and `scripts/perf/pglite-schema.mjs` `sqliteToPostgres` are the reference; port, do not import, the spike is throwaway):

1. `?` → `$1, $2, …` **outside string literals** (`'why?'` survives).
2. `json_extract(col, '$.k')` → `(col::jsonb ->> 'k')`.
3. `json_extract(col, '$.a.b.c')` → `(col::jsonb #>> '{a,b,c}')` (nested; 16 sites in the inventory).
4. `json_extract(col, '$.k') = 1` / `< 5` / `>= 0` (a numeric literal) → `((col::jsonb ->> 'k')::numeric = 1)` — the 3 typed-compare sites; the cast is applied when the right-hand side is a numeric literal. Same for nested.
5. `LIKE` → `ILIKE` (the 4 sites rely on SQLite's case-insensitive `LIKE`; Postgres's is not).
6. `INSERT OR IGNORE INTO` → `INSERT INTO … ON CONFLICT DO NOTHING` (6 sites; the `ON CONFLICT` clause is appended before a trailing `RETURNING` if present, else at the end).
7. `INSERT OR REPLACE` — 0 sites; **not supported**, the translator throws `DialectError` so a new one fails loudly in the PGlite run.
8. `datetime('now')`, `strftime`, `unixepoch`, `GLOB`, `iif(`, `COLLATE NOCASE`, `last_insert_rowid()` — 0 sites each; throw `DialectError` (same reason).
9. Identifiers and everything else pass through unchanged. `ON CONFLICT (…) DO UPDATE SET x = excluded.x` and `RETURNING` are already Postgres.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/db/dialect.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIALECT_SOURCE_LINE_BUDGET, DialectError, toPostgres } from './dialect.js';

describe('toPostgres', () => {
  it('renumbers ? placeholders outside string literals', () => {
    expect(toPostgres("SELECT ? AS a, 'why?' AS b, ? AS c")).toBe("SELECT $1 AS a, 'why?' AS b, $2 AS c");
  });
  it('flat json_extract → ->>', () => {
    expect(toPostgres("SELECT json_extract(meta, '$.lane') FROM m")).toBe("SELECT (meta::jsonb ->> 'lane') FROM m");
  });
  it('nested json_extract → #>> with an array path', () => {
    expect(toPostgres("WHERE json_extract(detail, '$.gate.fingerprint') = ?")).toBe(
      "WHERE (detail::jsonb #>> '{gate,fingerprint}') = $1",
    );
  });
  it('a numeric literal comparison casts the extracted text', () => {
    expect(toPostgres("WHERE json_extract(meta, '$.urgent') = 1")).toBe("WHERE ((meta::jsonb ->> 'urgent')::numeric = 1)");
    expect(toPostgres("WHERE json_extract(d, '$.a.b') >= 10")).toBe("WHERE ((d::jsonb #>> '{a,b}')::numeric >= 10)");
  });
  it('a placeholder comparison does NOT cast (the param decides)', () => {
    expect(toPostgres("WHERE json_extract(meta, '$.lane') = ?")).toBe("WHERE (meta::jsonb ->> 'lane') = $1");
  });
  it('LIKE becomes ILIKE', () => {
    expect(toPostgres('WHERE name LIKE ?')).toBe('WHERE name ILIKE $1');
  });
  it('INSERT OR IGNORE → ON CONFLICT DO NOTHING, before RETURNING when present', () => {
    expect(toPostgres('INSERT OR IGNORE INTO t (a) VALUES (?)')).toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
    expect(toPostgres('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING id')).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
    );
  });
  it('refuses the SQLite-only constructs the inventory found none of', () => {
    for (const sql of [
      'INSERT OR REPLACE INTO t VALUES (1)',
      "SELECT datetime('now')",
      "SELECT strftime('%s','now')",
      'SELECT last_insert_rowid()',
      "SELECT 1 WHERE a GLOB 'x*'",
      'SELECT iif(1,2,3)',
      'SELECT a COLLATE NOCASE',
    ]) {
      expect(() => toPostgres(sql), sql).toThrow(DialectError);
    }
  });
  it('passes Postgres-shaped text through and memoises', () => {
    const sql = 'INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = excluded.b RETURNING id';
    const out = toPostgres(sql);
    expect(out).toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET b = excluded.b RETURNING id');
    expect(toPostgres(sql)).toBe(out);
  });
  it('stays under the ADR 479 §4 line budget', () => {
    const lines = readFileSync(new URL('./dialect.ts', import.meta.url), 'utf8').split('\n').length;
    expect(lines).toBeLessThan(DIALECT_SOURCE_LINE_BUDGET);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C packages/server exec vitest run src/db/dialect.test.ts` — Expected: FAIL, module missing.

- [ ] **Step 3: Write `dialect.ts`**

```ts
// packages/server/src/db/dialect.ts
/**
 * SQLite-flavoured SQL text → Postgres text, once per distinct statement (ADR 479 §4). This file is
 * budgeted: under DIALECT_SOURCE_LINE_BUDGET lines, or the two-backend decision is revisited. Rules
 * cover exactly what the Q4 inventory found (docs/perf/pglite-spike.md); anything SQLite-only that
 * the inventory found zero of throws, so a new use fails in the PGlite run rather than in Cloud.
 */
export const DIALECT_SOURCE_LINE_BUDGET = 300;

export class DialectError extends Error {
  constructor(construct: string, sql: string) {
    super(`SQLite-only construct "${construct}" has no Postgres rewrite here: ${sql.slice(0, 120)}`);
    this.name = 'DialectError';
  }
}

const REFUSED: Array<[string, RegExp]> = [
  ['INSERT OR REPLACE', /\bINSERT\s+OR\s+REPLACE\b/i],
  ['datetime(', /\bdatetime\s*\(/i],
  ['strftime', /\bstrftime\s*\(/i],
  ['unixepoch', /\bunixepoch\b/i],
  ['GLOB', /\bGLOB\b/],
  ['iif(', /\biif\s*\(/i],
  ['COLLATE NOCASE', /\bCOLLATE\s+NOCASE\b/i],
  ['last_insert_rowid', /\blast_insert_rowid\s*\(/i],
];

const cache = new Map<string, string>();

export function toPostgres(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  const out = translate(sql);
  cache.set(sql, out);
  return out;
}

/** Split into [code, literal, code, literal, …] so rewrites never touch string literals. */
function outsideLiterals(sql: string, fn: (code: string) => string): string {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

function jsonPath(path: string): { op: '->>' | '#>>'; rhs: string } {
  const keys = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  return keys.length <= 1 ? { op: '->>', rhs: `'${keys[0] ?? ''}'` } : { op: '#>>', rhs: `'{${keys.join(',')}}'` };
}

function translate(sql: string): string {
  for (const [name, re] of REFUSED) if (re.test(sql)) throw new DialectError(name, sql);

  // json_extract(col, '$.path') [op numeric-literal]  — the literal check decides the cast.
  const JSON_X = /json_extract\(\s*([A-Za-z_][\w.]*)\s*,\s*'(\$[^']*)'\s*\)(\s*(=|<>|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)(?![\w.]))?/g;
  let out = sql.replace(JSON_X, (_m, col: string, path: string, cmp: string | undefined, op?: string, num?: string) => {
    const { op: jop, rhs } = jsonPath(path);
    const expr = `(${col}::jsonb ${jop} ${rhs})`;
    return cmp ? `(${expr}::numeric ${op} ${num})` : expr;
  });

  out = outsideLiterals(out, (code) =>
    code
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO') // normalise case for the step below
      .replace(/\bLIKE\b/g, 'ILIKE'),
  );

  if (/INSERT OR IGNORE INTO/.test(out)) {
    out = out.replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO');
    const m = /\s+RETURNING\b[\s\S]*$/.exec(out);
    out = m ? `${out.slice(0, m.index)} ON CONFLICT DO NOTHING${m[0]}` : `${out} ON CONFLICT DO NOTHING`;
  }

  let n = 0;
  return outsideLiterals(out, (code) => code.replace(/\?/g, () => `$${++n}`));
}
```

- [ ] **Step 4: Run the tests** — Expected: 11 passed. If the `RETURNING` case fails, the `INSERT OR IGNORE` step ran before placeholder renumbering (correct) but the regex anchored to end-of-string swallowed a trailing space; trim.

- [ ] **Step 5: Arch tree + commit**

`03-server.md` `db/` line: `dialect.ts         // ADR 479 §4: SQLite SQL text → Postgres, memoised per statement — ? → $n outside literals, json_extract flat → ->> / nested → #>> / numeric-literal compare → ::numeric, LIKE → ILIKE, INSERT OR IGNORE → ON CONFLICT DO NOTHING; refuses the SQLite-only constructs the Q4 inventory found none of; a test pins it under 300 lines`

```bash
git add packages/server/src/db/dialect.ts packages/server/src/db/dialect.test.ts docs/architecture/03-server.md
git commit -m "feat(db): dialect translator SQLite→Postgres, budgeted under 300 lines (1A task 2)"
```

---

### Task 3: The PGlite test double, the Postgres schema loader, and the `withDrivers` harness

**Files:**
- Modify: `package.json` (root) — remove `@electric-sql/pglite` from `devDependencies`; Modify: `packages/server/package.json` — add it to `devDependencies` (same version, `^0.5.8`); run `pnpm install`.
- Create: `packages/server/src/db/pgliteDriver.ts`
- Create: `packages/server/src/db/pgSchema.ts`
- Create: `packages/server/src/db/testing.ts`
- Create: `packages/server/src/db/pgliteDriver.test.ts`
- Create: `packages/server/src/db/noPgliteInDist.test.ts`
- Modify: `docs/architecture/03-server.md`

**Interfaces:**
- Consumes: `toPostgres` (Task 2), `runMigrations` / `openDb` (existing).
- Produces:
  ```ts
  // pgliteDriver.ts
  export async function pgliteDriver(opts?: { dataDir?: string }): Promise<Driver>;   // dialect 'postgres'
  // pgSchema.ts
  export function pgSchemaStatements(): string[];          // the CURRENT SQLite schema, translated; memoised
  export async function loadPgSchema(d: Driver): Promise<void>;
  // testing.ts
  export type DriverKind = 'sqlite' | 'pglite';
  export function testDriverKinds(opts?: { pglite?: boolean }): DriverKind[];   // reads MUSTERD_TEST_DRIVER
  export async function openTestDriver(kind: DriverKind): Promise<Driver>;      // migrated, empty
  export function withDrivers(name: string, fn: (open: () => Promise<Driver>, kind: DriverKind) => void, opts?: { pglite?: boolean }): void;
  ```

`pgSchema.ts` is **interim** (plan 1B replaces it with a real Postgres migration ladder): it opens an in-memory better-sqlite3 db, runs the ladder, reads `sqlite_master`, and translates the DDL with the spike's Q1 rules (`INTEGER PRIMARY KEY` → `BIGINT PRIMARY KEY`, `INTEGER` → `BIGINT`, `REAL` → `DOUBLE PRECISION`, `BLOB` → `BYTEA`, drop `WITHOUT ROWID`, `) VIRTUAL` → `) STORED`, `json_extract` in generated columns via `toPostgres`) plus the **four hand-fixes** the spike needed, all FTS5: `insights_fts` becomes an ordinary table `(message_id TEXT PRIMARY KEY, team_id TEXT, headline TEXT, body TEXT, tags TEXT, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(headline,'') || ' ' || coalesce(body,'') || ' ' || coalesce(tags,''))) STORED)` with a GIN index, and the three FTS triggers become `plpgsql` trigger functions that upsert/delete that row. Copy the exact translated statements from `scripts/perf/pglite-schema.mjs` `applyHandFixes` — they are the ones that loaded 106/106 on 2026-09-29.

PGlite driver specifics (from spike Q3): `?` placeholders through `toPostgres`; `affectedRows ?? 0` → `changes`; **BIGINT parser** so epoch-millis come back as JS numbers (`parsers: { 20: (v) => Number(v) }` in the PGlite constructor — the OID for `int8`); `tx` via `pg.transaction(t => fn(wrap(t)))`, nested `tx` → `SAVEPOINT` on the same `t`. Fresh instances are slow (~1.5 s in-memory) — `openTestDriver('pglite')` keeps **one migrated in-memory instance per worker** and gives each test a clean state by `TRUNCATE` of every table in `pgSchemaStatements()` order-independent (`TRUNCATE a, b, c … CASCADE`), which the spike measured at ~0.5 s per file.

- [ ] **Step 1: Move the dependency** — root `package.json` devDependencies: delete the `@electric-sql/pglite` line; `packages/server/package.json` devDependencies: add `"@electric-sql/pglite": "^0.5.8"`; run `pnpm install`; commit `chore(deps): pglite is @musterd/server's dev dependency (the pg driver's test double)`.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/server/src/db/pgliteDriver.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { loadPgSchema } from './pgSchema.js';
import { pgliteDriver } from './pgliteDriver.js';
import { openTestDriver, testDriverKinds, withDrivers } from './testing.js';

describe('pgliteDriver', () => {
  const dp = pgliteDriver();
  afterAll(async () => (await dp).close());

  it('translates ? placeholders and reports changes', async () => {
    const d = await dp;
    expect(d.dialect).toBe('postgres');
    await d.exec('CREATE TABLE t (id BIGINT PRIMARY KEY, v TEXT, ts BIGINT)');
    expect(await d.run('INSERT INTO t (id, v, ts) VALUES (?, ?, ?)', [1, 'a', 1790000000000])).toEqual({ changes: 1 });
    expect(await d.get<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])).toEqual({ v: 'a' });
  });

  it('integers come back as numbers, not strings', async () => {
    const d = await dp;
    const row = await d.get<{ ts: number; n: number }>('SELECT ts, COUNT(*) AS n FROM t GROUP BY ts');
    expect(typeof row!.ts).toBe('number');
    expect(row!.ts).toBe(1790000000000);
    expect(typeof row!.n).toBe('number');
  });

  it('throw inside tx rolls back and the driver is reusable; nested tx is a savepoint', async () => {
    const d = await dp;
    await expect(
      d.tx(async (t) => {
        await t.run('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'b']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await d.all('SELECT id FROM t')).toEqual([{ id: 1 }]);
    await d.tx(async (t) => {
      await t.run('INSERT INTO t (id, v) VALUES (?, ?)', [3, 'c']);
      await t.tx(async (t2) => {
        await t2.run('INSERT INTO t (id, v) VALUES (?, ?)', [4, 'd']);
        throw new Error('inner');
      }).catch(() => undefined);
    });
    expect((await d.all('SELECT id FROM t ORDER BY id')).map((r) => r['id'])).toEqual([1, 3]);
  });

  it('json_extract shapes work end to end on Postgres', async () => {
    const d = await dp;
    await d.exec('CREATE TABLE m (id BIGINT, meta TEXT)');
    await d.run('INSERT INTO m VALUES (?, ?)', [1, JSON.stringify({ urgent: 1, gate: { fingerprint: 'fp' }, lane: 'L' })]);
    expect(await d.get("SELECT id FROM m WHERE json_extract(meta, '$.urgent') = 1")).toEqual({ id: 1 });
    expect(await d.get("SELECT id FROM m WHERE json_extract(meta, '$.gate.fingerprint') = ?", ['fp'])).toEqual({ id: 1 });
    expect(await d.get("SELECT id FROM m WHERE json_extract(meta, '$.lane') LIKE ?", ['l'])).toEqual({ id: 1 });
  });
});

describe('pgSchema', () => {
  it('the whole current ladder loads on PGlite (spike Q1, kept green)', async () => {
    const d = await pgliteDriver();
    await loadPgSchema(d);
    const tables = await d.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(['teams', 'members', 'messages', 'audit', 'lanes', 'insights_fts']));
    await d.close();
  });
});

describe('withDrivers', () => {
  it('reads MUSTERD_TEST_DRIVER and defaults to sqlite until the conversion completes', () => {
    expect(testDriverKinds()).toEqual(['sqlite']);
    expect(testDriverKinds({ pglite: true })).toEqual(['sqlite', 'pglite']);
  });
  withDrivers('an opted-in block runs on both', (open, kind) => {
    it(`opens a migrated empty store on ${kind}`, async () => {
      const d = await open();
      expect(await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
      await d.close();
    });
  }, { pglite: true });
  it('a second openTestDriver("pglite") is a clean slate on the pooled instance', async () => {
    const a = await openTestDriver('pglite');
    await a.run("INSERT INTO teams (id, slug, display, created_at) VALUES ('t', 's', 'd', 1)");
    await a.close();
    const b = await openTestDriver('pglite');
    expect(await b.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
    await b.close();
  });
});
```

```ts
// packages/server/src/db/noPgliteInDist.test.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** PGlite is a test double, never a runtime dependency (ADR 479 §1). */
describe('the built server never imports pglite', () => {
  it('no dist file mentions @electric-sql/pglite', () => {
    const dist = new URL('../../dist', import.meta.url).pathname;
    if (!existsSync(dist)) return; // a test-only checkout; the CI leaf builds first
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
      );
    const offenders = walk(dist).filter((f) => readFileSync(f, 'utf8').includes('@electric-sql/pglite'));
    expect(offenders).toEqual([]);
  });
});
```

(`teams` column names in the last test: check `db/schema.ts`'s `CREATE TABLE teams` and use its NOT NULL columns; the implementer adjusts the literal to the real minimal insert.)

- [ ] **Step 3: Run to verify they fail** — `pnpm -C packages/server exec vitest run src/db/pgliteDriver.test.ts src/db/noPgliteInDist.test.ts` — FAIL, modules missing.

- [ ] **Step 4: Write `pgliteDriver.ts`**

```ts
// packages/server/src/db/pgliteDriver.ts
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { toPostgres } from './dialect.js';
import { DriverError, type Driver, type Params } from './driver.js';

/**
 * PGlite behind the async Driver — the Postgres test double (ADR 479 §1/§3). Not a runtime import
 * anywhere: only tests and plan-1B tooling reach this file (a test greps dist for the package name).
 * BIGINT (oid 20) parses to a JS number: every epoch-millis column is compared and subtracted as a
 * number by the modules, and none of them is near 2^53.
 */
export async function pgliteDriver(opts: { dataDir?: string } = {}): Promise<Driver> {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const pg: PGlite = new PG(opts.dataDir, { parsers: { 20: (v: string) => Number(v) } });
  await pg.waitReady;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new DriverError('driver is closed', 'closed');
  };
  const wrap = (q: PGlite | Transaction, depth: number): Driver => ({
    dialect: 'postgres',
    async get<R>(sql: string, params: Params = []) {
      assertOpen();
      return (await q.query<R>(toPostgres(sql), params as unknown[])).rows[0];
    },
    async all<R>(sql: string, params: Params = []) {
      assertOpen();
      return (await q.query<R>(toPostgres(sql), params as unknown[])).rows;
    },
    async run(sql: string, params: Params = []) {
      assertOpen();
      return { changes: (await q.query(toPostgres(sql), params as unknown[])).affectedRows ?? 0 };
    },
    async exec(sql: string) {
      assertOpen();
      await q.exec(toPostgres(sql));
    },
    async tx<T>(fn: (t: Driver) => Promise<T>): Promise<T> {
      assertOpen();
      if (depth === 0) return pg.transaction((t) => fn(wrap(t, 1)));
      const name = `sp${depth}`;
      await q.exec(`SAVEPOINT ${name}`);
      try {
        const r = await fn(wrap(q, depth + 1));
        await q.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        await q.exec(`ROLLBACK TO ${name}`);
        await q.exec(`RELEASE ${name}`);
        throw e;
      }
    },
    async close() {
      if (depth > 0) return;
      closed = true;
      await pg.close();
    },
  });
  return wrap(pg, 0);
}
```

- [ ] **Step 5: Write `pgSchema.ts`** — port `sqliteToPostgres`, `splitStatements`, `applyHandFixes` and `currentSqliteDdl` from `scripts/perf/pglite-schema.mjs` into TypeScript (the four FTS5 hand-fixes verbatim), exposing `pgSchemaStatements()` (memoised) and `loadPgSchema(d)` = `for (const s of pgSchemaStatements()) await d.exec(s)`. `currentSqliteDdl` opens `openDb(':memory:')` (which runs the ladder) and reads `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 END, rowid`. Add a top-of-file comment: *interim until plan 1B's Postgres ladder; the day 1B lands, this file is deleted and `loadPgSchema` runs that ladder.*

- [ ] **Step 6: Write `testing.ts`**

```ts
// packages/server/src/db/testing.ts
import { afterAll, describe } from 'vitest';
import { openDb } from './open.js';
import { loadPgSchema, pgSchemaStatements } from './pgSchema.js';
import { pgliteDriver } from './pgliteDriver.js';
import { sqliteDriver } from './sqliteDriver.js';
import type { Driver } from './driver.js';

export type DriverKind = 'sqlite' | 'pglite';

/**
 * Which drivers a store test runs on. MUSTERD_TEST_DRIVER=sqlite|pglite|both; the default is
 * `sqlite` until plan 1A's last task flips it to `both`, and a converted test file opts into PGlite
 * early with { pglite: true } once its whole dependency closure is converted.
 */
export function testDriverKinds(opts: { pglite?: boolean } = {}): DriverKind[] {
  const env = process.env['MUSTERD_TEST_DRIVER'];
  if (env === 'both') return ['sqlite', 'pglite'];
  if (env === 'pglite') return ['pglite'];
  if (env === 'sqlite') return ['sqlite'];
  return opts.pglite ? ['sqlite', 'pglite'] : ['sqlite'];
}

// One migrated PGlite per worker; each openTestDriver('pglite') truncates everything (~0.5 s/file).
let pooled: Promise<Driver> | null = null;
let tables: string[] | null = null;
async function pooledPglite(): Promise<Driver> {
  if (!pooled) {
    pooled = (async () => {
      const d = await pgliteDriver();
      await loadPgSchema(d);
      tables = (
        await d.all<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        )
      ).map((r) => r.table_name);
      return d;
    })();
  }
  return pooled;
}

export async function openTestDriver(kind: DriverKind): Promise<Driver> {
  if (kind === 'sqlite') return sqliteDriver(openDb(':memory:'));
  const d = await pooledPglite();
  await d.exec(`TRUNCATE ${tables!.map((t) => `"${t}"`).join(', ')} CASCADE`);
  // A test's close() must not close the pooled instance.
  return { ...d, close: async () => undefined };
}

export function withDrivers(
  name: string,
  fn: (open: () => Promise<Driver>, kind: DriverKind) => void,
  opts: { pglite?: boolean } = {},
): void {
  describe.each(testDriverKinds(opts))(`${name} [%s]`, (kind) => {
    fn(() => openTestDriver(kind), kind);
  });
  afterAll(async () => {
    // keep the pooled instance for the next describe in this file; vitest tears the worker down
    void pgSchemaStatements;
  });
}
```

- [ ] **Step 7: Run the tests** — `pnpm -C packages/server exec vitest run src/db/` — Expected: all pass; the schema test is the slow one (~2 s). If a FTS trigger statement fails, diff it against `scripts/perf/pglite-schema.mjs` `applyHandFixes` — those exact strings loaded on 2026-09-29.

- [ ] **Step 8: Arch tree lines + commit**

```
    pgliteDriver.ts   // ADR 479 §1/§3: PGlite behind Driver — the Postgres TEST DOUBLE (dev dependency; noPgliteInDist.test greps the bundle); toPostgres on every statement, BIGINT → number, tx via pg.transaction, nested = SAVEPOINT
    pgSchema.ts       // INTERIM until plan 1B's Postgres ladder: the current SQLite schema (sqlite_master after the ladder) translated with the spike's Q1 rules + the four FTS5 hand-fixes (insights_fts → tsvector table + plpgsql triggers); loadPgSchema(driver)
    testing.ts        // withDrivers(name, fn, {pglite?}) = describe.each over MUSTERD_TEST_DRIVER (sqlite | pglite | both); openTestDriver: a fresh in-memory SQLite, or the worker's one migrated PGlite truncated clean
```

```bash
git add package.json packages/server/package.json pnpm-lock.yaml packages/server/src/db/pgliteDriver.ts packages/server/src/db/pgSchema.ts packages/server/src/db/testing.ts packages/server/src/db/pgliteDriver.test.ts packages/server/src/db/noPgliteInDist.test.ts docs/architecture/03-server.md
git commit -m "feat(db): PGlite test double, interim pg schema loader, withDrivers harness (1A task 3)"
```

---

### Task 4: `Ctx.db` becomes a `Driver`; `openDriver`; `createServer` wraps a raw handle; nothing else changes yet

**Files:**
- Modify: `packages/server/src/context.ts:6-9` (`db: Driver; traceDb: Driver;`)
- Modify: `packages/server/src/db/open.ts` (add `openDriver(path): SqliteDriver`), `packages/server/src/db/traceDb.ts` (add `openTraceDriver`)
- Modify: `packages/server/src/index.ts:84-112` (`opts.db?: Database | Driver`; wrap raw handles with `sqliteDriver`; `ctx.db` is the driver; every existing sync call site in `index.ts`, `transport/http.ts`, `transport/ws.ts`, `presence/reaper.ts`, `sync/*.ts`, `footprint/*.ts`, `projection/*.ts` that passes `ctx.db` to a store function passes `asRaw(ctx.db)` **for now**)
- Modify: `packages/server/src/index.ts:394` export `openDriver`, `sqliteDriver`, `asRaw`, `type Driver`.

**Interfaces:**
- Produces: `Ctx.db: Driver`, `Ctx.traceDb: Driver`; `createServer({ db })` accepts `Database.Database | Driver`; `export function openDriver(path: string): SqliteDriver` (= `sqliteDriver(openDb(path))`).
- The 78 tests that call `createServer({ db: openDb(':memory:') })` keep working unchanged.

This is the pivot: after it, the daemon runs exactly as before (every store call goes through `asRaw`), and each later task removes `asRaw` from one cluster. The completeness check is `grep -rn "asRaw(" packages/server/src | wc -l` — it goes **up** here (to ~600) and must reach 0 by Task 24.

- [ ] **Step 1: Write the failing test** (append to `packages/server/src/index.test.ts`):

```ts
describe('createServer takes a Driver or a raw handle', () => {
  it('exposes ctx.db as a Driver either way and serves /health', async () => {
    for (const db of [openDb(':memory:'), openDriver(':memory:')]) {
      const server = createServer({ db, port: 0 });
      const { port } = await server.listen();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
      } finally {
        await server.close();
      }
    }
  });
});
```

- [ ] **Step 2: Run** — FAIL: `openDriver` not exported.
- [ ] **Step 3: Implement** — `open.ts`: `export function openDriver(path: string): SqliteDriver { return sqliteDriver(openDb(path)); }`. `index.ts`: `const db: Driver = opts.db ? ('dialect' in opts.db ? opts.db : sqliteDriver(opts.db)) : openDriver(config.dbPath);` (same for `traceDb`); `config.dbPath = asRaw(db).name || config.dbPath` stays SQLite-only for now (the `name` read moves behind the driver in Task 22). Then run `tsc --noEmit` and, at each error where a raw `Database` is expected, pass `asRaw(ctx.db)` / `asRaw(ctx.traceDb)`. Expect ~600 edits, mechanical; do them with the editor, not sed (the `db` variable is shadowed in places).
- [ ] **Step 4: Run** the full server suite on SQLite: `pnpm -C packages/server exec vitest run` — Expected: all green, unchanged counts.
- [ ] **Step 5: Commit** — `refactor(server): Ctx.db is a Driver; createServer wraps a raw handle; store calls go through asRaw for now (1A task 4)`.

---

### Task 5: Leaf store modules with no store dependencies

**Files:** `store/activity.ts` (47 lines), `store/discharge.ts` (77), `store/footprint.ts` (79), `store/gateAsk.ts` (66), `store/invites.ts` (339), `store/metrics.ts` (55), `store/requests.ts` (200), `store/roles.ts` (107), `store/rows.ts` (249), `store/signinHandoff.ts` (79), `store/teamMemory.ts` (89), `store/trace.ts` (492), `store/traceCoverage.ts` (148) — and their `*.test.ts`; callers: whichever `transport/http.ts`, `index.ts`, `sync/*.ts`, `footprint/reap.ts`, `presence/reaper.ts` sites pass `asRaw(ctx.db)` into these (they now pass `ctx.db` and `await`).

**Specifics:**
- `gateAsk.ts`: one nested `json_extract` with a comparison (`'$.gate.fingerprint' = ?`) — the translator covers it; its test must run on PGlite (Review Focus 2).
- `rows.ts` is the row-mapping helper module — no SQL of its own beyond helpers; convert its signatures so every later module's `rows` import compiles.
- `teamMemory.ts` is the **one dialect branch**: `searchInsights` keeps FTS5 `MATCH` under `db.dialect === 'sqlite'` and uses `tsv @@ plainto_tsquery('simple', ?)` on `'postgres'`; `rebuildInsightsFts` likewise (`INSERT … SELECT` into the plain table). Write its PGlite test for both a hit and a miss.
- `trace.ts` (2 transactions: `ingestTraceEvents` batch, `ingestSyncedTraceRows`) — `db.tx`; the hourly `startTraceContentPrune` pass becomes `async` with the same `try/catch → onError`.
- `traceCoverage.ts`'s sweep likewise.
- `footprint.ts` + `footprint/reap.ts`: the sampler tick becomes `async`.

- [ ] Convert per the recipe; opt every test file here into PGlite (`{ pglite: true }`) — their closure is complete.
- [ ] `pnpm -C packages/server exec tsc --noEmit` clean; `MUSTERD_TEST_DRIVER=both pnpm -C packages/server exec vitest run src/store/{activity,discharge,footprint,gateAsk,invites,metrics,requests,roles,rows,signinHandoff,teamMemory,trace,traceCoverage}*.test.ts` green.
- [ ] Commit — `refactor(store): leaf modules on the async Driver, teamMemory carries the FTS5/tsvector branch (1A task 5)`.

### Task 6: `messages` → `audit` (and `traceReport`)

**Files:** `store/messages.ts` (928), `store/audit.ts` (1281), `store/traceReport.ts` (240) + tests; callers as above.

**Specifics:** `audit.ts` `appendAudit` is on **every** request path — the `try/catch` that swallows storage failures stays; `appendReplicatedEvent` allocates `origin_seq` inside a transaction (`db.tx`). `messages.ts` `listInbox` cursor read is the hook hot path — after converting, re-run the hook-path bench (`scripts/perf/pglite-hookpath.mjs` query set against the SQLite driver) and record p95 in the commit body; the Global Constraint is "unchanged". The existing `audit.reviewRouting.test.ts`, `auditSubject.test.ts` and `retention.test.ts`'s `auditReadersOfChurnActions` source-scan keep passing (the regex matches `action = '…'` text, which the conversion does not change).

- [ ] Convert; opt tests into PGlite; tsc; both-driver run; commit `refactor(store): messages and audit on the async Driver (1A task 6)`.

### Task 7: The audit-dependent leaves

**Files:** `store/cursors.ts` (85 — the spike's own port is the reference, `scripts/perf/pglite-slice/cursors.mjs`), `store/memory.ts` (159), `store/quiescence.ts` (155), `store/toolCalls.ts` (247; 2 tx), `store/retention.ts` (347), `store/interruptCandidates.ts` (312), `store/presence.ts` (783), `store/delivery.ts` (450), `store/mast.ts` (266) + tests.

**Specifics:** `interruptCandidates.ts` has the `json_extract(meta, '$.urgent') = 1` typed compare and `delivery.ts` two more — the translator casts; their tests **must** run on PGlite (Review Focus 2). `retention.ts`'s reader pin (`auditReadersOfChurnActions`) is a source scan, unchanged; `pruneAuditChurn`'s per-batch `deleteAll = db.transaction(…)` → `db.tx`. `presence.ts` `countLivePresences` is on `/health` — keep it a single statement.

- [ ] Convert; PGlite opt-in; tsc; both-driver run; commit `refactor(store): cursors, memory, quiescence, toolCalls, retention, interruptCandidates, presence, delivery, mast (1A task 7)`.

### Task 8: The core cycle — `teams`, `members`, `lanes`, `goals`, `oauth`, `session-leases`

**Files:** `store/teams.ts` (755; 5 tx), `store/members.ts` (949; 3 tx), `store/lanes.ts` (1155; 4 tx), `store/goals.ts` (249), `store/oauth.ts` (542; 5 tx), `store/session-leases.ts` (112) + tests. These import each other in a cycle, so they convert **in one task**; the tests of all six run together at the end.

**Specifics:** `oauth.ts`'s 5 transactions include the `jti` single-use insert path that plan 1C/2 rely on — keep it one `tx` with the insert first. `lanes.ts` `claimLane` / `resolveLane` write audit inside their transaction: the audit helper takes the tx handle `t`. `teams.ts` `archiveTeam` + `rotateAgentKey` likewise. After this task the `asRaw` count should drop by roughly half.

- [ ] Convert all six; opt their tests into PGlite; tsc; both-driver run; commit `refactor(store): the teams/members/lanes/goals/oauth/session-leases cluster on the async Driver (1A task 8)`.

### Task 9: Second ring

**Files:** `store/hydrate.ts` (40), `store/deferralFold.ts` (51), `store/grants.ts` (142), `store/nodes.ts` (375), `store/sponsoredAgents.ts` (236; 3 tx), `store/staleness.ts` (99), `store/doorbell.ts` (255), `store/seeds.ts` (628; **6 tx**), `store/wakeContextBody.ts` (224), `store/reachability.ts` (168), `store/incidents.ts` (333) + tests; `sync/log.ts` (the `laneGenesis` nested `json_extract` ×2 + one compare) and `sync/claim.ts`.

- [ ] Convert; PGlite opt-in; tsc; both-driver run; commit `refactor(store): second ring — hydrate…incidents, sync/log, sync/claim (1A task 9)`.

### Task 10: `residency` → `review` → `laneClose` → `laneSweep` → `hostProvisions` → `sponsoredCascade`

**Files:** `store/residency.ts` (2018 — the largest; 37 inventory hits; 2 nested `json_extract` compares), `store/review.ts` (981; 3 nested + 1 nested compare), `store/laneClose.ts` (306), `store/laneSweep.ts` (84), `store/hostProvisions.ts` (298; 3 tx), `store/sponsoredCascade.ts` (74; 2 tx) + tests; `presence/reaper.ts` (its tick calls residency's wake queue — becomes an `async` tick with `void tick().catch(log)`).

**Specifics:** `review.ts` `durableAttestations` / `selectReviewCounterpart` are what ADR 478's reader pin protects — the source scan still finds them by the same literals. `residency.ts`'s 15 `FROM audit` reads: convert one function at a time, run `residency.test.ts` after each batch of ~5 — this file is where a missed `await` hides longest.

- [ ] Convert; PGlite opt-in; tsc; both-driver run; commit `refactor(store): residency, review, laneClose, laneSweep, hostProvisions, sponsoredCascade; reaper tick async (1A task 10)`.

### Task 11: `orientation`, `insights`, `reportWorker`, `reportCache`

**Files:** `store/orientation.ts` (380; 2 nested `json_extract`), `store/insights.ts` (910; 2 nested + 2 nested compares; imports twelve store modules — last by construction), `store/reportWorker.ts` (35 — opens its **own** connection with `busy_timeout`: becomes `openDriver(path)` and the pragma moves into `openDb`), `store/reportCache.ts` (162) + tests.

- [ ] Convert; PGlite opt-in; tsc; both-driver run; commit `refactor(store): orientation, insights, report worker/cache (1A task 11)`.

### Task 12: `sync/fold.ts` and `projection/*`

**Files:** `sync/fold.ts` (31 hits; the joiner fold — one transaction per batch), `sync/push.ts`, `sync/pull.ts`, `sync/tracePush.ts` (loops become `async` ticks), `projection/reconcile.ts`, `projection/serialize.ts` + tests (`sync/*.test.ts` boot two servers — SQLite-only until Task 24).

**Specifics:** `foldBatch`'s `FoldStop` contract (every stop has its own `error` line) is unchanged; the batch transaction is one `db.tx`. `sync/census.test.ts` is the federation falsifier — it must stay green with **no assertion edits**.

- [ ] Convert; tsc; SQLite run of `src/sync` + `src/projection`; commit `refactor(sync,projection): fold, push/pull loops, reconcile on the async Driver (1A task 12)`.

### Task 13: `transport/oauth.ts`, `transport/authSponsor.ts`, `transport/ws.ts`

**Files:** `transport/oauth.ts` (2 tx), `transport/authSponsor.ts`, `transport/ws.ts` (`ws.on('message', (data) => …)` at line 208 becomes `(data) => { void handle(data).catch(…) }` with the existing error-frame path inside `handle`) + tests.

- [ ] Convert; tsc; run `src/transport/oauth*.test.ts src/transport/ws*.test.ts`; commit `refactor(transport): oauth, authSponsor, ws on the async Driver (1A task 13)`.

### Task 14–21: `transport/http.ts`, one route family per task

`http.ts` is 7,398 lines and references `ctx.db` ~480 times; the handlers are already `async`, so each site is `asRaw(ctx.db)` → `ctx.db` plus an `await`. Split by route family so each task has a test file to gate it and a reviewer can reject one without the others:

| task | route family (grep the `path ===` / `path.startsWith` block) | gate |
| --- | --- | --- |
| 14 | `/health`, `/teams` create/archive/rotate, `/store/*`, `/node/*` | `index.test.ts`, `store-http.test.ts`, `node.test.ts` (cli) |
| 15 | members / claim / occupancy / session leases / bootstrap | `transport/claim*.test.ts`, `integration.test.ts` |
| 16 | messages / inbox / send / delivery / interrupt | `transport/inbox*.test.ts`, `integration.test.ts` |
| 17 | lanes / goals / board / review / acceptance | `transport/lane*.test.ts` |
| 18 | residency / wake / host provisions / footprint | `transport/residency*.test.ts` |
| 19 | sync (`/sync/push`, `/sync/pull`, `/sync/trace`) + nodes | `sync/*.test.ts` |
| 20 | oauth / mcp / remote (`/mcp/*`, `/oauth/*`, invites, join) | `transport/oauth-http.test.ts`, `trace-http.test.ts` |
| 21 | everything left: `grep -n "asRaw(" packages/server/src/transport/http.ts` must print nothing | full `src/transport` run |

Each: convert the family; tsc; run the gate; commit `refactor(http): <family> on the async Driver (1A task N)`.

### Task 22: `index.ts` wiring, `db/seed.ts`, `db/traceDb.ts` helpers, and the CLI's server-side test imports

**Files:** `index.ts` (the `listen()` callback's loop starts already return stop functions — keep; `config.dbPath = …` reads the path from the driver: add `readonly path: string | undefined` to `SqliteDriver` (`raw.name`) and drop the `asRaw` there), `db/seed.ts` (`seedDawn(db: Driver)`), `db/traceDb.ts` (`traceSchemaVersion(d: Driver)`), and the 30 `packages/cli/src/**/*.test.ts` files that `import { openDb } from '@musterd/server'` — they keep `openDb` (a raw handle is still accepted by `createServer`), so **no edit** unless one calls a store function directly (grep `from '@musterd/server'` for store names; convert those calls to `await`).

- [ ] tsc for server **and** cli (`pnpm typecheck`); run `pnpm -C packages/cli exec vitest run`; commit `refactor(server,cli): wiring and seed on the async Driver; CLI tests unchanged (1A task 22)`.

### Task 23: Behaviour-unchanged falsifiers

**Files:** `packages/server/src/db/unchanged.test.ts` (new); `docs/perf/async-store-layer.md` (new result page).

- [ ] `unchanged.test.ts`: boots `createServer({ db: openDb(':memory:') })`, seeds `seedDawn`, and asserts the `/health` JSON **keys** equal the pre-1A set (list them literally from today's `/health` handler: `ok, v, db, schema, trace_db, trace_schema, trace_db_bytes?, db_bytes?, sync_log_rows, sync_log_bytes?, archive_bytes?, connections, quietest_busy_ms?, build?, epoch, booted_at`).
- [ ] Hook-path timing: run the spike's query set (`node scripts/perf/pglite-hookpath.mjs --sqlite-only`, adding that flag if absent) on the dev laptop's `musterd.db` copy before (at `main` before Task 1) and after; write both p95 columns into `docs/perf/async-store-layer.md` with date and commit SHAs. Bar: after ≤ 1.2× before on every query (the Promise wrapper cost).
- [ ] Commit `test(server): 1A behaviour-unchanged falsifiers + timing result page (1A task 23)`.

### Task 24: Delete the escape hatch, flip the default to both drivers, wire CI

**Files:** `packages/server/src/db/sqliteDriver.ts` (remove `raw` from the public type and delete `asRaw`), `packages/server/src/db/testing.ts` (default `both`), `.github/workflows/*.yml` (the `test` leaf runs `MUSTERD_TEST_DRIVER=both`), `docs/architecture/01-data-model.md` (a "Two dialects" paragraph: one SQL text, the translator's rules, the one dialect branch in `teamMemory.ts`), `docs/architecture/03-server.md` (drop the "transition-only" clauses), `docs/decisions/479-two-store-backends.md` Consequences (dated note: translator line count as measured by `wc -l`, the both-driver suite count and duration), `docs/wiki/running-the-gates.md` (how to run one driver locally).

- [ ] `grep -rn "asRaw(" packages/server/src` → empty. Remove `asRaw` and `raw`; tsc clean.
- [ ] `MUSTERD_TEST_DRIVER=both pnpm -C packages/server exec vitest run` — every file green on both; record the duration (expect roughly +40 % over SQLite-only from the PGlite truncates).
- [ ] Every `withDrivers(…, { pglite: true })` opt-in flag is now redundant — delete the flags (one sed, then tsc).
- [ ] Docs + ADR note; `pnpm typecheck && pnpm lint && pnpm format:check`; commit `feat(store): the store suite runs on both drivers in CI; transition escape hatch removed (1A task 24)`.

---

## Self-review (done while writing)

- **Spec coverage:** ADR 479 §1 (two backends, PGlite dev-only) → Tasks 1, 3 (+ the dist grep); §2 (one async interface, tx queue) → Task 1; §3 (suite on both drivers in CI, PGlite pre-seeded instance) → Tasks 3, 24; §4 (translator ≤ 300 lines, nested path + typed compare covered) → Task 2. Spec §3.3 result line → this plan is that increment's first slice; §9's increment-1 "done when" is split into 1A–1D above, deliberately.
- **Placeholders:** the conversion tasks (5–22) reference the recipe rather than repeating ~70 files of code; each names its files, sizes, transaction counts, dialect-sensitive sites, callers and test gate. That is the whole content an engineer needs for a mechanical, type-checked conversion; the code for the new modules (Tasks 1–3) is complete.
- **Type consistency:** `Driver`, `Params`, `DriverError`, `sqliteDriver`, `asRaw`, `openDriver`, `pgliteDriver`, `toPostgres`, `loadPgSchema`, `withDrivers`, `openTestDriver`, `testDriverKinds` are named identically in every task.
- **Review Focus:** all five pinned (Tasks 1, 2, 3, 7).

## After 1A

1B (Postgres for real, RLS, tenancy test), 1C (cloud mode + test issuer + loopback audit + 503), 1D (deploy, load, rolling schema) each get a plan of this shape when 1A's Task 24 lands. Their first task each starts from `Driver` and `toPostgres` as defined here; nothing in 1A is reopened.
