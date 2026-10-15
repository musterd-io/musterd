import {
  ACCEPTANCE_MOVES_NOTICE,
  type AskTier,
  changeLabelText,
  type Lane,
  leftoverSignal,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { appendLaneEventRequired, laneOwnerHistory } from '../store/audit.js';
import { getLane, listLanes } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import {
  type HeldAcceptance,
  abandonedAcceptances,
  REROUTE_HOP_CAP,
  automaticRerouteHops,
  heldAcceptances,
  openAcceptanceAsk,
  pickHumanReviewer,
  selectReviewCounterpart,
} from '../store/review.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { acceptanceTimeoutMs, getTeamBySlug } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
import { routeEnvelope } from './route.js';

/**
 * What the sweep needs of a team: its id and its slug, nothing else. Narrower than the full roster
 * row on purpose — the reaper's `listActiveTeams` hands out exactly this pair.
 */
type TeamRef = { id: string; slug: string };

/**
 * Re-routing an acceptance away from a reviewer who is no longer there.
 *
 * Two triggers, one implementation. ADR 412 handles the explicit goodbye — a seat posting
 * `/residency/session {event:'end'}` hands back everything it holds. Lane
 * 01M2RQ8W0RR838P2KW3SP6SYGV handles the silent one — a reaped seat says nothing at all, so the
 * reaper notices on its behalf. What differs is only how the departure became known, which is why
 * the caller supplies both the seat and the acceptances rather than this module inferring them.
 *
 * The ask-composition and delivery helpers live here rather than in the HTTP transport because
 * the reaper needs them too, and `presence/` must not reach up into `transport/`.
 */

export function acceptanceAskBody(
  title: string,
  opts: {
    human?: boolean;
    peerFindings?: string;
    overlapNotice?: string;
    noGoalNotice?: string;
    followsUpNotice?: string;
    /** ADR 612: the lane's merge attestation; its change class opens the ask when present. */
    change?: Lane['merged'] | undefined;
  } = {},
): string {
  const checklist =
    'Judge the LANDED OUTCOME (not a code review): ' +
    '(1) Intent — matches the lane brief? ' +
    '(2) Principles — project/musterd hard rules? ' +
    '(3) Usable — exercise the path enough to say it works? ' +
    '(4) Feel — only if UI/copy/brand is in surface, else N/A. ' +
    'Accept → move the lane to done; reject → send it back to active with a concrete note.' +
    // Lane 01M2P2E2H6: the acceptor learns what `accept` DOES before they send one, not from the
    // ack afterwards. Appended to the checklist so both the peer and human bodies below carry it.
    ACCEPTANCE_MOVES_NOTICE;
  const overlap =
    (opts.followsUpNotice ?? '') + (opts.overlapNotice ?? '') + (opts.noGoalNotice ?? '');
  if (opts.human && opts.peerFindings !== undefined) {
    return (
      `[lane] human acceptance required: "${title}" — peer accepted with: "${opts.peerFindings}". ` +
      checklist +
      overlap
    );
  }
  const kind = opts.change ? changeLabelText(opts.change) : null;
  return `[lane] acceptance requested${kind ? ` (${kind})` : ''}: "${title}" — ${checklist}${overlap}`;
}

/**
 * The overlap line (ADR 192, lane 01KYX6QY5N). The picker excludes the lane's CURRENT owner and
 * nobody else, so a lane that changed hands can route its acceptance to a previous owner — an
 * author of the very artifact being judged. Rather than exclude them (which would narrow a pool
 * that already finds nobody on most attempts, to close a hole seen on 3 lanes ever), the ask NAMES
 * the overlap and leaves the call to the acceptor: recusal is a judgment, not a computation.
 *
 * Phrased as a fact plus the two honest options, never as an accusation — the acceptor may well be
 * the right judge (ADR 192 acceptance is intent-vs-brief, and a brief's author knows the brief).
 */
export function priorOwnerNotice(reviewer: string, priorOwners: string[]): string {
  return priorOwners.includes(reviewer)
    ? ' NOTE — you previously owned this lane, so you are named on the artifact you are judging. ' +
        'That is allowed and may even make you the best judge of intent, but it is yours to weigh: ' +
        'accept if you can judge it independently, or decline and say "recusing — I authored this" ' +
        'so it routes to someone else.'
    : '';
}

/**
 * What the worker said is left (ADR 487 §5.1), so the acceptor judges the plan's shape along with
 * the outcome: each named lane with its state (and a drop's reason), or an explicit `none` when the
 * lane declared itself one part of several. Silent otherwise — a one-shot lane has nothing to show.
 */
export async function followsUpNotice(db: Driver, teamId: string, lane: Lane): Promise<string> {
  const todos = lane.unfinished_todos?.items ?? [];
  const left = todos.length
    ? ` Unfinished to-dos at submit: ${todos.slice(0, 5).join('; ')}${todos.length > 5 ? `; +${todos.length - 5} more` : ''}.`
    : '';
  return (await followsUpAnswer(db, teamId, lane)) + left;
}

async function followsUpAnswer(db: Driver, teamId: string, lane: Lane): Promise<string> {
  const answer = lane.follows_up ?? null;
  if (answer === null) return '';
  if (answer === 'none')
    return leftoverSignal(lane) !== null
      ? ' Follows up: none — the worker says nothing is left of this part.'
      : '';
  const parts: string[] = [];
  for (const id of answer) {
    const next = await getLane(db, teamId, id, lane.team);
    if (!next) parts.push(`${id} (gone)`);
    else if (next.state === 'abandoned')
      parts.push(`${id} dropped — ${next.abandon_reason ?? 'no reason'}`);
    else parts.push(`${id} [${next.state}] "${next.title}"`);
  }
  return ` Follows up: ${parts.join('; ')}.`;
}

export function noGoalNotice(goalId: string | null): string {
  if (goalId !== null) return '';
  return ' This lane is on no goal — if it advanced one, link it (lane_update {goal_id}) before resolving.';
}

/**
 * Outcome-acceptance ask (ADR 192): a directed `ask` act from the worker to the picked acceptor —
 * unlike {@link deliverLaneAct} this is act `ask`, so it rides the whole ask-stream machinery
 * (tier contract, reachability, ask-span telemetry) with no new act kind. Best-effort like every
 * lane delivery: a failed compose never fails the verb (the degradation path is self-close anyway).
 */
export async function deliverLaneAskAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  body: string,
  meta: Record<string, unknown>,
  /** ADR 505: a tiebreak ask joins the dispute's thread; every other acceptance ask roots its own. */
  thread?: string,
): Promise<boolean> {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act: 'ask',
      body,
      meta,
      ...(thread ? { thread } : {}),
    });
    await routeEnvelope(ctx, team, from, env, undefined, true);
    return true;
  } catch {
    /* advisory only — the lane verb already succeeded. The boolean is for the one caller that
       must NOT treat it as advisory: a hand-named acceptor whose ask failed to mint is the silent
       limbo lane 01M1QYHJFY closed, and the submit handler fails loudly on `false`. */
    return false;
  }
}

export async function deliverLaneAskSuperseded(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  askId: string,
  lane: Lane,
  newAcceptor: string,
): Promise<void> {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act: 'resolve',
      thread: askId,
      body:
        `[lane] acceptance of "${lane.title}" re-routed to ${newAcceptor} by ${from.name} — ` +
        `the ask you held is closed and nothing is owed on it. A verdict sent on it now binds to nothing.`,
      meta: { lane_review_superseded: { lane: lane.id, ask: askId, reviewer: newAcceptor } },
    });
    await routeEnvelope(ctx, team, from, env, undefined, true);
  } catch {
    /* advisory — the re-route itself is recorded in the audit and the new ask is what binds */
  }
}

/** How the daemon came to know the reviewer was gone. Recorded on the audit row. */
export type DepartureRoute = 'departed' | 'reaped';

/**
 * ADR 595: what the human reads on a capped acceptance — why it reached them rather than a peer.
 * Names every seat the ask left, so the human can see it was absence, not refusal.
 */
export function rerouteCapNotice(holders: string[]): string {
  return (
    ` NOTE — this acceptance has been held by ${holders.length} seats in turn (${holders.join(' → ')}), ` +
    'each gone before judging it, so it comes to you instead of another agent. ' +
    'Your accept or decline closes the question; it will not be moved again while you are away.'
  );
}

/**
 * Re-route one seat's held acceptances to freshly picked reviewers.
 *
 * Reuses the hand re-route's machinery exactly (`lane.review_rerouted` + a superseded notice + a
 * fresh ask), because the hard part is already decided there: the old ask goes inert, a late
 * verdict on it cannot move the lane, and the seat that held it is told where the acceptance went.
 * Only the trigger is new, so the audit row records `route` and the gone seat as `actor`.
 *
 * No wake is leased, matching the named path: the ask waits in an inbox, as it does at submit.
 * If the picker finds nobody, nothing is minted and the lane keeps the ask it has — a re-route with
 * no destination would strand the acceptance worse than leaving it for `staleAcceptanceWarning`.
 *
 * ADR 595: once a submission has been re-routed {@link REROUTE_HOP_CAP} times this way, the next
 * move goes to a live human (`route: 'capped'`, graded `human`), never a further agent. With no
 * human live it moves nowhere, and the sweep tries again next tick — the first human to come live
 * gets it. The capped ask is graded `human`, so {@link isHumanStageAsk} keeps it with them.
 */
export async function rerouteAcceptances(
  ctx: Ctx,
  team: TeamRow,
  gone: MemberRow,
  held: HeldAcceptance[],
  route: DepartureRoute,
): Promise<string[]> {
  const out: string[] = [];
  for (const one of held) {
    const lane = await getLane(ctx.db, team.id, one.lane, team.slug);
    if (!lane) continue;
    // Lane 01M4V6ACBP: the stage-two human ask is not a peer review, so there is no one to move it
    // to — the picker only offers agents. Re-routing it handed a fresh PEER ask to an agent, whose
    // accept fired the human ask again, and the reaper moved that one too (lane 01M4SPZB1V,
    // 2026-10-13: miley → nick → sloane → dreamy → nick). A human being offline is the normal case,
    // not an abandonment; the ask waits for them.
    if (await isHumanStageAsk(ctx.db, team.id, one.ask)) continue;
    const worker = lane.owner_seat ?? gone.name;
    const { hops, holders } = await automaticRerouteHops(ctx.db, team.id, lane.id);
    const capped = hops >= REROUTE_HOP_CAP;
    const pick = capped
      ? await pickHumanReviewer(ctx.db, team.id, worker, ctx.config.presenceTimeoutMs)
      : (
          await selectReviewCounterpart(
            ctx.db,
            team.id,
            lane,
            worker,
            ctx.config.presenceTimeoutMs,
            {
              departing: gone.name,
            },
          )
        ).pick;
    if (!pick || pick.reviewer === gone.name) continue;
    const moveRoute = capped ? 'capped' : route;
    const humanRequired = lane.risk.length > 0;
    const acceptanceTier: AskTier = 'standard';
    const acceptanceWaitMs = await acceptanceTimeoutMs(ctx.db, team.id, acceptanceTier);
    await appendLaneEventRequired(ctx.db, team.id, {
      actor: gone.name,
      action: 'lane.review_rerouted',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        owner: worker,
        stakes: lane.stakes,
        stakes_provenance: lane.stakes_provenance,
        ...(lane.merged ? { merged: lane.merged } : {}),
        reviewer: pick.reviewer,
        route: moveRoute,
        review_grade: pick.grade,
        from_reviewer: gone.name,
        superseded_ask: one.ask,
        human_required: humanRequired,
        ask_tier: acceptanceTier,
        ask_timeout_ms: acceptanceWaitMs,
        ...(capped ? { hops, holders: [...holders, gone.name] } : {}),
      },
    });
    await deliverLaneAskSuperseded(ctx, team, gone, gone.name, one.ask, lane, pick.reviewer);
    const priorOwners = await laneOwnerHistory(ctx.db, team.id, lane.id);
    await deliverLaneAskAct(
      ctx,
      team,
      gone,
      pick.reviewer,
      acceptanceAskBody(lane.title, {
        change: lane.merged,
        overlapNotice: priorOwnerNotice(pick.reviewer, priorOwners),
        noGoalNotice: noGoalNotice(lane.goal_id),
        followsUpNotice: await followsUpNotice(ctx.db, team.id, lane),
      }) + (capped ? rerouteCapNotice([...holders, gone.name]) : ''),
      {
        species: 'approve',
        tier: acceptanceTier,
        lane_review: {
          lane: lane.id,
          wait_ms: acceptanceWaitMs, // ADR 506: the promise, carried where /live can read it
          title: lane.title,
          branch: lane.branch,
          ...(lane.merged ? { merged: lane.merged } : {}),
          route: moveRoute,
          grade: pick.grade,
        },
      },
    );
    out.push(lane.id);
  }
  return out;
}

/**
 * The ask is graded `human` — ADR 172's stage-two acceptance, or an ADR 595 capped one — not a peer
 * ask. Either way the human is waited on, never replaced by an agent.
 */
async function isHumanStageAsk(db: Driver, teamId: string, askId: string): Promise<boolean> {
  const row = await db.get<{ grade: string | null }>(
    `SELECT json_extract(meta, '$.lane_review.grade') AS grade FROM messages WHERE team_id = ? AND id = ?`,
    [teamId, askId],
  );
  return row?.grade === 'human';
}

/** ADR 412's trigger: the seat said goodbye, so it is gone whatever its presence row still says. */
export async function rerouteDepartedAcceptances(
  ctx: Ctx,
  team: TeamRow,
  departing: MemberRow,
): Promise<string[]> {
  return await rerouteAcceptances(
    ctx,
    team,
    departing,
    await heldAcceptances(ctx.db, team.id, departing.name),
    'departed',
  );
}

/**
 * Lane 01M2RQ8W0RR838P2KW3SP6SYGV — the silent departure, swept from the reaper's tick.
 *
 * A reaped seat emits `presence.detached` with reason 'reaped' and no `residency.session_ended`, so
 * ADR 412's trigger never fires for it. Here the departure has to be inferred, which is what
 * `abandonedAcceptances` does — and it infers it with `hasLivePresence`, the same predicate the
 * picker excludes candidates by, so a seat this sweeps is a seat the picker would not have picked.
 *
 * Deliberately NOT gated behind a `loops.*` policy flag, unlike ADR 229's sweep. That gate guards a
 * DESTRUCTIVE act — closing a lane as `done` with no verdict. This one never closes a lane and never
 * invents a verdict; the worst it can do is move an ask to a seat that is actually there, which is
 * the same operation ADR 412 already performs ungated on the goodbye path.
 *
 * It terminates on its own rather than by a counter: once re-routed, the lane's open ask belongs to
 * a LIVE seat, so the next tick's `abandonedAcceptances` no longer names it. A lane only comes back
 * if its new reviewer also vanishes, which is the case where trying again is the right answer.
 *
 * `watchedSince` / `now` are {@link reapStale}'s listening window, and for its reason: a heartbeat
 * is only evidence over time something was listening. Without it this sweep judged silence on the
 * first tick after every host suspend — the holder's row stale by the clock alone, while whichever
 * seat's heartbeat landed first looked live and got the ask. Lane 01M49JNJG3's acceptance moved 37
 * times overnight on 2026-10-06/07, every move within 5 s of a `residency.host_suspended` row, and
 * no seat ever held it long enough to judge it (lane 01M4BJX7JJ).
 */
export async function sweepReapedAcceptances(
  ctx: Ctx,
  ref: TeamRef,
  watchedSince = 0,
  now = Date.now(),
): Promise<string[]> {
  if (now - watchedSince < ctx.config.presenceTimeoutMs) return [];
  // `routeEnvelope` needs the full roster row; the reaper only has id+slug, so resolve once here
  // rather than making every caller carry a row it does not have.
  const team = await getTeamBySlug(ctx.db, ref.slug);
  if (!team) return [];
  // An enrolled JOINER never judges a departure (the ADR 371 §2 rule `handleBlockedReport` follows).
  // Absence here means only "not resident on this machine": a fresh joiner mid-drain saw every
  // reviewer as gone, re-routed their acceptances AS them, and the hub refused the batch
  // `bound_elsewhere` — wedging the machine's every later push (second-machine run, 2026-10-02).
  // Presence replicates to the hub, and the hub's own reaper re-routes.
  if (await joinerEnrollment(ctx.db, team.id, team.slug)) return [];
  const out: string[] = [];
  const holders = new Set<string>();
  for (const lane of await listLanes(ctx.db, team.id, team.slug, {
    states: ['awaiting_acceptance'],
  })) {
    const open = await openAcceptanceAsk(ctx.db, team.id, lane.id);
    if (open) holders.add(open.to);
  }
  for (const name of holders) {
    const gone = await getMemberByName(ctx.db, team.id, name);
    if (!gone) continue;
    const stranded = await abandonedAcceptances(
      ctx.db,
      team.id,
      name,
      ctx.config.presenceTimeoutMs,
    );
    if (stranded.length === 0) continue;
    out.push(...(await rerouteAcceptances(ctx, team, gone, stranded, 'reaped')));
  }
  return out;
}
