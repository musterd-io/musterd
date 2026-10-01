import type { PortableMigration } from './ladder.js';

/**
 * The trace store's portable ladder (ADR 445 §3: its own file, its own versions), from trace v4;
 * the Postgres baseline `pg/trace-0003-baseline.sql` is trace v3. Its own module because
 * `pnpm migrations:check` reads each ladder file as one strictly ascending sequence.
 */
export const TRACE_LADDER: PortableMigration[] = [
  {
    // trace v4 (1B): `row_seq`, the push cursor's column. The cursor was SQLite's `rowid`, which
    // Postgres does not have; a column both engines fill on insert — the trigger on SQLite, an
    // identity on Postgres — keeps the ADR 453 cursor sound (nothing deletes from this table, so
    // it only grows) with one SQL text. Idempotent under rewind-and-replay.
    version: 4,
    sqlite: (db) => {
      const cols = (db.prepare('PRAGMA table_info(trace_events)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!cols.includes('row_seq')) db.exec('ALTER TABLE trace_events ADD COLUMN row_seq INTEGER');
      db.exec('UPDATE trace_events SET row_seq = rowid WHERE row_seq IS NULL');
      db.exec(`CREATE TRIGGER IF NOT EXISTS trace_events_row_seq AFTER INSERT ON trace_events
        FOR EACH ROW WHEN NEW.row_seq IS NULL
        BEGIN UPDATE trace_events SET row_seq = NEW.rowid WHERE rowid = NEW.rowid; END`);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_trace_events_row_seq ON trace_events (team_id, row_seq)',
      );
    },
    postgres: async (d) => {
      await d.exec(
        'ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS row_seq BIGINT GENERATED ALWAYS AS IDENTITY',
      );
      await d.exec(
        'CREATE INDEX IF NOT EXISTS idx_trace_events_row_seq ON trace_events (team_id, row_seq)',
      );
    },
  },
];
