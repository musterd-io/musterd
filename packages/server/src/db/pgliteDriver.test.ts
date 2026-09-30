import { afterAll, describe, expect, it } from 'vitest';
import { pgliteDriver } from './pgliteDriver.js';
import { loadPgSchema } from './pgSchema.js';
import { openTestDriver, testDriverKinds, withDrivers } from './testing.js';

describe('pgliteDriver', () => {
  const dp = pgliteDriver();
  afterAll(async () => (await dp).close());

  it('translates ? placeholders and reports changes', async () => {
    const d = await dp;
    expect(d.dialect).toBe('postgres');
    await d.exec('CREATE TABLE t (id BIGINT PRIMARY KEY, v TEXT, ts BIGINT)');
    expect(
      await d.run('INSERT INTO t (id, v, ts) VALUES (?, ?, ?)', [1, 'a', 1790000000000]),
    ).toEqual({ changes: 1 });
    expect(await d.get<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])).toEqual({ v: 'a' });
  });

  it('integers come back as numbers, not strings', async () => {
    const d = await dp;
    const row = await d.get<{ ts: number; n: number }>(
      'SELECT ts, COUNT(*) AS n FROM t GROUP BY ts',
    );
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
      await t
        .tx(async (t2) => {
          await t2.run('INSERT INTO t (id, v) VALUES (?, ?)', [4, 'd']);
          throw new Error('inner');
        })
        .catch(() => undefined);
    });
    expect((await d.all('SELECT id FROM t ORDER BY id')).map((r) => r['id'])).toEqual([1, 3]);
  });

  it('json_extract shapes work end to end on Postgres', async () => {
    const d = await dp;
    await d.exec('CREATE TABLE m (id BIGINT, meta TEXT)');
    await d.run('INSERT INTO m VALUES (?, ?)', [
      1,
      JSON.stringify({ urgent: 1, gate: { fingerprint: 'fp' }, lane: 'L' }),
    ]);
    expect(await d.get("SELECT id FROM m WHERE json_extract(meta, '$.urgent') = 1")).toEqual({
      id: 1,
    });
    expect(
      await d.get("SELECT id FROM m WHERE json_extract(meta, '$.gate.fingerprint') = ?", ['fp']),
    ).toEqual({ id: 1 });
    expect(
      await d.get("SELECT id FROM m WHERE json_extract(meta, '$.lane') LIKE ?", ['l']),
    ).toEqual({ id: 1 });
  });
});

describe('pgSchema', () => {
  it('the whole current ladder loads on PGlite (spike Q1, kept green)', async () => {
    const d = await pgliteDriver();
    await loadPgSchema(d);
    const tables = await d.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(['teams', 'members', 'messages', 'audit', 'lanes', 'insights_fts']),
    );
    await d.close();
  });
});

describe('withDrivers', () => {
  it('reads MUSTERD_TEST_DRIVER and defaults to both drivers (ADR 479 §3)', () => {
    const prev = process.env['MUSTERD_TEST_DRIVER'];
    try {
      delete process.env['MUSTERD_TEST_DRIVER'];
      expect(testDriverKinds()).toEqual(['sqlite', 'pglite']);
      process.env['MUSTERD_TEST_DRIVER'] = 'sqlite';
      expect(testDriverKinds()).toEqual(['sqlite']);
      process.env['MUSTERD_TEST_DRIVER'] = 'pglite';
      expect(testDriverKinds()).toEqual(['pglite']);
    } finally {
      if (prev === undefined) delete process.env['MUSTERD_TEST_DRIVER'];
      else process.env['MUSTERD_TEST_DRIVER'] = prev;
    }
  });
  withDrivers('a block runs on every driver', (open, kind) => {
    it(`opens a migrated empty store on ${kind}`, async () => {
      const d = await open();
      expect(await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
      await d.close();
    });
  });
  it('a second openTestDriver("pglite") is a clean slate on the pooled instance', async () => {
    const a = await openTestDriver('pglite');
    await a.run(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('t', 's', 'd', 1, 1)",
    );
    await a.close();
    const b = await openTestDriver('pglite');
    expect(await b.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
    await b.close();
  });
});
