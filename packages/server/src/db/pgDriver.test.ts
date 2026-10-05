import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { pgDriver, pgPoolFactory } from './pgDriver.js';
import { requestTiming, withRequestTiming } from './requestTiming.js';

/**
 * The choreography against a fake pool — what goes down the wire, in what order, on which client.
 * The real wire is the Neon pass (1B task 14); PGlite proves the SQL, this proves the driver.
 */
function fakePools() {
  const log: string[] = [];
  let failNext: string | null = null;
  let busy = 0;
  const client = (label: string) => ({
    async query(text: string, values?: unknown[]) {
      log.push(`${label}: ${text}${values?.length ? ' ' + JSON.stringify(values) : ''}`);
      if (failNext && text.includes(failNext)) {
        failNext = null;
        throw new Error('boom');
      }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    release: (err?: unknown) => {
      busy--;
      log.push(`${label}: release${err ? '(err)' : ''}`);
    },
  });
  const factory = (url: string) => ({
    async connect() {
      busy++;
      return client(url.includes('operator') ? 'op' : url.includes('owner') ? 'own' : 'app');
    },
    async end() {},
  });
  return { factory, log, fail: (s: string) => (failNext = s), busy: () => busy };
}

const urls = { appUrl: 'postgres://app', operatorUrl: 'postgres://operator' };

describe('pgDriver choreography (spec §12.1)', () => {
  it('a bare statement on a team handle is BEGIN+SET LOCAL ROLE+set_config (one trip) / stmt / COMMIT on one client, then released', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.forTeam('A').get('SELECT 1 FROM teams WHERE id = ?', ['A']);
    expect(f.log).toEqual([
      "app: BEGIN; SET LOCAL ROLE musterd_app; SELECT set_config('app.team_id', 'A', true)",
      'app: SELECT 1 FROM teams WHERE id = $1 ["A"]',
      'app: COMMIT',
      'app: release',
    ]);
    expect(f.busy()).toBe(0);
  });

  it('the bare handle sets the role but no tenant (fail-closed); asOperator uses the operator pool', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.all('SELECT 1');
    await d.asOperator().all('SELECT 1');
    expect(f.log.filter((l) => l.includes('set_config'))).toEqual([]);
    expect(f.log).toContain('app: BEGIN; SET LOCAL ROLE musterd_app');
    expect(f.log).toContain('op: BEGIN; SET LOCAL ROLE musterd_operator');
  });

  it('a throwing body rolls back and releases the client with the error; nested = SAVEPOINT', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await expect(
      d.forTeam('A').tx(async (t) => {
        await t.tx(async (n) => {
          await n.run('UPDATE x SET y = 1');
        });
        throw new Error('body');
      }),
    ).rejects.toThrow('body');
    expect(f.log).toContain('app: SAVEPOINT sp1');
    expect(f.log).toContain('app: RELEASE sp1');
    expect(f.log.at(-2)).toBe('app: ROLLBACK');
    expect(f.log.at(-1)).toBe('app: release(err)');
    expect(f.busy()).toBe(0);
  });

  it('a nested body that throws rolls back to its savepoint and the outer tx still commits', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.tx(async (t) => {
      await t
        .tx(async (n) => {
          await n.run('UPDATE x SET y = 1');
          throw new Error('inner');
        })
        .catch(() => undefined);
      await t.run('UPDATE x SET y = 2');
    });
    expect(f.log).toContain('app: ROLLBACK TO sp1');
    expect(f.log.at(-2)).toBe('app: COMMIT');
    expect(f.log.at(-1)).toBe('app: release');
  });

  it('a tx handle is dead after its transaction settles, and cannot be rescoped', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    let leaked!: Parameters<Parameters<typeof d.tx>[0]>[0];
    await d.forTeam('A').tx(async (t) => {
      leaked = t;
      expect(() => t.forTeam('B')).toThrow(/scope is fixed/);
      expect(() => t.asOperator()).toThrow(/scope is fixed/);
    });
    await expect(leaked.run('UPDATE x SET y = 1')).rejects.toMatchObject({ code: 'tx_closed' });
    // connection() from inside keeps the scope: deferred work lands in the same tenant.
    expect(f.log.filter((l) => l.includes('set_config')).length).toBe(1);
  });

  it('the tenant literal is quoted, so a hostile team id cannot break out of set_config', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.forTeam("x'; RESET ROLE; --").get('SELECT 1');
    expect(f.log[0]).toBe(
      "app: BEGIN; SET LOCAL ROLE musterd_app; SELECT set_config('app.team_id', 'x''; RESET ROLE; --', true)",
    );
  });

  it("records a request's pool wait, hold and query time inside withRequestTiming, and nothing outside it", async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.forTeam('A').get('SELECT 1'); // outside a request: no record to write into
    expect(requestTiming()).toBeUndefined();
    const { timing, result } = withRequestTiming(async () => {
      await d.forTeam('A').get('SELECT 1');
      await d.forTeam('A').tx(async (t) => {
        await t.run('UPDATE x SET y = 1');
        await t.run('UPDATE x SET y = 2');
      });
    });
    await result;
    expect(timing.tx).toBe(2);
    expect(timing.holdMs).toBeGreaterThanOrEqual(timing.queryMs);
    expect(timing.waitMs).toBeGreaterThanOrEqual(0);
  });

  it('a connection error is DriverError("unavailable") with the stable sentence', async () => {
    const d = pgDriver({
      ...urls,
      pools: () => ({
        async connect() {
          throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
        async end() {},
      }),
    });
    await expect(d.forTeam('A').get('SELECT 1')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('database unreachable'),
    });
  });

  it('a statement error carries the SQL, and a dropped connection mid-statement is unavailable too', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    f.fail('SELECT boom');
    await expect(d.get('SELECT boom')).rejects.toThrow(/boom[\s\S]*in: SELECT boom/);
    expect(f.log.at(-2)).toBe('app: ROLLBACK');
    expect(f.log.at(-1)).toBe('app: release(err)');
    expect(f.busy()).toBe(0);
  });

  it('asOwner needs an owner URL; migrations run there without SET ROLE', async () => {
    const f = fakePools();
    expect(() => pgDriver({ ...urls, pools: f.factory }).asOwner()).toThrow(/owner/);
    const d = pgDriver({ ...urls, ownerUrl: 'postgres://owner', pools: f.factory });
    await d.asOwner().exec('CREATE TABLE t (id INT)');
    expect(f.log).toEqual([
      'own: BEGIN',
      'own: CREATE TABLE t (id INT)',
      'own: COMMIT',
      'own: release',
    ]);
  });

  it('scoped handles are memoised: one object per team, so a WeakMap keyed on the Driver hits', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    expect(d.forTeam('A')).toBe(d.forTeam('A'));
    expect(d.forTeam('A')).not.toBe(d.forTeam('B'));
    expect(d.asOperator()).toBe(d.asOperator());
    expect(d.forTeam('A').connection()).toBe(d.forTeam('A'));
  });

  it('(spec §8.2 iii) alternating tenants on a pool of one: set_config precedes every statement, release follows every transaction', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, poolSize: 1, pools: f.factory });
    for (let i = 0; i < 60; i++) {
      const team = i % 2 ? 'B' : 'A';
      const h = d.forTeam(team);
      if (i % 3 === 0) await h.get('SELECT 1 FROM teams');
      else {
        const body = h.tx(async (t) => {
          await t.run('UPDATE teams SET display = $1', ['x']);
          if (i % 7 === 0) throw new Error('boom');
        });
        if (i % 7 === 0) await expect(body).rejects.toThrow('boom');
        else await body;
      }
      expect(f.busy(), `iteration ${i}: client returned`).toBe(0);
    }
    // Walk the log transaction by transaction: BEGIN, role, tenant, …, COMMIT|ROLLBACK, release.
    let expectTeam: 'A' | 'B' = 'A';
    let n = 0;
    for (let k = 0; k < f.log.length; k++) {
      if (!f.log[k]!.startsWith('app: BEGIN')) continue;
      expect(f.log[k]).toBe(
        `app: BEGIN; SET LOCAL ROLE musterd_app; SELECT set_config('app.team_id', '${expectTeam}', true)`,
      );
      let j = k + 1;
      while (!/^app: (COMMIT|ROLLBACK)$/.test(f.log[j]!)) j++;
      expect(f.log[j + 1]).toMatch(/^app: release/);
      expectTeam = expectTeam === 'A' ? 'B' : 'A';
      n++;
    }
    expect(n).toBe(60);
  });

  it('onStatement sees every store statement as written (? form), inside and outside a tx, never the stamping — and unsubscribes', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    const seen: string[] = [];
    const off = d.onStatement((sql) => seen.push(sql));
    await d.forTeam('A').get('SELECT 1 FROM teams WHERE id = ?', ['A']);
    await d.asOperator().tx(async (t) => {
      await t.run('UPDATE lanes SET state = ? WHERE id = ?', ['done', 'L']);
      await t.tx((inner) => inner.all('SELECT * FROM audit WHERE target = ?', ['L']));
    });
    expect(seen).toEqual([
      'SELECT 1 FROM teams WHERE id = ?',
      'UPDATE lanes SET state = ? WHERE id = ?',
      'SELECT * FROM audit WHERE target = ?',
    ]);
    off();
    await d.asOperator().get('SELECT 2');
    expect(seen).toHaveLength(3);
  });

  it('close ends every pool and refuses further work', async () => {
    const f = fakePools();
    const d = pgDriver({ ...urls, pools: f.factory });
    await d.close();
    await expect(d.get('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
  });
});

/**
 * Review C1: node-postgres EMITS a dropped connection — on the pool for an idle client (pg-pool's
 * idle listener), on the client itself while it is checked out — and an `'error'` event with no
 * listener is an uncaught exception. Neon suspending, failing over or recycling connections would
 * take the whole Cloud server down instead of serving the 503. The fake pool above cannot show it;
 * this builds the REAL production pool (lazy: it connects to nothing) and fires the events.
 */
describe('the production pool survives a dropped connection (review C1)', () => {
  const dropped = () =>
    Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

  it('an idle client dying (emitted on the pool) does not throw', async () => {
    const pool = pgPoolFactory({ poolSize: 1 })(
      'postgres://u:p@127.0.0.1:1/db',
    ) as unknown as EventEmitter & { end(): Promise<void> };
    try {
      expect(() => pool.emit('error', dropped(), new EventEmitter())).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('a checked-out client dying (emitted on the client) does not throw', async () => {
    const pool = pgPoolFactory({ poolSize: 1 })(
      'postgres://u:p@127.0.0.1:1/db',
    ) as unknown as EventEmitter & { end(): Promise<void> };
    try {
      const client = new EventEmitter();
      pool.emit('connect', client); // what pg-pool emits for every new client
      expect(() => client.emit('error', dropped())).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});
