// The roster's team-wide reads, shared across viewers (ADR 541, lane 01M49MEFFR). Two statements in
// `summarize` — the quiescence fold (`lastActionBySubject`) and every member's latest status
// (`latestStatusUpdates`) — are the same for every viewer of a team, yet ran once per GET /teams/:slug.
// Load run 18 (2026-10-06): about 17 roster reads a second on one team, about 1 380 s of the 1 CU
// Neon compute's 1 960 s. One load per team now serves every viewer for ROSTER_SHARED_TTL_MS.
//
// Unlike `reportCache` there is no stale-while-revalidate: past the window a reader waits for the
// fresh load (joining one in flight), so the roster is never older than the window. The window is
// counted from when the load STARTED — a slow load does not extend what it serves.
//
// Cloud only. A local daemon serves a handful of viewers and its tests write then read at once, so
// it keeps reading straight through — the exact pre-541 behaviour.
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { latestStatusUpdates } from './messages.js';
import { lastActionBySubject } from './quiescence.js';

export const ROSTER_SHARED_TTL_MS = 1_000;

interface Entry<T> {
  value?: T;
  at: number;
  inflight?: Promise<T> | undefined;
}

/** Per-team single flight with a fixed freshness window. Separated so the policy is testable. */
export function createSharedRead<T>(opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? ROSTER_SHARED_TTL_MS;
  const clock = opts.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();
  return {
    get(teamId: string, load: () => Promise<T>): Promise<T> {
      let entry = entries.get(teamId);
      if (!entry) {
        entry = { at: 0 };
        entries.set(teamId, entry);
      }
      if (entry.inflight) return entry.inflight;
      if (entry.value !== undefined && clock() - entry.at < ttl)
        return Promise.resolve(entry.value);
      const e = entry;
      const started = clock();
      e.inflight = load().then(
        (value) => {
          e.value = value;
          e.at = started;
          e.inflight = undefined;
          return value;
        },
        (err: unknown) => {
          e.inflight = undefined;
          throw err;
        },
      );
      return e.inflight;
    },
  };
}

interface RosterReads {
  lastAction: ReturnType<typeof createSharedRead<Map<string, number>>>;
  statuses: ReturnType<typeof createSharedRead<Map<string, { state: string; ts: number }>>>;
}

// Keyed by the server's config object: `teamCtx` spreads the root ctx, so every request's ctx on one
// server shares it, while `ctx.db` is a fresh team handle per request on Postgres (a cache keyed by
// that would be a cache per request — the reportCache lesson, 2026-10-03).
const perServer = new WeakMap<Ctx['config'], RosterReads>();

function readsFor(config: Ctx['config']): RosterReads {
  let r = perServer.get(config);
  if (!r) {
    r = { lastAction: createSharedRead(), statuses: createSharedRead() };
    perServer.set(config, r);
  }
  return r;
}

/**
 * The two shared roster reads. The load runs on THIS request's team-scoped handle, so RLS holds; the
 * value is only ever handed to readers of the same team.
 */
export async function rosterSharedReads(
  ctx: { db: Driver; config: Ctx['config'] },
  teamId: string,
): Promise<{
  lastAction: Map<string, number>;
  statuses: Map<string, { state: string; ts: number }>;
}> {
  if (ctx.config.mode !== 'cloud') {
    return {
      lastAction: await lastActionBySubject(ctx.db, teamId),
      statuses: await latestStatusUpdates(ctx.db, teamId),
    };
  }
  const r = readsFor(ctx.config);
  // Sequential, as `summarize` read them before: two loads at once on one team handle is not a
  // question this change needs to answer.
  const lastAction = await r.lastAction.get(teamId, () => lastActionBySubject(ctx.db, teamId));
  const statuses = await r.statuses.get(teamId, () => latestStatusUpdates(ctx.db, teamId));
  return { lastAction, statuses };
}
