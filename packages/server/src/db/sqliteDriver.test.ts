import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log.js';
import { DriverError } from './driver.js';
import { withRequestTiming } from './requestTiming.js';
import { sqliteDriver } from './sqliteDriver.js';

function fresh() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return sqliteDriver(raw);
}

describe('sqliteDriver', () => {
  it('a statement that holds the main thread 200 ms or more logs sqlite_stmt_slow with its SQL (lane 01M4YY5Z38)', async () => {
    const raw = new Database(':memory:');
    // A deterministic slow statement: a SQL function that spins 250 ms on the main thread.
    raw.function('spin', () => {
      const end = performance.now() + 250;
      while (performance.now() < end);
      return 1;
    });
    const d = sqliteDriver(raw);
    const warn = vi.spyOn(log, 'warn');
    try {
      await d.get('SELECT spin()   AS x');
      await d.tx((t) => t.get('SELECT spin() AS y'));
      await d.get('SELECT 1');
      const lines = warn.mock.calls
        .map(([f]) => f as { msg: string; sql: string; in_tx: boolean; ms: number })
        .filter((f) => f.msg === 'sqlite_stmt_slow');
      expect(lines.map((l) => [l.sql, l.in_tx])).toEqual([
        ['SELECT spin() AS x', false],
        ['SELECT spin() AS y', true],
      ]);
      expect(lines.every((l) => l.ms >= 200)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('get/all/run/exec round-trip with ? placeholders and report changes', async () => {
    const d = fresh();
    expect(d.dialect).toBe('sqlite');
    expect(await d.run('INSERT INTO t (v) VALUES (?)', ['a'])).toEqual({ changes: 1 });
    await d.exec("INSERT INTO t (v) VALUES ('b')");
    expect(await d.get<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])).toEqual({ v: 'a' });
    expect(await d.all<{ v: string }>('SELECT v FROM t ORDER BY id')).toEqual([
      { v: 'a' },
      { v: 'b' },
    ]);
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
    const outside = d
      .get<{ n: number }>('SELECT COUNT(*) AS n FROM t')
      .then((r) => seen.push(r!.n));
    await Promise.all([tx, outside]);
    expect(seen).toEqual([1]); // ran after commit, not inside
  });

  it('an outer statement queued behind tx A never lands inside the NEXT queued tx B (review C1)', async () => {
    const d = fresh();
    // A holds the connection; the outer INSERT is issued while A is open; B is queued AFTER the
    // outer statement and rolls back. If the INSERT executed inside B it would vanish with it.
    const a = d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['a']);
      await new Promise((r) => setTimeout(r, 20));
    });
    const outside = d.run('INSERT INTO t (v) VALUES (?)', ['outside']);
    const b = d
      .tx(async (t) => {
        await t.run('INSERT INTO t (v) VALUES (?)', ['b']);
        throw new Error('b rolls back');
      })
      .catch(() => undefined);
    await Promise.all([a, outside, b]);
    const rows = await d.all<{ v: string }>('SELECT v FROM t ORDER BY v');
    expect(rows.map((r) => r.v)).toEqual(['a', 'outside']);
  });

  it('a tx handle used after its transaction settled throws instead of writing (review I1)', async () => {
    const d = fresh();
    let leaked!: Parameters<Parameters<typeof d.tx>[0]>[0];
    await d.tx(async (t) => {
      leaked = t;
      await t.run('INSERT INTO t (v) VALUES (?)', ['in']);
    });
    await expect(leaked.run('INSERT INTO t (v) VALUES (?)', ['late'])).rejects.toMatchObject({
      code: 'tx_closed',
    });
    await expect(leaked.tx(async () => undefined)).rejects.toMatchObject({ code: 'tx_closed' });
    expect((await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM t'))!.n).toBe(1);
  });

  it('work deferred from inside a tx body runs after the commit on the connection handle (review I1)', async () => {
    const d = fresh();
    let deferred!: Promise<number>;
    await d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['in']);
      // A notification's `.then`, registered inside the body: it settles after COMMIT and must be
      // allowed to write through the CONNECTION, not refused as "outer handle inside tx".
      deferred = new Promise((r) => setTimeout(r, 10)).then(async () => {
        await t.connection().run('INSERT INTO t (v) VALUES (?)', ['later']);
        return (await t.connection().get<{ n: number }>('SELECT COUNT(*) AS n FROM t'))!.n;
      });
    });
    expect(await deferred).toBe(2);
  });

  it('nested tx is a savepoint: inner rollback keeps the outer work', async () => {
    const d = fresh();
    await d.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES (?)', ['outer']);
      await t
        .tx(async (t2) => {
          await t2.run('INSERT INTO t (v) VALUES (?)', ['inner']);
          throw new Error('inner');
        })
        .catch(() => undefined);
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

  it('close() makes every call a DriverError("closed")', async () => {
    const d = fresh();
    await d.close();
    await expect(d.get('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
  });
  it('forTeam and asOperator are the handle itself on SQLite (one tenant per file)', async () => {
    const d = fresh();
    expect(d.forTeam('t1')).toBe(d);
    expect(d.asOperator()).toBe(d);
    await d.tx(async (t) => {
      expect(t.forTeam('t1')).toBe(t);
      expect(t.asOperator()).toBe(t);
    });
  });

  /**
   * Lane 01M4S0ZAG8: one transaction runs at a time and every outer statement waits for it, so a
   * body that awaits something slow stalls every request that touches the store, which on the Air
   * showed up as a ~5 s wake-leases poll every ~5 minutes. The driver now says who held the queue
   * and how long a request waited for it.
   */
  describe('queue timing', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('logs a transaction held past a second, naming where it was opened', async () => {
      vi.stubEnv('MUSTERD_SILENT', '0');
      const lines: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((c) => (lines.push(String(c)), true));
      vi.spyOn(process.stderr, 'write').mockImplementation((c) => (lines.push(String(c)), true));
      const d = fresh();
      await d.tx(async (t) => {
        await t.run('INSERT INTO t (v) VALUES (?)', ['a']);
        await new Promise((r) => setTimeout(r, 1_050));
      });
      const slow = lines
        .filter((l) => l.includes('"sqlite_tx_slow"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(slow).toHaveLength(1);
      expect(slow[0]!.hold_ms as number).toBeGreaterThanOrEqual(1_000);
      expect(String(slow[0]!.at)).toContain('sqliteDriver.test.ts');
    });

    it("records a request's wait behind another transaction and its own hold", async () => {
      const d = fresh();
      let release!: () => void;
      const holder = d.tx(() => new Promise<void>((r) => (release = r)));
      const { timing, result } = withRequestTiming(() =>
        d.tx((t) => t.run('INSERT INTO t (v) VALUES (?)', ['b'])),
      );
      await new Promise((r) => setTimeout(r, 60));
      release();
      await Promise.all([holder, result]);
      expect(timing.tx).toBe(1);
      expect(timing.waitMs).toBeGreaterThanOrEqual(50);
      expect(timing.holdMs).toBeLessThan(50);
    });

    it("records an outer statement's wait behind a transaction", async () => {
      const d = fresh();
      let release!: () => void;
      const holder = d.tx(() => new Promise<void>((r) => (release = r)));
      const { timing, result } = withRequestTiming(() => d.get('SELECT 1 AS one'));
      await new Promise((r) => setTimeout(r, 60));
      release();
      await Promise.all([holder, result]);
      expect(timing.waitMs).toBeGreaterThanOrEqual(50);
    });
  });
});
