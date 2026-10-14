import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { reconcileAll } from '../projection/reconcile.js';
import { broadcastReconciled } from '../transport/memberAdded.js';

/**
 * ADR 592: when this daemon's fold stops on a seat its roster does not hold, pull the roster repo.
 *
 * A seat's roster entry travels by git (ADR 058); its events travel by sync. A fold that meets an
 * event naming a seat it cannot resolve stops — ADR 393 chose stop over skip, and ADR 547/591 made
 * the stop visible at both ends. What they left to a human was the one command that ends it on the
 * stopped machine: `git pull` in the roster home. On 2026-10-13 that command was not run on the hub
 * for 100 minutes, and every lane claim, submit and acceptance from every machine waited behind it.
 *
 * This module runs that pull. It is deliberately narrow: `git pull --ff-only` in a roster root that
 * is a git checkout with an upstream, nothing else — no merge, no rebase, no commit, never a push.
 * A root that cannot fast-forward (local commits, a dirty tree git refuses on) is reported with the
 * command a human needs, and the stop stands as before. The daemon never resolves a conflict.
 */

const execFileAsync = promisify(execFile);

/** How long one `git` call may take before this daemon gives up on it for this tick. */
export const ROSTER_REFRESH_GIT_TIMEOUT_MS = 20_000;

/**
 * How often the same stop may trigger a pull while it holds. The first tick that sees a stop pulls
 * at once (the seat file is usually one `git pull` away); after that, once a minute — a hub whose
 * joiner never pushed the file must not shell out to git on every pull page.
 */
export const ROSTER_REFRESH_MIN_INTERVAL_MS = 60_000;

export interface RosterRefreshOutcome {
  root: string;
  /**
   *  - `updated` — the pull fast-forwarded HEAD; the roster may now hold the seat.
   *  - `current` — the pull ran and HEAD did not move: the remote has nothing newer.
   *  - `skipped` — not a git checkout, or no upstream to pull from; nothing to do here.
   *  - `failed` — git refused or timed out; `detail` carries the first line it said.
   */
  outcome: 'updated' | 'current' | 'skipped' | 'failed';
  detail?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: ROSTER_REFRESH_GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; killed?: boolean };
  if (e.killed) return `git timed out after ${ROSTER_REFRESH_GIT_TIMEOUT_MS} ms`;
  const text =
    typeof e.stderr === 'string' && e.stderr.trim() !== ''
      ? e.stderr
      : typeof e.message === 'string'
        ? e.message
        : String(err);
  return text.trim().split('\n')[0] ?? '';
}

/** Fast-forward one roster root from its upstream. Never throws. */
export async function refreshRosterRoot(root: string): Promise<RosterRefreshOutcome> {
  try {
    if ((await git(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true')
      return { root, outcome: 'skipped', detail: 'not a git checkout' };
  } catch {
    return { root, outcome: 'skipped', detail: 'not a git checkout' };
  }
  try {
    await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  } catch {
    return { root, outcome: 'skipped', detail: 'no upstream branch to pull from' };
  }
  let before: string;
  try {
    before = await git(root, ['rev-parse', 'HEAD']);
  } catch (err) {
    return { root, outcome: 'failed', detail: firstLine(err) };
  }
  try {
    await git(root, ['pull', '--ff-only', '--quiet']);
  } catch (err) {
    return { root, outcome: 'failed', detail: firstLine(err) };
  }
  try {
    const after = await git(root, ['rev-parse', 'HEAD']);
    return { root, outcome: after === before ? 'current' : 'updated' };
  } catch (err) {
    return { root, outcome: 'failed', detail: firstLine(err) };
  }
}

/** Every roster root, in order. Roots are pulled one at a time; git holds its own locks. */
export async function refreshRosterRoots(
  roots: readonly string[],
): Promise<RosterRefreshOutcome[]> {
  const out: RosterRefreshOutcome[] = [];
  for (const root of roots) out.push(await refreshRosterRoot(root));
  return out;
}

/** When each (team, seat) stop last triggered a pull, per daemon. */
const lastAttemptByConfig = new WeakMap<Ctx['config'], Map<string, number>>();

/**
 * The hook `pullPage` calls on an `unresolved_seat` stop (`Ctx.onUnresolvedSeat`): pull every roster
 * root, reconcile what arrived, and say whether anything moved. `true` tells the puller to fold the
 * page again now, in the same tick; `false` leaves the stop standing until the next tick, as before.
 *
 * Rate-limited per team and seat so a seat that never arrives costs one git call a minute, not one
 * per page. `deps` exists for the tests; production wiring passes nothing.
 */
export function makeUnresolvedSeatHook(
  ctx: Ctx,
  deps: {
    refresh?: (roots: readonly string[]) => Promise<RosterRefreshOutcome[]>;
    reconcile?: (roots: readonly string[]) => Promise<void>;
    now?: () => number;
  } = {},
): NonNullable<Ctx['onUnresolvedSeat']> {
  const refresh = deps.refresh ?? refreshRosterRoots;
  const reconcile =
    deps.reconcile ??
    (async (roots: readonly string[]) => {
      const results = await reconcileAll(ctx.db, [...roots]);
      await broadcastReconciled(ctx, results);
    });
  const now = deps.now ?? Date.now;
  return async (team, seat) => {
    if (ctx.rosterRoots.length === 0) return false;
    let attempts = lastAttemptByConfig.get(ctx.config);
    if (!attempts) lastAttemptByConfig.set(ctx.config, (attempts = new Map()));
    const key = `${team.id}:${seat}`;
    const last = attempts.get(key);
    const at = now();
    if (last !== undefined && at - last < ROSTER_REFRESH_MIN_INTERVAL_MS) return false;
    attempts.set(key, at);
    const outcomes = await refresh(ctx.rosterRoots);
    for (const o of outcomes) {
      if (o.outcome === 'failed') {
        log.warn({
          msg: 'sync_roster_refresh_failed',
          team: team.slug,
          seat,
          root: o.root,
          detail: `${o.detail ?? 'git failed'} — the fold stays held on "${seat}"; run \`git -C ${o.root} pull\` by hand and check .musterd/seats/${seat}.toml was pushed (ADR 592)`,
        });
      } else {
        log.info({
          msg: 'sync_roster_refreshed',
          team: team.slug,
          seat,
          root: o.root,
          outcome: o.outcome,
          ...(o.detail ? { detail: o.detail } : {}),
        });
      }
    }
    const moved = outcomes.some((o) => o.outcome === 'updated');
    if (moved) {
      try {
        await reconcile(ctx.rosterRoots);
      } catch (err) {
        log.warn({
          msg: 'sync_roster_refresh_reconcile_failed',
          team: team.slug,
          err: String(err),
        });
        return false;
      }
    }
    return moved;
  };
}

/** Test seam: forget every attempt this daemon recorded. */
export function resetRosterRefreshAttempts(config: Ctx['config']): void {
  lastAttemptByConfig.delete(config);
}
