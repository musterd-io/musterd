import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from './db.js';

/**
 * Tests only: a PGlite instance behind the console's `Queryable` seam. A parameterless call runs
 * through `exec` (several statements, as `pg`'s simple protocol allows); one with params runs the
 * extended protocol, as `pg` does.
 */
export async function pglite(): Promise<{ db: PGlite; q: Queryable }> {
  const db = await PGlite.create();
  const q: Queryable = {
    async query<R>(sql: string, params?: unknown[]) {
      if (params && params.length > 0) {
        const r = await db.query<R>(sql, params);
        return { rows: r.rows };
      }
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as R[] };
    },
  };
  return { db, q };
}
