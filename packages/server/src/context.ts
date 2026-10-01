import type { ResolvedConfig } from './config.js';
import type { Driver } from './db/driver.js';
import type { Hub } from './transport/hub.js';

/** Shared server context threaded through transports and the router. */
export interface Ctx {
  db: Driver;
  /** The trace store (ADR 445 §3) — a separate file; nothing joins it to `db` at write time. */
  traceDb: Driver;
  hub: Hub;
  config: ResolvedConfig;
  /** Durable roster roots (ADR 058). Empty ⇒ no file-backed teams; the legacy db-authoritative
   * provisioning path stays in force (per-team cutover, migration-bootstrap.md). */
  rosterRoots: string[];
}

/**
 * The tenant seam (cloud design §12.1). A request's ctx becomes team-scoped exactly once — where the
 * transport resolves `/teams/:slug` (http.ts) or the claim frame's team (ws.ts) — and every store
 * call under it runs as the app role inside that team's rows. On SQLite both helpers hand back the
 * same handle (one team per file). Never called by store code.
 */
export function teamCtx(ctx: Ctx, teamId: string): Ctx {
  return { ...ctx, db: ctx.db.forTeam(teamId), traceDb: ctx.traceDb.forTeam(teamId) };
}

/**
 * The cross-tenant ctx for work legitimately about every team: the presence reaper, retention, the
 * census, `/health`, team creation, the sync loops, slug → team resolution. `asOperator(` is the
 * greppable audit list of every cross-tenant read; this is its one wrapper.
 */
export function operatorCtx(ctx: Ctx): Ctx {
  return { ...ctx, db: ctx.db.asOperator(), traceDb: ctx.traceDb.asOperator() };
}
