import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCursor, migrate, setCursor } from './cursors.mjs';
import { pgliteDriver, sqliteDriver, type Driver } from './driver.mjs';

const drivers: Array<[string, () => Promise<Driver>]> = [
  ['sqlite', async () => sqliteDriver(join(mkdtempSync(join(tmpdir(), 'cur-')), 'x.db'))],
  ['pglite', async () => pgliteDriver(undefined)],
];

describe.each(drivers)('cursors on %s', (_name, open) => {
  let d: Driver;
  afterEach(async () => {
    await d?.close();
  });

  it('a seat that never read has a zero cursor', async () => {
    d = await open();
    await migrate(d);
    expect(await getCursor(d, 'm1')).toEqual({
      member_id: 'm1',
      last_read_message_id: null,
      last_read_ts: 0,
      updated_at: 0,
    });
  });

  it('setCursor reads the position off the message row and records an audit event in one transaction', async () => {
    d = await open();
    await migrate(d);
    await d.run('INSERT INTO messages (id, team_id, created_at) VALUES (?, ?, ?)', [
      'msg1',
      't1',
      1234,
    ]);
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
