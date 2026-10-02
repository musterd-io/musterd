import { migratePostgres, migrateTracePostgres } from '../db/pg/migrate.js';
import { pgDriver, type PoolFactory } from '../db/pgDriver.js';
import { postgresUrl } from './mode.js';

/**
 * The cloud migrate step (spec §6): run BEFORE a rollout, never on boot, as the OWNER login — the
 * only role that may run DDL. Reads `MUSTERD_DATABASE_OWNER_URL` and
 * `MUSTERD_TRACE_DATABASE_OWNER_URL` (the direct, unpooled host: DDL through a transaction-mode
 * pooler is not safe). The server itself never reads either. Returns each store's version after.
 * `pools` is the test seam (`pgliteDriver().poolFactory()`), as in `createServer`.
 */
export async function migrateCloud(
  env: Record<string, string | undefined>,
  opts: { pools?: { main: PoolFactory; trace: PoolFactory }; report?: (line: string) => void } = {},
): Promise<{ main: number; trace: number }> {
  // ADR 496: after the ladder the catalog is verified; a repair (replaying the idempotent ladder
  // when the catalog lacks what a version row claims) is opted into per run, never assumed.
  const ladder = {
    repair: env['MUSTERD_MIGRATE_REPAIR'] === '1',
    ...(opts.report ? { report: opts.report } : {}),
  };
  const mainUrl = postgresUrl(env, 'MUSTERD_DATABASE_OWNER_URL');
  const traceUrl = postgresUrl(env, 'MUSTERD_TRACE_DATABASE_OWNER_URL');
  // pgDriver wants app/operator URLs; the owner handle is the only one this step opens.
  const open = (url: string, pools?: PoolFactory) =>
    pgDriver({
      appUrl: url,
      operatorUrl: url,
      ownerUrl: url,
      poolSize: 1,
      ...(pools ? { pools } : {}),
    });
  const main = open(mainUrl, opts.pools?.main);
  const trace = open(traceUrl, opts.pools?.trace);
  try {
    return {
      main: await migratePostgres(main.asOwner(), ladder),
      trace: await migrateTracePostgres(trace.asOwner(), ladder),
    };
  } finally {
    await main.close();
    await trace.close();
  }
}
