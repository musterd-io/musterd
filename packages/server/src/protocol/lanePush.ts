import { type LanePushReport, makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { boardSeat } from '../store/boardSeat.js';
import { recordLanePush, watchersOfLane } from '../store/handover.js';
import { listLanes } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { routeEnvelope } from './route.js';

/**
 * ADR 730: a push is an event. The PostToolUse hook reports a `git push` once git's remote-tracking
 * ref says the branch is at HEAD on the remote (`POST /teams/:slug/lanes/push`, as the pushing seat).
 * The daemon finds the seat's contending lane(s) on that branch — the branch ADR 697 taught the lane
 * from its gated edits — records the pushed head on the ADR 697 row, and sends one directed act from
 * the board seat (ADR 649) to every seat with an open ADR 724 watch on the lane, once per head. The
 * watch stays open: the file is still held, and the freed act follows when the lane ends. `until_lane`
 * does not wake on it (ADR 730 §4).
 */

const CONTENDING = ['claimed', 'active', 'blocked'] as const;

function quoted(paths: string[]): string {
  return paths.map((p) => `'${p}'`).join(', ');
}

export interface PushOutcome {
  /** Lanes of the seat on that branch the push was recorded on. */
  lanes: number;
  /** Directed acts sent (one per watching seat and lane, new heads only). */
  acts: number;
}

export async function recordPush(
  ctx: Ctx,
  team: TeamRow,
  member: MemberRow,
  report: LanePushReport,
  now = Date.now(),
): Promise<PushOutcome> {
  const lanes = (
    await listLanes(ctx.db, team.id, team.slug, { owner: member.name, states: [...CONTENDING] })
  ).filter((l) => l.branch === report.branch);
  if (lanes.length === 0) {
    log.info({
      msg: 'lane_push_ignored',
      team: team.slug,
      seat: member.name,
      branch: report.branch,
    });
    return { lanes: 0, acts: 0 };
  }
  let acts = 0;
  for (const lane of lanes) {
    const { previous_head } = await recordLanePush(
      ctx.db,
      team.id,
      lane.id,
      report.remote,
      report.head,
      now,
    );
    const watchers = await watchersOfLane(ctx.db, team.id, lane.id);
    log.info({
      msg: 'lane_push_recorded',
      team: team.slug,
      lane: lane.id,
      remote: report.remote,
      head: report.head,
      watchers: watchers.length,
      repeat: previous_head === report.head,
    });
    if (previous_head === report.head) continue;
    const bySeat = new Map<string, string[]>();
    for (const w of watchers) bySeat.set(w.seat, [...(bySeat.get(w.seat) ?? []), w.path]);
    for (const [seat, paths] of bySeat) {
      const voice = await boardSeat(ctx.db, team);
      const to = await getMemberByName(ctx.db, team.id, seat);
      if (!voice || !to) continue;
      const head = report.head.slice(0, 12);
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
          body:
            `[lane] ${member.name} pushed "${lane.title}": ${report.branch} at ${head} on ${report.remote} — ` +
            `fetch it before you edit; ${quoted(paths)} ${paths.length === 1 ? 'is' : 'are'} still held.`,
          meta: {
            lane_pushed: {
              lane: lane.id,
              holder: member.name,
              branch: report.branch,
              head: report.head,
              remote: report.remote,
              paths,
            },
          },
        }),
        undefined,
        true,
      );
      log.info({ msg: 'lane_push_fired', team: team.slug, seat, lane: lane.id });
      acts += 1;
    }
  }
  return { lanes: lanes.length, acts };
}
