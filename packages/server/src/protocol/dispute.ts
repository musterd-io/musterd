/**
 * Disputes on the route (ADR 505) — the daemon's half of "a critique is answered with a check".
 *
 * Two edges, both on `routeEnvelope`:
 *
 * 1. {@link stampDispute} — before persist. The act that OPENS a dispute gets `meta.dispute`
 *    (server-controlled, like `lane_review`): a reviewer's `decline` on a standing `lane_review`
 *    ask is `via: 'review'`; a directed `challenge` is `via: 'challenge'`, or `via: 'dependency'`
 *    when the sender owns a live lane that builds on one the recipient owns. The stamp is what
 *    every reader derives from — the pinned-inbox SELECT, the MCP pin predicate, the brief, the
 *    readout — so there is no dispute table and nothing to drift.
 *
 * 2. {@link applyDisputeAnswer} — after persist. The lane owner's reply to a review dispute:
 *    `accept` concedes (recorded; the lane stays `active` for the fix and the resubmit), `decline`
 *    holds — the lane re-enters acceptance and the disagreement goes to a SECOND reviewer, picked
 *    by the same counterpart ladder as any acceptance with the first reviewer excluded (so
 *    cross-family wins when one is live, ADR 314), on the existing re-route rail: a
 *    `lane.review_rerouted` row with `route: 'tiebreak'` supersedes the original ask, and the new
 *    ask carries `lane_review.tiebreak` naming the rejection, the hold and the first reviewer. The
 *    second reviewer's verdict then closes through `applyAcceptanceVerdict` untouched.
 *
 * Deliberately narrow, because this mutates state from a message path (the `applyAcceptanceVerdict`
 * argument): only the lane's OWNER answers a dispute; only a lane still `active` after the
 * rejection is moved; a stale or duplicate answer binds to nothing and the ack says so by its
 * absence.
 */
import {
  type AcceptedHandoffWire,
  type AskTier,
  type DisputeAnswerWire,
  type Envelope,
  LANE_TERMINAL_STATES,
  disputeOf,
  isAwaitingAcceptance,
  tiebreakNotice,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit, appendLaneEventRequired, laneOwnerHistory } from '../store/audit.js';
import { LaneConflictError, getLane, listLanes, updateLane } from '../store/lanes.js';
import { getMemberById } from '../store/members.js';
import { selectReviewCounterpart, supersededAcceptanceAsks } from '../store/review.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { acceptanceTimeoutMs } from '../store/teams.js';
import {
  acceptanceAskBody,
  deliverLaneAskAct,
  followsUpNotice,
  noGoalNotice,
  priorOwnerNotice,
} from './laneReroute.js';

interface ParentRow {
  act: string;
  meta: string | null;
  from_member: string;
  thread_id: string | null;
}

async function parentOf(ctx: Ctx, teamId: string, id: string): Promise<ParentRow | undefined> {
  return await ctx.db.get<ParentRow>(
    'SELECT act, meta, from_member, thread_id FROM messages WHERE team_id = ? AND id = ?',
    [teamId, id],
  );
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Stamp `meta.dispute` on an act that opens one (ADR 505 §2). Returns the envelope unchanged when
 * it opens nothing. Pure read: nothing here writes, so a stamp can never fail a send.
 */
export async function stampDispute(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
): Promise<Envelope> {
  if (env.to.kind !== 'member') return env;
  const withStamp = (dispute: Record<string, unknown>): Envelope => ({
    ...env,
    meta: { ...(env.meta ?? {}), dispute },
  });

  if (env.act === 'challenge') {
    // `dependency`: the sender owns a live lane whose `depends_on` names a lane the recipient
    // owns — they are building on the claim they are now contesting. Derived from the board,
    // never declared (a declared `via` would be a client stamping its own obligation class).
    const all = await listLanes(ctx.db, team.id, team.slug);
    const byId = new Map(all.map((l) => [l.id, l]));
    for (const mine of all) {
      if (mine.owner_seat !== sender.name || LANE_TERMINAL_STATES.has(mine.state)) continue;
      for (const dep of mine.depends_on) {
        const on = byId.get(dep);
        if (on && on.owner_seat === env.to.name) {
          return withStamp({ via: 'dependency', lane: mine.id, on: on.id });
        }
      }
    }
    return withStamp({ via: 'challenge' });
  }

  if (env.act === 'decline') {
    const ref = env.meta?.['in_reply_to'];
    if (typeof ref !== 'string') return env;
    const parent = await parentOf(ctx, team.id, ref);
    if (!parent || parent.act !== 'ask') return env;
    const laneId = (parseMeta(parent.meta) as { lane_review?: { lane?: unknown } }).lane_review
      ?.lane;
    if (typeof laneId !== 'string') return env;
    // Mirror `applyAcceptanceVerdict`'s guard exactly: the decline is a REJECTION only if it is
    // the verdict on the standing ask of a lane still in acceptance, from someone other than the
    // owner. A decline on a superseded ask, or on a lane already moved, moves nothing and so opens
    // nothing — stamping it would pin an obligation on the owner for a verdict that never bound.
    const lane = await getLane(ctx.db, team.id, laneId, team.slug);
    if (!lane || !isAwaitingAcceptance(lane.state) || lane.owner_seat === sender.name) return env;
    if ((await supersededAcceptanceAsks(ctx.db, team.id, laneId)).has(ref)) return env;
    return withStamp({ via: 'review', lane: laneId, ask: ref });
  }

  return env;
}

/**
 * ADR 505 §6 — an `accept` that answered a `handoff` act: hand the receiver the note they just
 * took on, where they took it. The note is the sender's claim about the work; the ack puts the
 * "re-run it before you build on it" line beside it. Read-only.
 */
export async function acceptedHandoffOf(
  ctx: Ctx,
  team: TeamRow,
  accepter: MemberRow,
  repliedToId: string,
): Promise<AcceptedHandoffWire | undefined> {
  const parent = await ctx.db.get<{
    act: string;
    body: string;
    meta: string | null;
    to_member: string | null;
  }>('SELECT act, body, meta, to_member FROM messages WHERE team_id = ? AND id = ?', [
    team.id,
    repliedToId,
  ]);
  // Only the handoff's addressee gets the note back. An accept is a reply anyone may send on any
  // id; without this check a seat could read a directed handoff it was never sent by "accepting"
  // it (security review, 2026-10-05).
  if (!parent || parent.act !== 'handoff' || parent.to_member !== accepter.id) return;
  const lh = (parseMeta(parent.meta) as { lane_handoff?: { lane?: unknown; branch?: unknown } })
    .lane_handoff;
  return {
    ...(typeof lh?.lane === 'string' ? { lane: lh.lane } : {}),
    ...(typeof lh?.branch === 'string' || lh?.branch === null ? { branch: lh.branch } : {}),
    note: parent.body,
  };
}

/**
 * The lane owner's answer to a review dispute (ADR 505 §3–§4). Returns what the daemon did, for
 * the send ack — or `undefined` when the reply answered no dispute of this owner's, so a plain
 * `accept`/`decline` on anything else is exactly what it always was.
 */
export async function applyDisputeAnswer(
  ctx: Ctx,
  team: TeamRow,
  owner: MemberRow,
  repliedToId: string,
  act: 'accept' | 'decline',
  answerId: string,
): Promise<DisputeAnswerWire | undefined> {
  const parent = await parentOf(ctx, team.id, repliedToId);
  if (!parent || parent.act !== 'decline') return;
  const stamp = disputeOf(parseMeta(parent.meta));
  if (!stamp || stamp.via !== 'review' || !stamp.lane) return;
  const lane = await getLane(ctx.db, team.id, stamp.lane, team.slug);
  // Owner-only, and only while the rejection is the lane's latest state. A lane already back in
  // acceptance (a second answer, or a resubmit in between) is not moved again.
  if (!lane || lane.owner_seat !== owner.name || lane.state !== 'active') return;
  const reviewerRow = await getMemberById(ctx.db, parent.from_member);
  const reviewer = reviewerRow?.name ?? 'unknown';

  const answered = async (verdict: 'conceded' | 'held', extra: Record<string, unknown> = {}) =>
    await appendAudit(ctx.db, team.id, {
      actor: owner.name,
      action: 'lane.dispute_answered',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        owner: owner.name,
        verdict,
        dispute: repliedToId,
        answer: answerId,
        reviewer,
        ...extra,
      },
    });

  if (act === 'accept') {
    await answered('conceded');
    return { lane: lane.id, verdict: 'conceded' };
  }

  // A hold. Pick the tiebreak the way any acceptance is picked, with the first reviewer out of
  // the pool — `departing` is the ladder's one exclusion hook, and "not this seat" is what it
  // means here too. Cross-family ranks first on the ladder, so when one is live it is the pick.
  const { pick } = await selectReviewCounterpart(
    ctx.db,
    team.id,
    lane,
    owner.name,
    ctx.config.presenceTimeoutMs,
    { departing: reviewer },
  );
  if (!pick || pick.reviewer === reviewer || pick.reviewer === owner.name) {
    await answered('held', { tiebreak: null });
    return { lane: lane.id, verdict: 'held', tiebreak: null };
  }

  let moved;
  try {
    moved = await updateLane(
      ctx.db,
      team.id,
      lane.id,
      team.slug,
      { state: 'awaiting_acceptance' },
      Date.now(),
      { state: lane.state, owner_seat: lane.owner_seat },
      { actor: owner.name },
    );
  } catch (err) {
    if (err instanceof LaneConflictError) {
      log.info({ msg: 'dispute_hold_already_moved', lane: lane.id, owner: owner.name });
      return;
    }
    throw err;
  }
  if (!moved) return;

  await answered('held', { tiebreak: pick.reviewer });
  const acceptanceTier: AskTier = 'standard';
  const acceptanceWaitMs = await acceptanceTimeoutMs(ctx.db, team.id, acceptanceTier);
  // The re-route row is what supersedes the first ask (`supersededAcceptanceAsks` reads it), so a
  // late verdict on it binds to nothing — the same rail the departed-reviewer path rides.
  await appendLaneEventRequired(ctx.db, team.id, {
    actor: owner.name,
    action: 'lane.review_rerouted',
    target: lane.id,
    result: 'allow',
    detail: {
      lane: lane.id,
      owner: owner.name,
      stakes: lane.stakes,
      stakes_provenance: lane.stakes_provenance,
      ...(lane.merged ? { merged: lane.merged } : {}),
      reviewer: pick.reviewer,
      route: 'tiebreak',
      review_grade: pick.grade,
      from_reviewer: reviewer,
      ...(stamp.ask ? { superseded_ask: stamp.ask } : {}),
      dispute: repliedToId,
      hold: answerId,
      human_required: lane.risk.length > 0,
      ask_tier: acceptanceTier,
      ask_timeout_ms: acceptanceWaitMs,
    },
  });
  const priorOwners = await laneOwnerHistory(ctx.db, team.id, lane.id);
  await deliverLaneAskAct(
    ctx,
    team,
    owner,
    pick.reviewer,
    acceptanceAskBody(lane.title, {
      change: lane.merged,
      overlapNotice: priorOwnerNotice(pick.reviewer, priorOwners),
      noGoalNotice: noGoalNotice(lane.goal_id),
      followsUpNotice: await followsUpNotice(ctx.db, team.id, lane),
    }) + tiebreakNotice(reviewer, owner.name),
    {
      species: 'approve',
      tier: acceptanceTier,
      lane_review: {
        lane: lane.id,
        wait_ms: acceptanceWaitMs, // ADR 506: the promise, carried where /live can read it
        title: lane.title,
        branch: lane.branch,
        ...(lane.merged ? { merged: lane.merged } : {}),
        route: 'tiebreak',
        grade: pick.grade,
        tiebreak: { rejection: repliedToId, hold: answerId, first_reviewer: reviewer },
      },
    },
    // In the dispute's own thread, so the second reviewer's `ids` read shows the rejection and the
    // hold beside the ask that tells them to judge between the two.
    parent.thread_id ?? repliedToId,
  );
  return {
    lane: lane.id,
    verdict: 'held',
    tiebreak: { reviewer: pick.reviewer, grade: pick.grade },
  };
}
