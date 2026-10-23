import { makeEnvelope, type Lane } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { boardSeat } from '../store/boardSeat.js';
import {
  closeWatches,
  laneHead,
  moveWatchHolder,
  pendingWatches,
  type PendingWatch,
} from '../store/handover.js';
import { getLane } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import { getTeamById } from '../store/teams.js';
import { routeEnvelope } from './route.js';

/**
 * ADR 724: a held-file refusal watches the holder's lane, and the refused seat is told when the
 * file is free. The watch is the `gate_hold_refusals` row ADR 697 already writes; this sweep reads
 * every open one against its lane, so a lane that ends here or arrives ended through the fold is
 * seen the same way. One directed act per watching seat and lane, from the board seat (ADR 649).
 */

/** How often the sweep reads open watches. Small table, cheap read; a waiting agent waits in 45 s calls. */
export const LANE_WATCH_SWEEP_MS = 2_000;
/** A watch whose lane has not freed the file in this long is dropped without a notice (ADR 724 §5). */
export const LANE_WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const CONTENDING = new Set(['claimed', 'active', 'blocked']);

/** How the lane let the file go, in the words the act uses. */
function endedOf(lane: Lane): string {
  if (lane.state === 'open') return 'released';
  if (lane.state === 'awaiting_acceptance' || lane.state === 'ready_for_review') return 'submitted';
  return lane.state;
}

function quoted(paths: string[]): string {
  return paths.map((p) => `'${p}'`).join(', ');
}

/** One pass: every open watch, grouped by team, seat and lane. Returns the number of acts sent. */
export async function sweepLaneWatches(ctx: Ctx, now = Date.now()): Promise<number> {
  const groups = new Map<string, PendingWatch[]>();
  for (const w of await pendingWatches(ctx.db)) {
    const key = `${w.team_id}\u0000${w.seat}\u0000${w.holder_lane_id}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  let sent = 0;
  for (const watches of groups.values()) {
    try {
      sent += await settleGroup(ctx, watches, now);
    } catch (error) {
      const w = watches[0]!;
      log.warn({
        msg: 'lane_watch_failed',
        lane: w.holder_lane_id,
        seat: w.seat,
        err: String(error),
      });
    }
  }
  return sent;
}

async function settleGroup(ctx: Ctx, watches: PendingWatch[], now: number): Promise<number> {
  const { team_id: teamId, seat, holder_lane_id: laneId } = watches[0]!;
  const stale = watches.filter((w) => now - w.refused_at > LANE_WATCH_MAX_AGE_MS);
  if (stale.length > 0) {
    await closeWatches(
      ctx.db,
      teamId,
      seat,
      stale.map((w) => w.path),
      now,
    );
    log.info({ msg: 'lane_watch_dropped', lane: laneId, seat, paths: stale.length });
  }
  const live = watches.filter((w) => now - w.refused_at <= LANE_WATCH_MAX_AGE_MS);
  if (live.length === 0) return 0;

  const team = await getTeamById(ctx.db, teamId);
  if (!team) return 0;
  const lane = await getLane(ctx.db, teamId, laneId, team.slug);
  const paths = live.map((w) => w.path);
  if (!lane) {
    // The lane is gone from this daemon: nothing holds the file through it any more.
    await closeWatches(ctx.db, teamId, seat, paths, now);
    return 0;
  }

  const contending = CONTENDING.has(lane.state);
  const freed = contending ? paths.filter((p) => !lane.scope.includes(p)) : paths;
  const stillHeld = paths.filter((p) => !freed.includes(p));
  const branch = lane.branch ?? null;
  const head = await laneHead(ctx.db, teamId, laneId);
  const at = branch ? `${branch}${head ? ` at ${head.slice(0, 12)}` : ''}` : null;
  const work = at
    ? ` Their work is on ${at}: bring it in before you edit.`
    : ' No branch was seen for their edits.';
  let sent = 0;

  if (freed.length > 0) {
    const ended = contending ? 'no longer naming the file' : endedOf(lane);
    const holder = lane.owner_seat ?? live[0]!.holder;
    const ok = await deliver(
      ctx,
      team,
      seat,
      `[lane] ${holder}'s lane "${lane.title}" is ${ended}: ${quoted(freed)} ${freed.length === 1 ? 'is' : 'are'} free.${work}`,
      {
        lane_freed: {
          lane: lane.id,
          holder,
          ended: contending ? 'narrowed' : endedOf(lane),
          paths: freed,
          branch,
          head,
        },
      },
    );
    if (ok) {
      await closeWatches(ctx.db, teamId, seat, freed, now);
      sent += 1;
    }
  }

  // ADR 724 amendment: a handoff moves the hold with the lane, so the file is still held; the
  // waiting seat is told who holds it now, and the watch stays.
  const owner = lane.owner_seat;
  const moved = owner
    ? stillHeld.filter((p) => live.find((w) => w.path === p)!.holder !== owner)
    : [];
  if (owner && moved.length > 0) {
    const from = live.find((w) => w.path === moved[0])!.holder;
    const ok = await deliver(
      ctx,
      team,
      seat,
      `[lane] ${from} handed "${lane.title}" to ${owner}: ${quoted(moved)} ${moved.length === 1 ? 'is' : 'are'} still held, now by ${owner}.${at ? ` The work so far is on ${at}.` : ''} Ask them, or wait on the lane.`,
      { lane_hold_moved: { lane: lane.id, from, to: owner, paths: moved, branch, head } },
    );
    if (ok) {
      await moveWatchHolder(ctx.db, teamId, seat, moved, owner);
      sent += 1;
    }
  }
  return sent;
}

async function deliver(
  ctx: Ctx,
  team: NonNullable<Awaited<ReturnType<typeof getTeamById>>>,
  seat: string,
  body: string,
  meta: Record<string, unknown>,
): Promise<boolean> {
  const voice = await boardSeat(ctx.db, team);
  const to = await getMemberByName(ctx.db, team.id, seat);
  if (!voice || !to) return false;
  await routeEnvelope(
    ctx,
    team,
    voice,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: voice.name,
      to: { kind: 'member', name: seat },
      act: 'message',
      body,
      meta,
    }),
    undefined,
    true,
  );
  log.info({ msg: 'lane_watch_fired', team: team.slug, seat, kind: Object.keys(meta)[0] });
  return true;
}

/** The loop: one sweep every `LANE_WATCH_SWEEP_MS`, never two at once. Returns its stop. */
export function startLaneWatch(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepLaneWatches(ctx);
    } catch (error) {
      log.warn({ msg: 'lane_watch_sweep_failed', err: String(error) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), LANE_WATCH_SWEEP_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
