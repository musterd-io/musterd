import { afterAll, describe, expect, it } from 'vitest';
import type { Driver } from './driver.js';
import { migratePostgres } from './pg/migrate.js';
import { ROLE } from './pg/tenancy.js';
import { pgliteDriver } from './pgliteDriver.js';
import { openTestDriver, testDriverKinds, withDrivers } from './testing.js';

describe('pgliteDriver', () => {
  const root = pgliteDriver();
  // Ad-hoc tables: the owner path (no role, no RLS) — what a migration or a DDL fixture runs as.
  const dp = root.then((d) => d.asOwner());
  afterAll(async () => (await root).close());

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

describe('tenancy stamping (spec §12.1)', () => {
  it('scoped handles are memoised per team (a WeakMap keyed on the Driver hits every request)', async () => {
    const d = await pgliteDriver();
    expect(d.forTeam('A')).toBe(d.forTeam('A'));
    expect(d.forTeam('A')).not.toBe(d.forTeam('B'));
    expect(d.asOperator()).toBe(d.asOperator());
    await d.close();
  });

  it('fail-closed: the bare handle reads nothing, forTeam reads its team, asOperator reads both', async () => {
    const d = await pgliteDriver();
    await migratePostgres(d.asOwner());
    const op = d.asOperator();
    await op.run(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('A','a','A',1,1)",
    );
    await op.run(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('B','b','B',1,1)",
    );
    expect((await d.all('SELECT id FROM teams')).length).toBe(0);
    expect(
      (await d.forTeam('A').all<{ id: string }>('SELECT id FROM teams')).map((r) => r.id),
    ).toEqual(['A']);
    expect((await op.all('SELECT id FROM teams')).length).toBe(2);
    expect(
      (await d.forTeam('A').run("UPDATE teams SET display = 'x' WHERE id = 'B'")).changes,
    ).toBe(0);
    // The stamp is per transaction: a tx body sees its team and nothing else, and the scope
    // cannot be changed from inside it.
    await d.forTeam('B').tx(async (t) => {
      expect((await t.all<{ id: string }>('SELECT id FROM teams')).map((r) => r.id)).toEqual(['B']);
      expect(() => t.forTeam('A')).toThrow(/scope is fixed/);
      expect(() => t.asOperator()).toThrow(/scope is fixed/);
    });
    // A team handle cannot write another team's row into existence (WITH CHECK).
    await expect(
      d
        .forTeam('A')
        .run(
          "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('C','c','C',1,1)",
        ),
    ).rejects.toThrow(/row-level security/);
    await d.close();
  });
});

describe('session scope (the double holds scope per session, not per transaction)', () => {
  async function twoTeams() {
    const d = await pgliteDriver();
    await migratePostgres(d.asOwner());
    for (const id of ['A', 'B'])
      await d
        .asOperator()
        .run(
          'INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
          [id, id.toLowerCase(), id],
        );
    return d;
  }
  const ids = async (h: Driver) =>
    (await h.all<{ id: string }>('SELECT id FROM teams ORDER BY id')).map((r) => r.id);

  it('interleaved operations on different scopes each see only their own', async () => {
    const d = await twoTeams();
    const a = d.forTeam('A');
    const b = d.forTeam('B');
    const op = d.asOperator();
    const reads = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        [ids(a), ids(b), ids(d), ids(op)][i % 4]!.then((r) => [i % 4, r] as const),
      ),
    );
    const want = [['A'], ['B'], [], ['A', 'B']];
    for (const [k, r] of reads) expect(r).toEqual(want[k]);
    // A tx holds its scope against operations queued behind it.
    const inTx = a.tx(async (t) => {
      await new Promise((r) => setTimeout(r, 5));
      return ids(t);
    });
    const [tx, other] = await Promise.all([inTx, ids(b)]);
    expect(tx).toEqual(['A']);
    expect(other).toEqual(['B']);
    await d.close();
  });

  it('a team scope never leaks: the bare handle, owner DDL and a pooled client start clean', async () => {
    const d = await twoTeams();
    expect(await ids(d.forTeam('A'))).toEqual(['A']);
    expect(await ids(d)).toEqual([]);
    expect(await ids(d.forTeam('B'))).toEqual(['B']);
    // exec is the owner path even right after an app-role scope (the app role cannot CREATE).
    await d.forTeam('B').exec('CREATE TABLE scratch (id INT)');
    // pgDriver's root handle stamps a role and no tenant: it must not inherit the double's last one.
    expect(await ids(d.forTeam('A'))).toEqual(['A']);
    const client = await d.poolFactory()('postgres://ignored').connect();
    await client.query(`SET LOCAL ROLE ${ROLE.app}`);
    expect((await client.query('SELECT id FROM teams', [])).rows).toEqual([]);
    client.release();
    await d.close();
  });

  it('a failed statement leaves the scope intact; a failed tx rolls back and keeps it', async () => {
    const d = await twoTeams();
    const a = d.forTeam('A');
    await expect(a.run('SELECT nope FROM teams')).rejects.toThrow();
    expect(await ids(a)).toEqual(['A']);
    await expect(
      a.tx(async (t) => {
        await t.run("UPDATE teams SET display = 'x' WHERE id = 'A'");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await a.get('SELECT display FROM teams')).toEqual({ display: 'A' });
    await d.close();
  });
});

describe('withDrivers', () => {
  it('reads MUSTERD_TEST_DRIVER and defaults to sqlite (ADR 492; CI sets both)', () => {
    const prev = process.env['MUSTERD_TEST_DRIVER'];
    try {
      delete process.env['MUSTERD_TEST_DRIVER'];
      expect(testDriverKinds()).toEqual(['sqlite']);
      process.env['MUSTERD_TEST_DRIVER'] = 'both';
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
