import type { Queryable } from './db.js';

/**
 * Fixed-window rate limits held in the database, so they hold across both console servers
 * (ADR 620 decision 9). A bucket names what is limited — `ip:<addr>`, `email:<hash>`,
 * `global:email-send` — and each hit is one atomic upsert that returns the new count. A limit never
 * locks an account: it slows the bucket that tripped, and a victim's own address is a separate
 * bucket from an attacker's IP.
 */
export interface Limit {
  bucket: string;
  max: number;
  windowMs: number;
}

/** Count one hit; true while the bucket is within its limit for the current window. */
export async function hit(db: Queryable, limit: Limit, now: number): Promise<boolean> {
  const windowStart = now - (now % limit.windowMs);
  const r = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [limit.bucket, windowStart],
  );
  return Number(r.rows[0]?.count ?? 1) <= limit.max;
}

/** Drop windows older than `olderThanMs` — called opportunistically, never on the hot path's error. */
export async function pruneRateLimits(
  db: Queryable,
  now: number,
  olderThanMs: number,
): Promise<void> {
  await db.query('DELETE FROM rate_limits WHERE window_start < $1', [now - olderThanMs]);
}
