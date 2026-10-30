import { makeEnvelope, type PrEventState } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { boardSeat } from '../store/boardSeat.js';
import { listLanes } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import type { TeamRow } from '../store/rows.js';
import { getTeamById, listActiveTeams } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
import { listPrsByBranch, runGh, type GhRunner, type ListedPr } from './prState.js';
import { routeEnvelope } from './route.js';

/**
 * The PR watch (ADR 779 §4): the hub reads its teams' PRs through its own `gh` and tells a lane's
 * owner when the lane's PR merges, goes red, or goes green again after red — so no seat runs a
 * watcher of its own, and none forgets to. Each (lane, PR, state) is told once: the audit row
 * `pr_event.sent` is the ledger, so a restart never repeats one and no table is needed.
 */

/** How often the watch reads GitHub: one `gh pr list` per team per sweep. */
export const PR_WATCH_SWEEP_MS = 60_000;
/** A `gh` that cannot be read is reported at most this often, per team. */
export const PR_WATCH_UNAVAILABLE_EVERY_MS = 60 * 60_000;

const WATCHED_STATES = ['claimed', 'active', 'blocked', 'awaiting_acceptance'] as const;

/** What this PR's state means to its lane's owner now, given what they were already told. */
export function prEventFor(pr: ListedPr, told: ReadonlySet<PrEventState>): PrEventState | null {
  if (pr.state === 'merged') return told.has('merged') ? null : 'merged';
  if (pr.state === 'closed') return null;
  if (pr.checks === 'red') return told.has('ci_red') && !told.has('ci_green') ? null : 'ci_red';
  if (pr.checks === 'green' && told.has('ci_red') && !told.has('ci_green')) return 'ci_green';
  return null;
}

/**
 * The states already told for this lane and PR, oldest → newest. A red after a green is a new red:
 * only the newest red/green pair counts, so a PR that flaps tells its owner each time it turns.
 */
async function toldStates(
  ctx: Ctx,
  teamId: string,
  laneId: string,
  pr: number,
): Promise<Set<PrEventState>> {
  const rows = await ctx.db.all<{ detail: string | null }>(
    `SELECT detail FROM audit WHERE team_id = ? AND action = 'pr_event.sent' AND target = ?
       ORDER BY ts ASC, id ASC`,
    [teamId, laneId],
  );
  const told = new Set<PrEventState>();
  for (const r of rows) {
    const d = r.detail ? (JSON.parse(r.detail) as { pr?: number; state?: PrEventState }) : {};
    if (d.pr !== pr || !d.state) continue;
    if (d.state === 'ci_red') told.delete('ci_green');
    told.add(d.state);
  }
  return told;
}

/** One team's sweep. Returns how many events it sent. */
export async function sweepTeamPrs(
  ctx: Ctx,
  team: TeamRow,
  now: number = Date.now(),
  run: GhRunner = runGh,
): Promise<number> {
  const lanes = (
    await listLanes(ctx.db, team.id, team.slug, { states: [...WATCHED_STATES] })
  ).filter((l) => l.owner_seat && l.branch);
  if (lanes.length === 0) return 0;
  const prs = await listPrsByBranch(run);
  if (!(prs instanceof Map)) {
    const last = await ctx.db.get<{ ts: number }>(
      `SELECT MAX(ts) AS ts FROM audit WHERE team_id = ? AND action = 'pr_watch.unavailable'`,
      [team.id],
    );
    if (!last?.ts || now - last.ts >= PR_WATCH_UNAVAILABLE_EVERY_MS) {
      await appendAudit(ctx.db, team.id, {
        actor: null,
        action: 'pr_watch.unavailable',
        target: null,
        result: 'deny',
        detail: { reason: prs.unknown },
      });
    }
    return 0;
  }
  const voice = await boardSeat(ctx.db, team);
  if (!voice) return 0;
  let sent = 0;
  for (const lane of lanes) {
    const pr = prs.get(lane.branch!);
    if (!pr) continue;
    const state = prEventFor(pr, await toldStates(ctx, team.id, lane.id, pr.number));
    if (!state) continue;
    const owner = await getMemberByName(ctx.db, team.id, lane.owner_seat!);
    if (!owner || owner.left_at !== null) continue;
    const said =
      state === 'merged'
        ? `PR #${pr.number} for your lane "${lane.title}" merged. Submit the lane (lane_submit) if you haven't.`
        : state === 'ci_red'
          ? `PR #${pr.number} for your lane "${lane.title}" is red. Look at the failing check.`
          : `PR #${pr.number} for your lane "${lane.title}" is green again.`;
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: owner.name },
        act: 'message',
        body: `[pr] ${said}`,
        meta: {
          pr_event: {
            lane: lane.id,
            pr: pr.number,
            state,
            ...(pr.url ? { checks_url: pr.url } : {}),
          },
        },
        ts: now,
      }),
      undefined,
      true,
    );
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'pr_event.sent',
      target: lane.id,
      result: 'allow',
      detail: { pr: pr.number, state, seat: owner.name },
    });
    sent += 1;
  }
  return sent;
}

/** Every team this daemon is the hub for — a joiner leaves its teams to the hub's own watch. */
export async function sweepPrWatch(
  ctx: Ctx,
  now: number = Date.now(),
  run: GhRunner = runGh,
): Promise<number> {
  let sent = 0;
  for (const team of await listActiveTeams(ctx.db)) {
    if (await joinerEnrollment(ctx.db, team.id, team.slug)) continue;
    const row = await getTeamById(ctx.db, team.id);
    if (!row) continue;
    try {
      sent += await sweepTeamPrs(ctx, row, now, run);
    } catch (err) {
      log.warn({ msg: 'pr_watch_sweep_failed', team: team.slug, err: String(err) });
    }
  }
  return sent;
}

export function startPrWatch(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepPrWatch(ctx);
    } catch (err) {
      log.warn({ msg: 'pr_watch_failed', err: String(err) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), PR_WATCH_SWEEP_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
