import {
  type Lane,
  type LanePushOutcome,
  type LanePushReport,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { boardSeat } from '../store/boardSeat.js';
import { recordLanePush, watchersOfLane } from '../store/handover.js';
import {
  isNamedFile,
  laneHoldingFile,
  listLanes,
  pathGlobMatches,
  projectsContend,
} from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { routeEnvelope } from './route.js';

/**
 * ADR 730: a push is an event. The PostToolUse hook reports a `git push` once git's remote-tracking
 * ref says the branch is at HEAD on the remote (`POST /teams/:slug/lanes/push`, as the pushing seat).
 * The daemon finds the seat's contending lane(s) on that branch — the branch ADR 697 taught the lane
 * from its gated edits — records the pushed head on the ADR 697 row, and sends one directed act from
 * the board seat (ADR 649), once per head, to every seat in the lane's audience. `until_lane` does not
 * wake on it (ADR 730 §4).
 *
 * ADR 731: the audience is every seat with an open ADR 724 watch on the lane (ADR 730 §3) AND every
 * other seat owning a contending lane in the same project whose scope covers a file this lane names —
 * the relation the gate itself refuses on (ADR 150 covering, ADR 691 holds), so it exists before any
 * refusal and survives the lane freeing. On finding 026's run the watch set was empty for 16 of 20
 * pushes; the covering set was not. The response names the seats told, so the hook can tell the pusher.
 */

const CONTENDING = ['claimed', 'active', 'blocked'] as const;

function quoted(paths: string[]): string {
  return paths.map((p) => `'${p}'`).join(', ');
}

export type PushOutcome = LanePushOutcome;

/**
 * ADR 731 §1: the seats whose contending lane covers a file the pushing lane names, with those files.
 * Same project only, never the pusher, never an unowned lane. The pushing lane must NAME the file: an
 * area glob says "I work around here", not "this file is mine", and would widen the audience to the
 * glob-overlap set ADR 575 measured at 27% precision.
 */
export async function coveringSeats(
  db: Driver,
  team: TeamRow,
  lane: Lane,
): Promise<Map<string, string[]>> {
  const named = lane.scope.filter(isNamedFile);
  const out = new Map<string, string[]>();
  if (named.length === 0) return out;
  const others = (await listLanes(db, team.id, team.slug, { states: [...CONTENDING] })).filter(
    (o) =>
      o.id !== lane.id &&
      o.owner_seat !== null &&
      o.owner_seat !== lane.owner_seat &&
      projectsContend(lane.project, o.project),
  );
  for (const other of others) {
    const seat = other.owner_seat!;
    for (const file of named) {
      if (!other.scope.some((g) => pathGlobMatches(g, file))) continue;
      const paths = out.get(seat) ?? [];
      if (!paths.includes(file)) paths.push(file);
      out.set(seat, paths);
    }
  }
  return out;
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
    return { lanes: 0, acts: 0, told: [] };
  }
  let acts = 0;
  const told = new Set<string>();
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
    const covering = await coveringSeats(ctx.db, team, lane);
    log.info({
      msg: 'lane_push_recorded',
      team: team.slug,
      lane: lane.id,
      remote: report.remote,
      head: report.head,
      watchers: watchers.length,
      covering: covering.size,
      repeat: previous_head === report.head,
    });
    if (previous_head === report.head) continue;
    const bySeat = new Map<string, string[]>();
    for (const w of watchers) bySeat.set(w.seat, [...(bySeat.get(w.seat) ?? []), w.path]);
    for (const [seat, paths] of covering) {
      const have = bySeat.get(seat) ?? [];
      bySeat.set(seat, [...have, ...paths.filter((p) => !have.includes(p))]);
    }
    for (const [seat, paths] of bySeat) bySeat.set(seat, [...paths].sort());
    // ADR 691: of the files named, the ones this lane still holds — the body says so, because the
    // receiver may fetch now but may not edit those yet.
    const held: string[] = [];
    for (const path of new Set([...bySeat.values()].flat())) {
      if ((await laneHoldingFile(ctx.db, team.id, team.slug, path, lane.project))?.id === lane.id)
        held.push(path);
    }
    for (const [seat, paths] of bySeat) {
      const voice = await boardSeat(ctx.db, team);
      const to = await getMemberByName(ctx.db, team.id, seat);
      if (!voice || !to) continue;
      const head = report.head.slice(0, 12);
      const heldHere = paths.filter((p) => held.includes(p));
      const tail =
        heldHere.length > 0
          ? `fetch it before you edit; ${quoted(heldHere)} ${heldHere.length === 1 ? 'is' : 'are'} still held.`
          : `fetch it before you edit ${quoted(paths)}.`;
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
          body: `[lane] ${member.name} pushed "${lane.title}": ${report.branch} at ${head} on ${report.remote} — ${tail}`,
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
      told.add(seat);
    }
  }
  return { lanes: lanes.length, acts, told: [...told].sort() };
}
