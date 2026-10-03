import { lastWorkingDayEnd, localDate, workingDayStart } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { addMember, getMemberByName } from '../store/members.js';
import { parseWorkingHours, type MemberRow, type TeamRow } from '../store/rows.js';
import { getTeamById, listActiveTeams } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
import { postDigest } from './digest.js';

/**
 * The morning digest's schedule (ADR 494 §5, goal dreaming): at the start of a team's working
 * hours the daemon posts the digest as one scheduled seat, on its own clock — never from a dream,
 * whose gate only holds outside working hours. A post is a free state move, not a spend-bearing
 * wake, so a clock may drive it (ADR 250 §2).
 *
 * Every tick asks one question per team with a schedule: is it inside a working window, and is
 * today's digest missing? `postDigest` is idempotent per (team, day) by construction, so a missed
 * 08:00 tick (the laptop was asleep) posts at the first tick after, and a second tick posts nothing.
 *
 * The digest is the hub's to post, team by team, like the reaper's team-wide sweeps (ADR 361 §1,
 * ADR 371 §2). An enrolled joiner holds a replica whose receipt clock is its own sync time: on
 * 2026-10-03 a joiner enrolled the night before posted a second digest beside the hub's, with every
 * ask aged "16h4m" (its re-sync) and nothing learned. The once-per-day guard could not catch it —
 * each daemon checked only its own rows. So a joiner skips the team, and gets the hub's digest by
 * the pull.
 */

/** The service seat that posts the digest (ADR 232: a ledger seat, never a lane owner). */
export const DIGEST_SEAT = 'digest';

/** How often the schedule looks. A digest lands within a minute of working-hours start. */
export const DIGEST_TICK_MS = 60_000;

/**
 * The team's `digest` service seat, minted on first use. Null when the name is already held by a
 * seat that is not a service — the schedule will not post as somebody's agent or person.
 */
async function digestSeat(db: Driver, team: TeamRow): Promise<MemberRow | null> {
  const existing = await getMemberByName(db, team.id, DIGEST_SEAT);
  if (existing) return existing.kind === 'service' && existing.left_at === null ? existing : null;
  return (await addMember(db, team, { name: DIGEST_SEAT, kind: 'service' })).row;
}

/**
 * One pass: post today's digest for every team inside its working window that has not had one.
 * `send` is how a post is stored and delivered; omitted, `postDigest` inserts directly (tests).
 * Returns the number of digests posted.
 */
export async function digestTick(
  db: Driver,
  now = Date.now(),
  send?: (team: TeamRow, from: MemberRow) => Parameters<typeof postDigest>[3]['send'],
): Promise<number> {
  let posted = 0;
  for (const { id } of await listActiveTeams(db)) {
    const team = await getTeamById(db, id);
    if (team && (await joinerEnrollment(db, team.id, team.slug))) continue;
    const hours = parseWorkingHours(team?.working_hours);
    if (!team || !hours) continue;
    const start = workingDayStart(hours, now);
    if (start === null) continue;
    const nightStart = lastWorkingDayEnd(hours, start);
    if (nightStart === null) continue;
    const from = await digestSeat(db, team);
    if (!from) {
      log.warn({ msg: 'digest_seat_taken', team: team.slug, seat: DIGEST_SEAT });
      continue;
    }
    const deliver = send?.(team, from);
    const row = await postDigest(db, { id: team.id, slug: team.slug }, from, {
      day: localDate(hours.timezone, now),
      nightStart,
      now,
      ...(deliver ? { send: deliver } : {}),
    });
    if (row) posted++;
  }
  return posted;
}

/** Start the schedule on the daemon. The post rides `routeEnvelope`, so `/live` sees it live. */
export function startDigestSchedule(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow pass must not stack
    running = true;
    try {
      const posted = await digestTick(
        ctx.db,
        Date.now(),
        (team, from) => async (env) =>
          (await routeEnvelope(ctx, team, from, env, undefined, true)).message,
      );
      if (posted > 0) log.info({ msg: 'digest_posted', count: posted });
    } catch (error) {
      log.warn({ msg: 'digest_tick_failed', error: String(error) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), DIGEST_TICK_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
