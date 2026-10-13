// The roster's team-wide reads, shared across viewers (ADR 541, lane 01M49MEFFR; widened by ADR 573,
// lane 01M4GQ3CQV). ADR 541 shared two statements in `summarize` — the quiescence fold and every
// member's latest status — that are the same for every viewer of a team, yet ran once per
// GET /teams/:slug. ADR 573 shares the whole set: the team row, reclaim grace, residency facts and
// residences, live drivers, the style policy and the presence roster, which with the two above made
// about 11 reads per request. Load run 31 (2026-10-12): 26 671 roster reads in 1 300 s on one team,
// about 20 a second, all asking the same thing. One load per team now serves every viewer for
// ROSTER_SHARED_TTL_MS; only the viewer's own auth and projection stay per request.
//
// Unlike `reportCache` there is no stale-while-revalidate: past the window a reader waits for the
// fresh load (joining one in flight), so the roster is never older than the window. The window is
// counted from when the load STARTED — a slow load does not extend what it serves. A route that has
// just written and reads the roster back passes `fresh` and reads straight through.
//
// Cloud only. A local daemon serves a handful of viewers and its tests write then read at once, so
// it keeps reading straight through — the exact pre-541 behaviour.
import type { Ctx } from '../context.js';

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

// Keyed by the server's config object: `teamCtx` spreads the root ctx, so every request's ctx on one
// server shares it, while `ctx.db` is a fresh team handle per request on Postgres (a cache keyed by
// that would be a cache per request — the reportCache lesson, 2026-10-03).
const perServer = new WeakMap<Ctx['config'], ReturnType<typeof createSharedRead<unknown>>>();

/**
 * The roster's team-wide reads, through one shared load per team. `load` runs on THIS request's
 * team-scoped handle, so RLS holds, and its value is only ever handed to readers of the same team.
 * The value is shared: callers read it and never mutate it.
 */
export async function sharedRosterBase<T>(
  ctx: { config: Ctx['config'] },
  teamId: string,
  load: () => Promise<T>,
  opts: { fresh?: boolean } = {},
): Promise<T> {
  if (ctx.config.mode !== 'cloud' || opts.fresh) return load();
  let read = perServer.get(ctx.config);
  if (!read) {
    read = createSharedRead<unknown>();
    perServer.set(ctx.config, read);
  }
  return (await read.get(teamId, load)) as T;
}
