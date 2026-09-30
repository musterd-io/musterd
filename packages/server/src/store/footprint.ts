import type { Driver } from '../db/driver.js';

export interface FootprintStackRow {
  ts: number;
  classification: 'live' | 'orphaned' | 'unattributed';
  seat: string | null;
  procs: number;
  rss_kb: number;
  pids: string;
}

export interface FootprintMachineRow {
  ts: number;
  swap_used_mb: number | null;
  swap_total_mb: number | null;
  free_mem_mb: number | null;
}

export interface FootprintTick {
  ts: number;
  stacks: FootprintStackRow[];
  machine: FootprintMachineRow;
}

export async function insertFootprintTick(
  db: Driver,
  stacks: FootprintStackRow[],
  machine: FootprintMachineRow,
): Promise<void> {
  await db.tx(async (t) => {
    await t.run(
      `INSERT INTO footprint_machine (ts, swap_used_mb, swap_total_mb, free_mem_mb)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ts) DO UPDATE SET
         swap_used_mb = excluded.swap_used_mb,
         swap_total_mb = excluded.swap_total_mb,
         free_mem_mb = excluded.free_mem_mb`,
      [machine.ts, machine.swap_used_mb, machine.swap_total_mb, machine.free_mem_mb],
    );
    for (const s of stacks) {
      await t.run(
        `INSERT INTO footprint_stacks (ts, classification, seat, procs, rss_kb, pids)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [s.ts, s.classification, s.seat, s.procs, s.rss_kb, s.pids],
      );
    }
  });
}

export async function latestFootprint(db: Driver): Promise<FootprintTick | null> {
  const machine = await db.get<FootprintMachineRow>(
    'SELECT ts, swap_used_mb, swap_total_mb, free_mem_mb FROM footprint_machine ORDER BY ts DESC LIMIT 1',
  );
  if (!machine) return null;
  const stacks = await db.all<FootprintStackRow>(
    `SELECT ts, classification, seat, procs, rss_kb, pids
       FROM footprint_stacks WHERE ts = ? ORDER BY rss_kb DESC`,
    [machine.ts],
  );
  return { ts: machine.ts, stacks, machine };
}

export async function pruneFootprint(db: Driver, cutoffTs: number): Promise<number> {
  return db.tx(async (t) => {
    await t.run('DELETE FROM footprint_stacks WHERE ts < ?', [cutoffTs]);
    const res = await t.run('DELETE FROM footprint_machine WHERE ts < ?', [cutoffTs]);
    return res.changes;
  });
}
