import type { Affinity } from './cloud/affinity.js';
import type { ResolvedConfig } from './config.js';
import type { Driver } from './db/driver.js';
import type { Hub } from './transport/hub.js';
import type { RemoteMcpFactory } from './transport/mcpHttp.js';
import type { SeatPulses } from './transport/seatPulses.js';

/** Shared server context threaded through transports and the router. */
export interface Ctx {
  db: Driver;
  /** The trace store (ADR 445 §3) — a separate file; nothing joins it to `db` at write time. */
  traceDb: Driver;
  hub: Hub;
  /** ADR 660: each seat's tool-call heartbeat, pushed over the firehose. Absent in bare test ctxs. */
  pulses?: SeatPulses;
  /** ADR 608: which server owns a team on Cloud; null means every team is local (self-hosted). */
  affinity?: Affinity | null;
  config: ResolvedConfig;
  /** Durable roster roots (ADR 058). Empty ⇒ no file-backed teams; the legacy db-authoritative
   * provisioning path stays in force (per-team cutover, migration-bootstrap.md). */
  rosterRoots: string[];
  /**
   * ADR 592: what the pull loop does when its fold stops on a seat this roster does not hold —
   * pull the roster roots from git and reconcile (`sync/rosterRefresh.ts`). Resolves `true` when
   * something arrived and the page should be folded again now. Absent (tests, a daemon with no
   * roster roots) the stop stands until the next tick, as before.
   */
  onUnresolvedSeat?: (team: { id: string; slug: string }, seat: string) => Promise<boolean>;
  /** ADR 630 §2: builds the remote MCP's tools per request; absent, `/mcp/:team` tools answer 503. */
  remoteMcp?: RemoteMcpFactory | undefined;
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
