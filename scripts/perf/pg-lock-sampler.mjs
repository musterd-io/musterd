#!/usr/bin/env node
/**
 * Sample what Postgres sessions are waiting on, every INTERVAL_S seconds, during a §8.1 load run
 * (lane 01M3Z455NE). ADR 504 moved the node counter's lock and the write queue did not move, so
 * the queue's cause has to be read from the database rather than guessed from the code.
 *
 * Each sample prints one JSON line per non-idle session in this database: its wait event, how long
 * its transaction has run, the pids blocking it, the lock it is waiting for (relation and mode), and
 * the first 160 characters of its statement. Statements are the server's SQL with bind parameters
 * ($1, $2…), never values, so the output carries no tenant data or secrets.
 *
 * Reading other sessions' statements needs pg_read_all_stats, so run it as the OWNER login (Neon's
 * owner role carries it); the URL is read from the environment and never printed.
 *
 *   DATABASE_URL='postgres://<owner login>:…@<direct host>/musterd' \
 *     INTERVAL_S=10 DURATION_S=1400 node scripts/perf/pg-lock-sampler.mjs > run7-locks.jsonl
 *
 * Summarise afterwards with `jq` — e.g. the most-waited-on relations:
 *   jq -r 'select(.lock_relation) | .lock_relation + " " + .lock_mode' run7-locks.jsonl | sort | uniq -c | sort -rn
 */
import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('pg-lock-sampler: set DATABASE_URL (the owner login on the direct host)');
  process.exit(2);
}
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 1400);

const SAMPLE = `
  SELECT a.pid,
         a.state,
         a.wait_event_type,
         a.wait_event,
         round(extract(epoch FROM now() - a.xact_start)::numeric, 2) AS xact_s,
         pg_blocking_pids(a.pid) AS blocked_by,
         l.locktype AS lock_type,
         l.relation::regclass::text AS lock_relation,
         l.mode AS lock_mode,
         left(regexp_replace(a.query, '\\s+', ' ', 'g'), 160) AS query
    FROM pg_stat_activity a
    LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
   WHERE a.datname = current_database()
     AND a.pid <> pg_backend_pid()
     AND a.state <> 'idle'`;

const client = new pg.Client({ connectionString: url });
await client.connect();
const stop = Date.now() + DURATION_S * 1000;
let samples = 0;
try {
  while (Date.now() < stop) {
    const ts = new Date().toISOString();
    const { rows } = await client.query(SAMPLE);
    for (const r of rows) process.stdout.write(JSON.stringify({ ts, ...r }) + '\n');
    if (rows.length === 0) process.stdout.write(JSON.stringify({ ts, idle: true }) + '\n');
    samples++;
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
} finally {
  await client.end();
  console.error(`pg-lock-sampler: ${samples} samples`);
}
