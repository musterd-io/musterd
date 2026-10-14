import type { SyncPullStop } from '@musterd/protocol';
import type { Ctx } from '../context.js';

/**
 * ADR 591: the HUB's standing fold stop, as this joiner last heard it. The hub answers every push
 * and every pull page with `fold_stopped` — its own ADR 547 stop, raw — and this daemon keeps the
 * latest answer here so its roster can say "the hub is held, and here is why" to the seats whose
 * lanes are the ones waiting. A stop on the hub is the one that matters to a joiner: every lane
 * claim, handoff and submit from every machine is arbitrated there and sits behind it.
 *
 * In memory, keyed per daemon config like the pull stop (two daemons in one process must not share
 * it): the hub restates it on every answer, so a restart relearns it within one push or pull.
 */
const hubStopsByConfig = new WeakMap<Ctx['config'], Map<string, SyncPullStop>>();

/** The same grace ADR 547 gives this machine's own stop: one tick is routine, five minutes is a warning. */
export const HUB_STOP_WARN_AFTER_MS = 5 * 60_000;

/**
 * Record what the hub said. `null` means the hub's fold is moving; `undefined` means an older hub
 * that does not say — both clear what was held, so a stale stop never outlives the hub that
 * reported it.
 */
export function noteHubStop(ctx: Ctx, teamId: string, stop: SyncPullStop | null | undefined): void {
  let teams = hubStopsByConfig.get(ctx.config);
  if (!teams) hubStopsByConfig.set(ctx.config, (teams = new Map()));
  if (!stop) {
    teams.delete(teamId);
    return;
  }
  teams.set(teamId, stop);
}

/**
 * The hub's standing stop for the team, or null — read by the roster and the inbox warning. Null
 * inside the grace (measured from the hub's own `since`), null when the hub is folding, null on the
 * hub itself (it never hears a hub answer) and on a machine that has no hub.
 */
export function readHubStop(
  config: Ctx['config'],
  teamId: string,
  now: number = Date.now(),
): SyncPullStop | null {
  const stop = hubStopsByConfig.get(config)?.get(teamId);
  return stop && now - stop.since >= HUB_STOP_WARN_AFTER_MS ? stop : null;
}
