import {
  LANE_CONTENDING_STATES,
  type Lane,
  type LanePushOutcome,
  type LanePushReport,
  type LaneState,
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
import { getPolicy } from '../store/teams.js';
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
 *
 * ADR 732: the covering set also holds the owner of a lane that covered the file and LEFT the
 * contending states within the team's `push_audience_ended_lane_window_ms` — on finding 027's run all
 * 10 silent pushes came minutes after the partner's lane had ended, and that partner merged the
 * branch. The contending states are the protocol's (ADR 731 read a narrower local list, so a partner
 * awaiting acceptance heard nothing). And the act carries what the push changed — the commit subjects
 * and files the hook read off git — so the receiver needs no hand-sent "here is what I did".
 */

/** The pusher's own lane is found among the lanes being worked (ADR 730 §2), as before. */
const CONTENDING = ['claimed', 'active', 'blocked'] as const;
/** Every state ADR 732 reads as "not ended" for the audience: the protocol's contending set. */
const AUDIENCE_LIVE: LaneState[] = [...LANE_CONTENDING_STATES];
const ENDED: LaneState[] = ['done', 'abandoned', 'parked', 'open'];

function quoted(paths: string[]): string {
  return paths.map((p) => `'${p}'`).join(', ');
}

export type PushOutcome = LanePushOutcome;

/** When a lane left the contending states: its close, else its last change (parked, released). */
function endedAt(lane: Lane): number {
  return lane.resolved_at ?? lane.updated_at;
}

/**
 * ADR 731 §1: the seats whose contending lane covers a file the pushing lane names, with those files.
 * Same project only, never the pusher, never an unowned lane. The pushing lane must NAME the file: an
 * area glob says "I work around here", not "this file is mine", and would widen the audience to the
 * glob-overlap set ADR 575 measured at 27% precision.
 *
 * ADR 732 §1: a lane that covered the file and ended within `windowMs` of `now` still counts, if it
 * still has an owner on record. A released lane has `owner_seat` null, so its owner on record is the
 * `owner_before` of its latest `lane.released` audit row inside the window (ADR 732 amended
 * 2026-10-26; finding 028: 2 of 22 pushes went unheard for exactly this). `ended` reports how many of
 * the seats came in only that way, for the log.
 */
export async function coveringSeats(
  db: Driver,
  team: TeamRow,
  lane: Lane,
  windowMs = 0,
  now = Date.now(),
): Promise<{ seats: Map<string, string[]>; ended: number }> {
  const named = lane.scope.filter(isNamedFile);
  const seats = new Map<string, string[]>();
  if (named.length === 0) return { seats, ended: 0 };
  // The owner on record: the lane's owner, or — for a lane released inside the window — the seat the
  // release took it from. Filled only for recent ended lanes with no owner.
  const releasedOwner = new Map<string, string>();
  const ownerOf = (o: Lane): string | null => o.owner_seat ?? releasedOwner.get(o.id) ?? null;
  const eligible = (o: Lane) => {
    const owner = ownerOf(o);
    return (
      o.id !== lane.id &&
      owner !== null &&
      owner !== lane.owner_seat &&
      projectsContend(lane.project, o.project)
    );
  };
  const live = (await listLanes(db, team.id, team.slug, { states: AUDIENCE_LIVE })).filter(
    eligible,
  );
  let recent: Lane[] = [];
  if (windowMs > 0) {
    const endedRecently = (await listLanes(db, team.id, team.slug, { states: ENDED })).filter(
      (o) => o.id !== lane.id && endedAt(o) >= now - windowMs,
    );
    for (const o of endedRecently) {
      if (o.owner_seat !== null) continue;
      const row = await db.get<{ detail: string | null }>(
        `SELECT detail FROM audit
           WHERE team_id = ? AND action = 'lane.released' AND target = ? AND ts >= ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
        [team.id, o.id, now - windowMs],
      );
      const before = row?.detail
        ? (JSON.parse(row.detail) as { owner_before?: unknown }).owner_before
        : undefined;
      if (typeof before === 'string' && before.length > 0) releasedOwner.set(o.id, before);
    }
    recent = endedRecently.filter(eligible);
  }
  const add = (others: Lane[]) => {
    const seen = new Set<string>();
    for (const other of others) {
      const seat = ownerOf(other)!;
      for (const file of named) {
        if (!other.scope.some((g) => pathGlobMatches(g, file))) continue;
        const paths = seats.get(seat) ?? [];
        if (!paths.includes(file)) paths.push(file);
        seats.set(seat, paths);
        seen.add(seat);
      }
    }
    return seen;
  };
  const liveSeats = add(live);
  const recentSeats = add(recent);
  const ended = [...recentSeats].filter((s) => !liveSeats.has(s)).length;
  return { seats, ended };
}

/** ADR 732 §2: the one sentence of what changed, from the hook's report — or nothing. */
export function changedClause(report: LanePushReport): string {
  const subjects = report.subjects ?? [];
  const files = report.files ?? [];
  if (subjects.length === 0 && files.length === 0) return '';
  const what = subjects.length > 0 ? subjects.join('; ') : 'changes';
  const where = files.length > 0 ? ` (files: ${files.join(', ')})` : '';
  return ` — ${what}${where}`;
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
  const { push_audience_ended_lane_window_ms: windowMs } = await getPolicy(ctx.db, team.id);
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
    const { seats: covering, ended } = await coveringSeats(ctx.db, team, lane, windowMs, now);
    log.info({
      msg: 'lane_push_recorded',
      team: team.slug,
      lane: lane.id,
      remote: report.remote,
      head: report.head,
      watchers: watchers.length,
      covering: covering.size,
      ended,
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
          body: `[lane] ${member.name} pushed "${lane.title}": ${report.branch} at ${head} on ${report.remote}${changedClause(report)} — ${tail}`,
          meta: {
            lane_pushed: {
              lane: lane.id,
              holder: member.name,
              branch: report.branch,
              head: report.head,
              remote: report.remote,
              paths,
              ...(report.subjects ? { subjects: report.subjects } : {}),
              ...(report.files ? { files: report.files } : {}),
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
