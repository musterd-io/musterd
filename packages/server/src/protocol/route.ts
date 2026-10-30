import {
  LaneClaimsSchema,
  summariseClaims,
  blockedByOf,
  DeferUntilSchema,
  eligibleOf,
  type AcceptedHandoffWire,
  type DisputeAnswerWire,
  type Envelope,
  ACCEPTANCE_MOVES_NOTICE,
  answerAuthority,
  changeLabelText,
  classifyAskAction,
  humanReviewRequired,
  isAwaitingAcceptance,
  type Lane,
  type LaneAdvisoryWire,
  type LaneSupersededWire,
  type LaneUnboundWire,
  makeEnvelope,
  modelFamily,
  confidentialAskSubject,
  describeHoldLine,
  SetHoldBodySchema,
  TALK_ONLY_REPLY_ACTS,
  TALK_ONLY_SEND_ACTS,
  ApprovalProofSchema,
} from '@musterd/protocol';
import { humanAskAnswerApproval } from '@musterd/protocol/approval';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { deliverAskToAppChannels, tickVerdictQueue } from '../notify/appAdapter.js';
import { ringDoorbell } from '../notify/doorbell.js';
import { deliverAskToSlackChannels } from '../notify/slackAdapter.js';
import { appendAudit, appendReplicatedEvent } from '../store/audit.js';
import { requireAuthority } from '../store/authority.js';
import { boardSeat } from '../store/boardSeat.js';
import { dreamMayWrite, isDreaming } from '../store/dream.js';
import { holdExpiry, holdForProposal, setHold } from '../store/holds.js';
import { incidentReporters, recordBlockedReport } from '../store/incidents.js';
import { recordLaneClose } from '../store/laneClose.js';
import {
  decideReadVerdict,
  deriveHandoffLane,
  getLane,
  type HandoffLaneBasis,
  updateLane,
  LaneConflictError,
} from '../store/lanes.js';
import { getMemberByName, getMemberById } from '../store/members.js';
import { getMessageTs, insertMessage, rowToEnvelope } from '../store/messages.js';
import { seatBindings } from '../store/nodes.js';
import { answerPolicyReview } from '../store/policyReview.js';
import { currentAttestation, liveDeafReason } from '../store/presence.js';
import {
  bindingAskSql,
  isAdvisoryReviewMeta,
  openAcceptanceAsk,
  humanReviewerFor,
  pendingHumanReviews,
  pickHumanReviewer,
  supersededAcceptanceAsks,
} from '../store/review.js';
import type { MemberRow, MessageRow, TeamRow } from '../store/rows.js';
import { resolveAccountStatus, resolveCapabilities } from '../store/rows.js';
import { acceptanceTimeoutMs, getTeamBySlug } from '../store/teams.js';
import { holdAtHub, joinerEnrollment } from '../sync/claim.js';
import { kickSyncPush } from '../sync/push.js';
import {
  recordActModel,
  recordDeliveryOutcome,
  recordLoopClosure,
  recordTokenUsage,
  withEnvelopeSpan,
} from '../telemetry.js';
import { acceptedHandoffOf, applyDisputeAnswer, stampDispute } from './dispute.js';
import { prepareQuestionAnswer, stripAnswerProof } from './questionAnswer.js';

export interface RouteResult {
  message: MessageRow;
  recipients: string[]; // member ids the message is addressed to
  delivered: number; // live deliveries pushed
  /** ADR 231 — what happened to a lane-less `handoff`'s lane: the one the daemon attached, or the
   *  warning that the sender holds several and the daemon would not guess. Absent for every other
   *  act, and for a handoff whose sender holds no live lane (the legal lane-less case). */
  handoff_lane?: { lane: string; branch: string | null; source: 'derived' } | { warning: string };
  /** ADR 202 — the lane this accept/decline MOVED, when it answered a `lane_review` ask: `done` on
   *  an accept, `active` on a decline. Absent when the act moved nothing (a plain answer, an
   *  escalation to the human stage, a superseded ask). Reported on the ack so the sender learns
   *  they gave a verdict at the moment they gave it (lane 01M2GQFJXG, 2026-09-14: a reviewer sent
   *  `accept` as "taking this review" and found out afterwards that the lane was already closed). */
  lane_verdict?: { lane: string; state: 'done' | 'active' };
  /** Lane 01M5DTPMXN — a human's verdict on a `lane_review` ask was refused by the ADR 662
   * authority gate (no A2 signature, or a bad one): the act landed as a message and moved
   * nothing. Absent for every other act. Reported on the ack for the same reason
   * `lane_verdict` is — before this, the refusal existed only in the audit and a log line,
   * and the sender's surface marked the ask answered. */
  lane_authority_refused?: { lane: string; reason: string };
  /** Lane 01M5Z3NAJE — an agent's verdict on a `lane_review` ask that the lane's own close rules
   *  refused (ADR 644: a lane that reads on a day closes `done` only with a read verdict): the act
   *  landed, the lane did not move, and the ask stays open. `guidance` says why and what unblocks
   *  it. Before this the refusal was a `warn` in daemon.log and the ack read like a verdict that had
   *  landed — two accepts on lane 01M5X44XXE (2026-10-26/27) each left the acceptor believing the
   *  lane was closed. */
  lane_verdict_refused?: { lane: string; reason: string; guidance: string };
  /** ADR 539 — this accept was the PEER confirmation on a risky lane (ADR 188 §4) and moved nothing:
   *  `human` is who was asked for the human verdict, null when nobody live could be (the reaper
   *  retries when a human comes live) or when this daemon is a joiner and the hub decides on fold.
   *  Reported on the ack for the same reason `lane_verdict` is — the acceptor must learn on the
   *  spot that their accept did not close the lane and why (nameplates lane, 2026-10-06). */
  lane_escalation?: { lane: string; human: string | null };
  /** Lane 01M2P2E2H6 — the acceptance ask this `wait` TOOK without deciding. Absent for every other
   *  act, and for a `wait` that answered anything but a live `lane_review` ask. Reported on the ack
   *  for the same reason `lane_verdict` is: the sender learns what their send did, as they do it —
   *  here, that it did NOT move the lane. */
  lane_ack?: { lane: string };
  /** ADR 545 — this accept/decline/wait answered an acceptance ask a re-route had already closed:
   *  it moved nothing, escalated nothing, and the ack says which ask (and whose) binds now. */
  lane_superseded?: LaneSupersededWire;
  /** ADR 667 — the reply answered an ADVISORY acceptance ask: recorded against the lane, moved
   *  nothing. Reported on the ack so the advisory seat learns its verdict did not close the lane. */
  lane_advisory?: LaneAdvisoryWire;
  /** ADR 680 — the reply answered an acceptance ask on a lane that had LEFT the acceptance stage:
   *  it bound to nothing (ADR 202 — one verdict closes a lane), and the ack says so and names the
   *  lane's state. Reported for the same reason `lane_verdict` is: the sender must learn on the
   *  spot that their verdict did not move the lane, and why. */
  lane_unbound?: LaneUnboundWire;
  /** ADR 505 — what the daemon did with the lane owner's answer to a review dispute: a recorded
   *  concession, or a hold that re-routed the lane to a tiebreak reviewer (or could not). Absent
   *  when the act answered no dispute of the sender's. Reported on the ack as `lane_verdict` is. */
  dispute?: DisputeAnswerWire;
  /** ADR 505 §6 — this `accept` answered a `handoff`: the note the receiver just took on, returned
   *  where they accepted so the "re-run it before you build on it" line sits beside it. */
  accepted_handoff?: AcceptedHandoffWire;
  /** ADR 558 §5 (increment 5) — a directed recipient that is currently live and deaf: the sender's
   *  ack says it lands at its next tool call or prompt. */
  deaf_recipient?: { recipient: string; reason: string | null };
}

/**
 * ADR 516 increment 3: turn an accepted hold proposal into a hold. Only a HUMAN ADMIN's accept counts
 * (the human-only gate-ask rule, plus ADR 516's admin requirement — never `applyAcceptanceVerdict`'s
 * any-sender read); an agent's accept, a decline, or silence activates nothing. The hold is the
 * accepting human's (`created_by`), the proposer is recorded beside it, one proposal yields one hold,
 * and the Team hears about it once — the same announcement a hold set directly gets.
 */
async function activateHoldProposal(
  ctx: Ctx,
  team: TeamRow,
  decider: MemberRow,
  askId: string,
): Promise<void> {
  if (decider.kind !== 'human' || !resolveCapabilities(decider).is_admin) return;
  const ask = await ctx.db.get<MessageRow>(
    "SELECT * FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'",
    [team.id, askId],
  );
  if (!ask) return;
  const meta = JSON.parse(ask.meta ?? '{}') as { hold_proposal?: unknown };
  const proposal = SetHoldBodySchema.safeParse(meta.hold_proposal);
  if (!proposal.success) return;
  if (await holdForProposal(ctx.db, team.id, askId)) return;
  const proposer = (await getMemberById(ctx.db, ask.from_member))?.name ?? null;
  const provenance = { proposal_ask: askId, proposed_by: proposer };
  const enrollment = await joinerEnrollment(ctx.db, team.id, team.slug);
  const hold = enrollment
    ? await holdAtHub(enrollment, team.slug, {
        op: 'set',
        actor: decider.name,
        hold: proposal.data,
        provenance,
      })
    : await setHold(ctx.db, team.id, decider.name, proposal.data, Date.now(), provenance);
  const now = Date.now();
  await routeEnvelope(
    ctx,
    team,
    decider,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: decider.name,
      to: { kind: 'team' },
      act: 'message',
      body: `[hold] ${describeHoldLine(hold, now)}${proposer ? ` — proposed by ${proposer}` : ''}`,
      meta: { hold: { id: hold.id, effect: hold.effect, expires_at: hold.expires_at } },
      ts: now,
    }),
    undefined,
    true,
  );
}

async function answerPolicyReviewAct(
  ctx: Ctx,
  team: TeamRow,
  decider: MemberRow,
  askId: string,
  act: 'accept' | 'decline',
): Promise<void> {
  const answer = await answerPolicyReview(ctx.db, team, decider, askId, act);
  if (!answer) return;
  const now = Date.now();
  await routeEnvelope(
    ctx,
    team,
    decider,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: decider.name,
      to: { kind: 'team' },
      act: 'message',
      body:
        answer.verdict === 'confirmed'
          ? `[policy] re-confirmed by ${decider.name} — next review ${new Date(answer.review_by!).toISOString().slice(0, 10)}`
          : `[policy] dropped by ${decider.name} — every knob is back at its default`,
      meta: { policy_review_answer: { ask: askId, verdict: answer.verdict } },
      ts: now,
    }),
    undefined,
    true,
  );
}

/**
 * The single validate→persist→deliver path shared by WS `send` and HTTP POST messages.
 * The envelope must already be schema-valid; this enforces identity + resolves/persists/delivers.
 */
/** ADR 601: both ends human and neither an observer seat. Service seats count as agents. */
function isHumanPair(a: MemberRow, b: MemberRow): boolean {
  return a.kind === 'human' && a.observer === 0 && b.kind === 'human' && b.observer === 0;
}

/**
 * A joiner's daemon pushes every event it mints to the hub, and the hub refuses one voiced as a seat
 * bound to ANOTHER node (`bound_elsewhere`, ADR 328 §4). The cursor only moves past an acked batch,
 * so that one event blocks everything the machine writes after it (wedged twice on 2026-10-17: a
 * dispatch nudge voiced as `alfie`, who lives on the hub). A daemon-composed act is the only way a
 * daemon speaks as a seat without that seat's own session on this node, so the refusal sits here,
 * on the one path they all take, instead of in each composer. The composers are best-effort and
 * already swallow it; a hub, an unenrolled daemon, an unbound seat and a seat bound here are
 * untouched.
 */
async function refuseVoiceBoundElsewhere(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
): Promise<void> {
  const joiner = await joinerEnrollment(ctx.db, team.id, team.slug);
  if (!joiner) return;
  const bound = await seatBindings(ctx.db, sender.id);
  if (bound.length === 0 || bound.some((b) => b.node_id === joiner.node_id)) return;
  throw new MusterdError(
    'bound_elsewhere',
    `"${sender.name}" is bound to another machine (${bound.map((b) => b.label).join(', ')}), so ` +
      `this node cannot voice an act as that seat — the hub would refuse the push and wedge ` +
      `this machine's sync`,
  );
}

/**
 * True when `meta.in_reply_to` names a pull announcement ask that `memberId` sent. The only
 * reason a departed host seat is still a legal addressee (lane 01M5G34H).
 */
async function replyNamesPullAskFrom(
  db: Ctx['db'],
  teamId: string,
  meta: Record<string, unknown> | null | undefined,
  memberId: string,
): Promise<boolean> {
  const id = typeof meta?.['in_reply_to'] === 'string' ? meta['in_reply_to'] : null;
  if (!id) return false;
  const row = await db.get<{ n: number }>(
    `SELECT 1 AS n FROM messages
       WHERE team_id = ? AND id = ? AND from_member = ? AND act = 'ask'
         AND json_extract(meta, '$.pull.lane') IS NOT NULL`,
    [teamId, id, memberId],
  );
  return row != null;
}

export async function routeEnvelope(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
  /** The sending connection's presence/occupancy id (ADR 101) — so the per-act model stamp reads
   *  *this* session's attestation, not the member's newest presence. Omitted on the stateless HTTP
   *  message paths (no live occupancy), which fall back to the member's freshest attested presence. */
  senderPresenceId?: string,
  /** ADR 225: the envelope was composed by the daemon, not received from a client, so its
   *  server-controlled meta (`lane_review`) is authentic and survives. **Defaults to false so the
   *  strip fails closed** — a new client-facing route that forgets this cannot mint interrupts, and a
   *  daemon route that forgets it merely loses the interrupt (visible in tests, not exploitable). */
  daemonComposed = false,
  /** The WS connection the act arrived on, if any — it gets the `ack`, so the firehose skips it and
   *  only it. An HTTP send has none, and every firehose connection of the sender gets the act. */
  senderConnId?: string,
  /** A forwarded authority-bearing answer is checked against the origin configured for this
   *  enrolled node and must consume a descriptor issued to the same node. */
  forwardedNodeId?: string,
  /** The surface a stateless send names (`x-musterd-surface`; `/live` says `web`) — the channel
   *  label on a question's answer (ADR 773 §5). A live socket's own presence surface wins. */
  senderSurface?: string,
): Promise<RouteResult> {
  if (daemonComposed) await refuseVoiceBoundElsewhere(ctx, team, sender);
  return withEnvelopeSpan(
    env,
    async () =>
      await routeEnvelopeInner(
        ctx,
        team,
        sender,
        env,
        senderPresenceId,
        daemonComposed,
        senderConnId,
        forwardedNodeId,
        senderSurface,
      ),
  );
}

async function routeEnvelopeInner(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
  senderPresenceId?: string,
  daemonComposed = false,
  senderConnId?: string,
  forwardedNodeId?: string,
  senderSurface?: string,
): Promise<RouteResult> {
  // ADR 231: a `handoff` that names no lane. Only `lane_handoff` ever wrote
  // `meta.lane_handoff.lane`, so a plain `team_send {act:'handoff'}` hands over work without saying
  // WHICH work — and the orientation `why`, which reads a handoff as a live instruction, then has
  // nothing to check it against and serves stale ones forever (24 of the first 30 handoffs on the
  // dogfood team named no lane). Derived HERE, on the one validate→persist→deliver path, so WS and
  // HTTP and every client above them get it from one implementation. Explicit meta always wins.
  let handoffLane: RouteResult['handoff_lane'];
  let laneVerdict: RouteResult['lane_verdict'];
  let laneAuthorityRefused: RouteResult['lane_authority_refused'];
  let laneVerdictRefused: RouteResult['lane_verdict_refused'];
  let laneEscalation: RouteResult['lane_escalation'];
  let laneAck: RouteResult['lane_ack'];
  let laneSuperseded: RouteResult['lane_superseded'];
  let laneAdvisory: RouteResult['lane_advisory'];
  let laneUnbound: RouteResult['lane_unbound'];
  let dispute: RouteResult['dispute'];
  let acceptedHandoff: RouteResult['accepted_handoff'];
  let deafRecipient: RouteResult['deaf_recipient'];
  let verifiedPrivilegedAskReply = false;
  /** ADR 243: which evidence answered — audited, never on the wire. */
  let handoffBasis: HandoffLaneBasis | undefined;
  if (env.act === 'handoff' && !(env.meta as { lane_handoff?: unknown } | null)?.lane_handoff) {
    // ADR 243: the recipient is evidence. A handoff act directed at a seat, moments after a lane
    // was transferred to that seat, has a referent that "a lane the sender holds" cannot see — and
    // the held set is exactly where the intended lane is NOT, because lane_handoff already moved it.
    const derived = await deriveHandoffLane(
      ctx.db,
      team.id,
      team.slug,
      sender.name,
      env.to.kind === 'member' ? env.to.name : undefined,
    );
    if (derived.kind === 'attach') {
      handoffLane = { lane: derived.lane.id, branch: derived.lane.branch, source: 'derived' };
      env = {
        ...env,
        meta: {
          ...(env.meta ?? {}),
          lane_handoff: { lane: derived.lane.id, branch: derived.lane.branch },
        },
      };
    } else if (derived.kind === 'ambiguous') {
      // Warn, never refuse. The un-threaded `accept` (mcp/tools/send.ts) DOES refuse to guess,
      // because guessing there writes a verdict onto the wrong lane and cannot be recovered. Here,
      // declining to attach leaves the message exactly as it is today — unjudgeable, but never
      // wrong. A message is worth more than a derived field.
      // ADR 243: say which set was ambiguous. "you hold N" is false when the candidates are lanes
      // the sender GAVE AWAY — a warning that misdescribes its own evidence sends the reader
      // looking at the wrong lanes.
      const situation =
        derived.basis === 'handed_to_recipient'
          ? `you handed ${derived.candidates.length} lanes to this seat`
          : `you hold ${derived.candidates.length}`;
      handoffLane = {
        warning:
          `handoff names no lane and ${situation} — the orientation ` +
          '`why` cannot tell the recipient which work this is. Use lane_handoff (its `note` ' +
          'carries the why on the same act), or pass meta.lane_handoff.lane: ' +
          derived.candidates.map((l) => `${l.id} "${l.title}"`).join(', '),
      };
    }
    handoffBasis = derived.kind === 'none' ? undefined : derived.basis;
  }

  if (env.from !== sender.name || env.team !== team.slug) {
    throw new MusterdError('forbidden', 'envelope from/team must match the authenticated member');
  }
  // ADR 327: an insight's finding text is capped at 2048 bytes — server-enforced here on the one
  // validate→persist→deliver path, like seat memory's blob cap (ADR 093), because actMetaRules
  // sees only {act, thread, meta}, never the body. The floor below (lane 01M50C7QWJ): empty rows
  // passed every layer until 2026-10-15 (docs/wiki/dream-empty-insight-bodies.md) — an insight
  // with no finding is noise the dreams then carry night after night.
  if (env.act === 'insight' && Buffer.byteLength(env.body, 'utf8') > 2048) {
    throw new MusterdError('validation', 'act "insight" body is limited to 2048 bytes');
  }
  if (env.act === 'insight' && env.body.trim().length === 0) {
    throw new MusterdError('validation', 'act "insight" body must not be empty');
  }
  // ADR 516 increment 3: a hold proposal is checked when it is SENT, so the proposer learns now that
  // a 20h freeze or an effect outside the list will never activate — not when a human accepts it.
  if (env.meta && 'hold_proposal' in env.meta) {
    if (env.act !== 'ask')
      throw new MusterdError('validation', 'meta.hold_proposal rides an `ask` (species approve)');
    const proposal = SetHoldBodySchema.safeParse(env.meta['hold_proposal']);
    if (!proposal.success)
      throw new MusterdError(
        'validation',
        'meta.hold_proposal must be {effect: autorefresh_paused|merges_paused|notice, reason, until | for_ms}',
      );
    holdExpiry(proposal.data, Date.now());
  }
  // Observer seats (ADR 063) are read-only — they watch the firehose but cannot speak.
  if (sender.observer) {
    throw new MusterdError('forbidden', 'observer seats are read-only and cannot send');
  }
  // ADR 494 / goal dreaming: a seat woken to dream sends insights and nothing else — no ask, no
  // handoff, no message that could wake a teammate or ring a human at night.
  if (await isDreaming(ctx.db, sender.id)) {
    const verdict = dreamMayWrite(sender.name, { kind: 'act', act: env.act });
    if (!verdict.ok) {
      await appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'send.denied',
        target: env.to.kind === 'member' ? env.to.name : null,
        result: 'deny',
        detail: { provenance: 'dream', act: env.act },
      });
      throw new MusterdError('forbidden', verdict.reason);
    }
  }

  // ADR 211 §1: only the RECIPIENT of an act may defer it. The fold already ignores other people's
  // waits, so a stray deferral could never suppress anyone else's inbox — but "only the recipient"
  // is a stated boundary, and a boundary that is merely inert is not enforced. An unauthorized
  // target is indistinguishable from a missing one (ADR 209 §4): same error either way, so the
  // response never discloses that some other seat's act exists.
  if (env.act === 'wait') {
    const deferRef = (env.meta as { defer_ref?: unknown } | null | undefined)?.defer_ref;
    if (typeof deferRef === 'string' && deferRef.length > 0) {
      const target = await ctx.db.get<{ to_kind: string; to_member: string | null }>(
        'SELECT to_kind, to_member FROM messages WHERE team_id = ? AND id = ?',
        [team.id, deferRef],
      );
      const deliveredToSender =
        target &&
        (target.to_member === sender.id ||
          target.to_kind === 'team' ||
          target.to_kind === 'broadcast');
      if (!deliveredToSender) {
        throw new MusterdError('forbidden', 'cannot defer an act that was not delivered to you');
      }
    }
  }

  // v0.3 P2 send gates (ADR 071) on the existing token auth. The sender's effective capabilities +
  // resolved account status are projected onto the row by reconcile (ADR 070); the generalist default
  // (active, can_message:team, can_flag_urgent:true) passes everything, so an un-governed team is
  // unaffected.
  const caps = resolveCapabilities(sender);
  const status = resolveAccountStatus(sender);
  const target = env.to.kind === 'member' ? env.to.name : null;

  // account_status: a disabled/banned/archived seat cannot send (provisioned/active send normally).
  if (status === 'disabled' || status === 'banned' || status === 'archived') {
    await appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'send.denied',
      target,
      result: 'deny',
      detail: { account_status: status },
    });
    throw new MusterdError('forbidden', `seat "${sender.name}" is ${status} and cannot send`);
  }

  // can_message: a muted seat (`none`) cannot address the team.
  if (caps.can_message === 'none') {
    await appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'send.denied',
      target,
      result: 'deny',
      detail: { can_message: 'none' },
    });
    throw new MusterdError('forbidden', `seat "${sender.name}" is muted (can_message: none)`);
  }

  // can_coordinate (ADR 621 §2): a talk-only seat — a guest — sends the four talk acts to anyone,
  // and accept/decline/wait/resolve only as a reply to an act addressed to it. Everything else
  // (handoff, steer, challenge, defer, insight, …) is coordination and refused, audited like a mute.
  if (!caps.can_coordinate) {
    const meta = (env.meta ?? {}) as Record<string, unknown>;
    let refusal: string | null = null;
    if (TALK_ONLY_REPLY_ACTS.has(env.act)) {
      // EVERY reference the act carries must point at an act addressed to this seat, and there must
      // be at least one. Checking "any" would let a guest aim `in_reply_to` at someone else's
      // acceptance ask while `thread` names its own conversation.
      const refs = [meta['in_reply_to'], meta['defer_ref'], env.thread].filter(
        (r): r is string => typeof r === 'string' && r.length > 0,
      );
      let ok = refs.length > 0;
      for (const ref of refs) {
        const row = await ctx.db.get<{ to_member: string | null }>(
          'SELECT to_member FROM messages WHERE team_id = ? AND id = ?',
          [team.id, ref],
        );
        if (row?.to_member !== sender.id) {
          ok = false;
          break;
        }
      }
      if (!ok) refusal = `talk-only seat: ${env.act} is only a reply to an act addressed to you`;
    } else if (!TALK_ONLY_SEND_ACTS.has(env.act)) {
      refusal = `talk-only seat: cannot send ${env.act}`;
    } else if ('hold_proposal' in meta) {
      // A hold proposal rides an `ask` and a human admin's accept turns it into a team-wide hold:
      // proposing one is coordination, so a guest's ask may not carry it.
      refusal = 'talk-only seat: an ask cannot carry meta.hold_proposal';
    }
    if (refusal) {
      await appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'send.denied',
        target,
        result: 'deny',
        detail: { can_coordinate: false, act: env.act },
      });
      throw new MusterdError('forbidden', refusal);
    }
  }

  // can_flag_urgent: the urgency breakthrough (ADR 044) is the scarce, auditable flag. A seat without
  // the capability is **downgraded, not rejected** (the message still lands, just not as a breakthrough):
  // strip `urgent`, mark `wasnt_urgent` so the recipient + firehose see the denied attempt, keep the
  // reason for context. An allowed urgent is audited too (the flag is meant to be legible).
  let outgoingEnv = env;
  if (env.meta?.['urgent'] === true) {
    const rawReason = env.meta['urgent_reason'];
    const detail = typeof rawReason === 'string' ? { reason: rawReason } : {};
    if (caps.can_flag_urgent) {
      await appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'urgent.flagged',
        target,
        result: 'allow',
        detail,
      });
    } else {
      const { urgent: _urgent, ...restMeta } = env.meta;
      outgoingEnv = { ...env, meta: { ...restMeta, wasnt_urgent: true } };
      await appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'urgent.denied',
        target,
        result: 'deny',
        detail,
      });
    }
  }

  // ADR 225: `lane_review` is **server-controlled**, on the same grounds as `meta.model` below. The
  // daemon sets it on the review route, and ADR 225 makes it obligation-class in `pendingInterrupts`
  // — so a client-supplied copy would be a free interrupt, routing around the scarce, audited
  // `can_flag_urgent` gate (ADR 071) that every other non-`steer` raise must pass. Stripped silently
  // rather than rejected: the act still lands, it just cannot promote itself to the interrupt line.
  if (!daemonComposed && outgoingEnv.meta && 'lane_review' in outgoingEnv.meta) {
    const { lane_review: _clientLaneReview, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 505: `dispute` is server-controlled on the same grounds — the stamp is what makes a
  // reviewer's `decline` an obligation on the lane's owner (pinned, briefed), so a client copy
  // would be a seat minting an obligation on a teammate. Stripped, then stamped below.
  if (!daemonComposed && outgoingEnv.meta && 'dispute' in outgoingEnv.meta) {
    const { dispute: _clientDispute, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 271 §4 (built): `incident` is the daemon's own marker on the route/resolve notices, and
  // under `incident.wake_on_route` / `wake_on_resolve` it is a PAID wake reason — so a client copy
  // would be a seat minting itself a wake. Same strip, same silence: the message still lands.
  if (!daemonComposed && outgoingEnv.meta && 'incident' in outgoingEnv.meta) {
    const { incident: _clientIncident, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 516: `hold` marks the daemon's own announcement that a human set or lifted a Team hold. A
  // client copy would be a seat announcing a rule nobody set — the exact rumour holds exist to end —
  // so it is stripped like the markers above; the message still lands, as plain prose.
  if (!daemonComposed && outgoingEnv.meta && 'hold' in outgoingEnv.meta) {
    const { hold: _clientHold, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 533: `policy_review` marks the daemon's own ask that the policy doc is due a look. A client
  // copy would let a seat forge an ask whose `accept` rewrites team policy, so it is stripped too.
  if (!daemonComposed && outgoingEnv.meta && 'policy_review' in outgoingEnv.meta) {
    const { policy_review: _clientReview, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }

  // ADR 623 §2: `channel_answer` marks an answer that came through a channel. It is server-controlled:
  // a client copy would let a seat dress a reply as a channel answer (or, by omission, hide one), so it
  // is stripped from any envelope the daemon did not compose.
  if (!daemonComposed && outgoingEnv.meta && 'channel_answer' in outgoingEnv.meta) {
    const { channel_answer: _clientChannelAnswer, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 773 §5: `answer_proof` says how a question's answer was verified — server-controlled.
  outgoingEnv = stripAnswerProof(outgoingEnv, daemonComposed);
  // ADR 662: a human answer to a privileged ask is accepted only after the same A2 gate used by
  // lane verdicts. This stamp is server-owned; persistent consumers use it to distinguish answers
  // checked by this route from older bearer-only rows that must no longer release work.
  if (!daemonComposed && outgoingEnv.meta && 'human_authority_checked' in outgoingEnv.meta) {
    const { human_authority_checked: _clientChecked, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  // ADR 623 §3-§4: one door for every consumer that treats a human `accept` or `decline` as authority
  // (acceptance, hold proposals, policy review, handoff accept). A channel answer is recorded as a
  // `message`, never as one of these, so a daemon-composed accept/decline that still carries
  // `channel_answer` is a bug in the channel path, and it is refused here, before persist, rather than
  // honoured by whichever consumer reads it first.
  if (
    (outgoingEnv.act === 'accept' || outgoingEnv.act === 'decline') &&
    answerAuthority(null, outgoingEnv.meta) === 'advisory'
  ) {
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'channel.answer.refused',
      target:
        typeof outgoingEnv.meta?.['in_reply_to'] === 'string'
          ? outgoingEnv.meta['in_reply_to']
          : null,
      result: 'deny',
      detail: { reason: 'assurance', act: outgoingEnv.act, from: sender.name },
    });
    throw new MusterdError(
      'forbidden',
      'a channel answer cannot be an accept or decline (ADR 623): it is advice, not authority',
    );
  }
  // ADR 623 §1: `action_class` says what a channel answer (ADR 618) to this ask is worth. It is
  // **server-controlled** and stripped from every envelope, the daemon's own included: a client copy
  // would let an `approve` call itself `advisory`. Every ask is then classified from what the daemon
  // knows (species, `meta.gate`), failing closed to `privileged`. A non-ask act never carries one.
  if (outgoingEnv.meta && 'action_class' in outgoingEnv.meta) {
    const { action_class: _clientActionClass, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  if (outgoingEnv.act === 'ask') {
    outgoingEnv = {
      ...outgoingEnv,
      meta: { ...outgoingEnv.meta, action_class: classifyAskAction(outgoingEnv.meta) },
    };
  }

  // ADR 662 / 694: a human's reply to a privileged ask is a listed human answer. Lane reviews
  // keep their existing post-persist acknowledgement path; other privileged asks (including the
  // ADR 150 gate release) are refused before persistence unless the shared verifier accepts them.
  // The proof is over the stable ask id and chosen verdict, while the ask itself remains visible
  // beside the server-built descriptor on the caller surface.
  if (
    !daemonComposed &&
    sender.kind === 'human' &&
    (outgoingEnv.act === 'accept' || outgoingEnv.act === 'decline')
  ) {
    const replyTo = outgoingEnv.meta?.['in_reply_to'];
    if (typeof replyTo === 'string') {
      const replied = await ctx.db.get<{ id: string; meta: string | null }>(
        `SELECT id, meta FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'`,
        [team.id, replyTo],
      );
      const parsedAskMeta = replied ? safeParse(replied.meta) : null;
      const askMeta =
        typeof parsedAskMeta === 'object' && parsedAskMeta !== null && !Array.isArray(parsedAskMeta)
          ? (parsedAskMeta as Record<string, unknown>)
          : null;
      if (
        replied &&
        classifyAskAction(askMeta) === 'privileged' &&
        !(askMeta && 'lane_review' in askMeta)
      ) {
        const approval = humanAskAnswerApproval(replied.id, outgoingEnv.act);
        const proof = ApprovalProofSchema.safeParse(outgoingEnv.meta?.['approval']);
        const check = await requireAuthority(ctx.db, {
          teamId: team.id,
          audience: team.slug,
          presenter: sender,
          credential: 'human',
          act: approval.act,
          target: approval.target,
          payload: approval.payload,
          proof: proof.success ? proof.data : undefined,
          expectedOrigins: forwardedNodeId
            ? [ctx.config.webauthnNodeOrigins[forwardedNodeId]?.origin].filter(
                (origin): origin is string => typeof origin === 'string',
              )
            : ctx.config.webauthnOrigins,
          ...(forwardedNodeId ? { expectedNodeId: forwardedNodeId } : {}),
        });
        if (!check.ok) {
          throw new MusterdError(
            'forbidden',
            `authority refused (${check.reason}): human answers to privileged asks require an A2 device signature (ADR 662)`,
          );
        }
        outgoingEnv = {
          ...outgoingEnv,
          meta: { ...outgoingEnv.meta, human_authority_checked: true },
        };
        verifiedPrivilegedAskReply = true;
      }
    }
  }

  // Per-act model stamp (ADR 101): the occupancy attestation is the *source*, the stamp on each act
  // is the *dataset*. Model is **entirely server-controlled** — any client-supplied `meta.model` is
  // stripped first (a session can't stamp an act with a model its occupancy didn't attest — the
  // integrity claim the diversity flag rests on), then the sender's current attested occupancy value
  // is stamped when present. Unattested → no stamp at all (reads as `unknown` downstream,
  // warn-never-block). Keyed on the *sending* occupancy (senderPresenceId) so a fanned-out member's
  // two sessions on different models don't cross-attribute (ADR 042 human fan-out).
  // Read as a pair from ONE row: `model_source` says which tier produced `model` — `observed` (a
  // harness probe saw it) vs a declaration. Without it a stamp cannot say whether it is a
  // measurement or an assumption, and an aggregate over both reports a number it cannot support.
  const { model: attestedModel, source: attestedSource } = await currentAttestation(
    ctx.db,
    sender.id,
    senderPresenceId,
  );
  // Both keys are server-controlled and stripped from any client-supplied meta, on the same grounds:
  // a session that could stamp its own tier could launder a declaration into an observation, which
  // is the one substitution this field exists to make impossible.
  if (outgoingEnv.meta && ('model' in outgoingEnv.meta || 'model_source' in outgoingEnv.meta)) {
    const { model: _clientModel, model_source: _clientSource, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  if (attestedModel) {
    outgoingEnv = {
      ...outgoingEnv,
      meta: {
        ...outgoingEnv.meta,
        model: attestedModel,
        // Omitted, never defaulted, when the occupancy does not know its own tier (pre-migration-42
        // row, or a client too old to send one). Absence is not an assertion (ADR 236).
        ...(attestedSource ? { model_source: attestedSource } : {}),
      },
    };
    recordActModel(attestedModel);
  }

  // ADR 254: the roster half of eligible-set validation. `actMetaRules` proved the shape; only the
  // daemon can prove the *names*, and it REJECTS rather than dropping — a question addressed to a
  // seat that cannot answer it is worse than a rejected send, because the sender goes on believing
  // someone owes them a reply. Read off `outgoingEnv` so a meta rewrite above can never desync the
  // set that gets validated from the set that gets persisted.
  const eligible = eligibleOf(outgoingEnv.meta);
  if (eligible) {
    const eligibleMembers: MemberRow[] = [];
    for (const name of eligible) {
      const seat = await getMemberByName(ctx.db, team.id, name);
      if (!seat || seat.left_at !== null) {
        throw new MusterdError('not_found', `no member "${name}" in ${team.slug}`);
      }
      // An observer isn't a participant (ADR 063) — it receives the act via the firehose and can't
      // send, so it could never discharge one. Naming it would strand the act by construction.
      if (seat.observer === 1) {
        throw new MusterdError(
          'validation',
          `seat "${name}" is an observer and cannot owe an answer`,
        );
      }
      if (seat.id === sender.id) {
        throw new MusterdError('validation', `meta.eligible cannot name the sender ("${name}")`);
      }
      eligibleMembers.push(seat);
    }
    // ADR 558 §5 (increment 5): the eligible-set picker prefers a hearing seat over a deaf one at
    // otherwise equal rank — hearing seats are ordered ahead of live-but-deaf seats, preserving the
    // caller's order within each group.
    const deafEligible = new Set<string>();
    for (const seat of eligibleMembers) {
      if (await liveDeafReason(ctx.db, team.id, seat, ctx.config.presenceTimeoutMs)) {
        deafEligible.add(seat.name);
      }
    }
    if (deafEligible.size > 0 && deafEligible.size < eligible.length) {
      const ordered = [
        ...eligible.filter((n) => !deafEligible.has(n)),
        ...eligible.filter((n) => deafEligible.has(n)),
      ];
      outgoingEnv = { ...outgoingEnv, meta: { ...outgoingEnv.meta, eligible: ordered } };
    }
  }

  // Resolve recipients. Deliberately UNCHANGED by the eligible set: an eligible-set act is
  // team-addressed, so every seat still receives the push and sees it in their inbox. Only the
  // ledger (`recipientsOf`) and the obligation predicate (`pendingInterrupts`) narrow — visibility
  // and accountability are separate axes, and only the latter was ever meant to shrink.
  let toMemberId: string | null = null;
  let recipients: string[];
  // ADR 601: a DM between two human, non-observer members is the one act a `broadcast` reader
  // never gets. Computed here from the two rows already in hand; `humanPairSql` is the SQL twin.
  let humanPair = false;
  // Names ride with the ids: live delivery needs each recipient's name, and one lookup per
  // recipient was a team-size N+1 on every send (lane 01M4563RDY, Cloud load run 9).
  const recipientNames = new Map<string, string>();
  if (env.to.kind === 'member') {
    const target = await getMemberByName(ctx.db, team.id, env.to.name);
    // A pull ask's sender is a host service seat, and that seat can leave while the ask is still
    // owed. The opener's accept/decline names the ask; it does not need the host to still be a
    // member (lane 01M5G34H). Any other act to a departed seat is still `no member`.
    const replyToDepartedPull =
      target != null &&
      target.left_at !== null &&
      (env.act === 'accept' || env.act === 'decline') &&
      (await replyNamesPullAskFrom(ctx.db, team.id, env.meta, target.id));
    if (!target || (target.left_at !== null && !replyToDepartedPull)) {
      throw new MusterdError('not_found', `no member "${env.to.name}" in ${team.slug}`);
    }
    toMemberId = target.id;
    recipients = [target.id];
    recipientNames.set(target.id, target.name);
    humanPair = isHumanPair(sender, target);
    const deaf = await liveDeafReason(ctx.db, team.id, target, ctx.config.presenceTimeoutMs);
    if (deaf) deafRecipient = { recipient: target.name, reason: deaf.reason };
  } else {
    // team or broadcast: every participant currently in the team except the sender. Observers (ADR
    // 063) aren't participants — they receive it via the firehose, not as addressed recipients.
    const rows = await ctx.db.all<{ id: string; name: string }>(
      'SELECT id, name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?',
      [team.id, sender.id],
    );
    for (const r of rows) recipientNames.set(r.id, r.name);
    recipients = rows.map((r) => r.id);
  }

  outgoingEnv = await threadReviewPromiseAct(ctx, team, outgoingEnv);
  // ADR 505 §2: the act that opens a dispute carries its source. Before persist, so the stored
  // row and every delivery derived from it agree, and so the pinned SELECT can read it.
  outgoingEnv = await stampDispute(ctx, team, sender, outgoingEnv);
  // ADR 773 §3–§5: a question's answer claims the question (first wins) and is stamped with its
  // proof. Last before persist, so no later refusal can leave a claimed question with no answer row.
  outgoingEnv = await prepareQuestionAnswer(ctx.db, team, sender, outgoingEnv, {
    daemonComposed,
    surface: senderPresenceId
      ? ((
          await ctx.db.get<{ surface: string }>('SELECT surface FROM presence WHERE id = ?', [
            senderPresenceId,
          ])
        )?.surface ?? senderSurface)
      : senderSurface,
  });

  // Persist (append-only log) — the urgent-downgraded envelope when applicable, so the stored meta and
  // every delivery (direct + firehose, all derived from the row) carry the corrected flags.
  const message = await insertMessage(ctx.db, team.id, sender.id, toMemberId, outgoingEnv);
  if (verifiedPrivilegedAskReply && sender.kind === 'human') {
    void tickVerdictQueue(ctx, team, sender, outgoingEnv.ts);
  }

  // Coordination loop latency (ADR 082 slice 3): accept/decline close the directed act they answer
  // (meta.in_reply_to); resolve closes its thread root. Emitted first-party instead of reconstructed
  // (finding 001). Best-effort — an unknown reference just records nothing.
  // Dimension the loop by team + the closer's model family (#207): "how fast does model X close
  // loops" is the per-model leaderboard's headline metric. `attestedModel` is this closer's occupancy
  // model (resolved above); absent → no family label (never guessed).
  const loopDims = {
    team: env.team,
    ...(attestedModel ? { family: modelFamily(attestedModel) } : {}),
  };
  if (env.act === 'accept' || env.act === 'decline') {
    const ref = env.meta?.['in_reply_to'];
    const refTs = typeof ref === 'string' ? await getMessageTs(ctx.db, team.id, ref) : null;
    if (refTs !== null && env.ts >= refTs) recordLoopClosure(env.act, env.ts - refTs, loopDims);
    // ADR 188 stage two: a peer's accept on a risky lane's review ask fires the HUMAN ask, with
    // the peer's findings in the body — the human reviews an already-screened change. Best-effort
    // like every lane delivery: a failure here must never fail the accept itself.
    let escalatedToHuman = false;
    // ADR 545: an answer to an ask a re-route already closed binds to nothing — no verdict AND no
    // stage-two escalation (the escalation hook never asked, so a peer answering a moved ask woke
    // the human for a review nobody held). Checked once, first; the sender is told on the ack.
    // ADR 667: an answer on an ADVISORY ask is recorded and moves nothing — checked before every
    // other branch, so it can never be read as superseded, as the ADR 188 peer stage, as the
    // verdict, or as an owner's dispute answer.
    if (typeof ref === 'string') {
      try {
        laneAdvisory = await recordAdvisoryVerdict(ctx, team, sender, ref, env.act, message.id);
      } catch (err) {
        log.warn({ msg: 'advisory_verdict_failed', err: String(err) });
      }
    }
    if (typeof ref === 'string' && !laneAdvisory) {
      try {
        laneSuperseded = await supersededLaneReview(ctx, team, ref);
      } catch (err) {
        log.warn({ msg: 'superseded_check_failed', err: String(err) });
      }
    }
    // ADR 680: the third way an ask stops binding — the lane left the acceptance stage (closed on a
    // newer PR, sent back, parked, abandoned). The verdict moves nothing, so the daemon says so and
    // writes the row; checked after the two above, which own their own cases.
    if (typeof ref === 'string' && !laneAdvisory && !laneSuperseded) {
      try {
        laneUnbound = await unboundLaneReview(ctx, team, sender, ref, env.act, message.id);
      } catch (err) {
        log.warn({ msg: 'unbound_check_failed', err: String(err) });
      }
    }
    // Hub-only (joiner audit 2026-10-02, lane 01M3ZBTJKD): the ask is composed FROM the lane owner,
    // who may be bound to the hub, and a joiner pushing it wedges. A joiner's accept folds, and the
    // hub fires the ask then (`handleFoldedMessages`).
    // The joiner still owes the gate: a risky lane's peer accept must not close it here as a
    // verdict, so it is treated as escalated and left for the human the hub will ask.
    // ADR 539: either way the sender is told, on the ack, that this was the peer stage and who (if
    // anyone) now holds the verdict — `human: null` on a joiner means "the hub decides on fold".
    // ADR 539: a HUMAN's accept is never the peer stage — on a risky lane it IS the human verdict
    // ADR 188 §4 was waiting for. Gating it would ask the human to confirm their own confirmation
    // (found writing the retry test: boss's accept on the stage-two ask re-escalated to boss).
    if (
      env.act === 'accept' &&
      typeof ref === 'string' &&
      sender.kind !== 'human' &&
      !laneSuperseded &&
      !laneAdvisory &&
      !laneUnbound
    ) {
      try {
        if (await joinerEnrollment(ctx.db, team.id, team.slug)) {
          const gated = await gatedLane(ctx, team, ref);
          if (gated) {
            escalatedToHuman = true;
            laneEscalation = { lane: gated.lane.id, human: null };
          }
        } else {
          const fired = await fireGatedHumanAsk(ctx, team, sender, ref, env.body, message.id);
          if (fired) {
            escalatedToHuman = true;
            laneEscalation = { lane: fired.lane, human: fired.human };
          }
        }
      } catch (err) {
        log.warn({ msg: 'gated_human_ask_failed', err: String(err) });
      }
    }
    // ADR 202: the verdict MOVES the lane it judges. Before this, an accept wrote telemetry and
    // nothing else — the acceptor had to remember a second, separate call to close the lane, and
    // when they didn't (measured: three lanes in one evening) the owner eventually self-closed and
    // the audit recorded `self_close`/unverified for work that had in fact been reviewed. The
    // acceptance record understated itself, silently and in the safe-looking direction.
    // Skipped when the accept just escalated: a risky lane's peer review hands off to the human it
    // demanded, and that human's verdict is the one that closes.
    if ((env.act === 'accept' || env.act === 'decline') && typeof ref === 'string') {
      try {
        if (!escalatedToHuman && !laneSuperseded && !laneAdvisory && !laneUnbound) {
          const applied = await applyAcceptanceVerdict(
            ctx,
            team,
            sender,
            ref,
            env.act,
            env.body,
            env.meta,
            forwardedNodeId,
          );
          laneVerdict = applied.verdict;
          laneAuthorityRefused = applied.authorityRefused;
          laneVerdictRefused = applied.verdictRefused;
        }
      } catch (err) {
        log.warn({ msg: 'acceptance_verdict_failed', err: String(err) });
      }
      // ADR 505 §3–§4: the other side of the same rail — the lane OWNER answering the rejection.
      // A reply that was a verdict cannot also be an answer, so this runs only when nothing moved
      // above. Best-effort for the same reason the verdict is: a failure here must never fail the
      // act that carries the owner's evidence.
      if (!laneVerdict && !laneSuperseded && !laneAdvisory) {
        try {
          dispute = await applyDisputeAnswer(ctx, team, sender, ref, env.act, message.id);
        } catch (err) {
          log.warn({ msg: 'dispute_answer_failed', err: String(err) });
        }
      }
      // ADR 505 §6: an accept of a `handoff` hands the receiver the note back, with the check line.
      if (env.act === 'accept') {
        try {
          acceptedHandoff = await acceptedHandoffOf(ctx, team, sender, ref);
        } catch (err) {
          log.warn({ msg: 'accepted_handoff_lookup_failed', err: String(err) });
        }
        // ADR 516 increment 3: a human admin's accept of a hold proposal IS the activation.
        try {
          await activateHoldProposal(ctx, team, sender, ref);
        } catch (err) {
          log.warn({ msg: 'hold_proposal_activation_failed', err: String(err) });
        }
      }
      // ADR 533: a human admin's accept / decline of a policy review ask IS the answer — accept keeps
      // the doc for another window, decline drops it to the defaults. Announced once, as the human.
      if (env.act === 'accept' || env.act === 'decline') {
        try {
          await answerPolicyReviewAct(ctx, team, sender, ref, env.act);
        } catch (err) {
          log.warn({ msg: 'policy_review_answer_failed', err: String(err) });
        }
      }
    }
  } else if (env.act === 'wait') {
    // Lane 01M2P2E2H6: the acknowledge move. `wait` already means "deciding — check back" (ADR 145
    // §4's reason for not minting a verb), so on a `lane_review` ask it is the reply that says "I
    // have this" without saying what it is. Nothing here moves the lane, deliberately: the whole
    // defect was that the only reply the rail offered also decided.
    const ref = env.meta?.['in_reply_to'];
    if (typeof ref === 'string') {
      try {
        // ADR 667: a `wait` on an advisory ask is neither superseded nor an acknowledge of the
        // binding review — it records nothing.
        if (!(await isAdvisoryAsk(ctx, team, ref))) {
          laneSuperseded = await supersededLaneReview(ctx, team, ref);
          if (!laneSuperseded) laneAck = await applyAcceptanceAck(ctx, team, sender, ref);
          // ADR 680: a `wait` on a lane that has left the acceptance stage takes no review — say so.
          if (!laneSuperseded && !laneAck)
            laneUnbound = await unboundLaneReview(ctx, team, sender, ref, 'wait', message.id);
        }
      } catch (err) {
        log.warn({ msg: 'acceptance_ack_failed', err: String(err) });
      }
    }
  } else if (env.act === 'resolve' && env.thread) {
    const rootTs = await getMessageTs(ctx.db, team.id, env.thread);
    if (rootTs !== null && env.ts >= rootTs)
      recordLoopClosure('resolve', env.ts - rootTs, loopDims);
  }
  // The to-human ask stream lifecycle (ADR 147). Append-only audit rows are the whole stream's trace;
  // the daemon runs no timer — the agent owns the clock (ADR 147 §2). Shapes only, never bodies (ADR 051).
  await recordAskLifecycle(ctx, team, sender.name, outgoingEnv);

  // Incident convergence inc 1 (spec 2026-08-14): a `blocked_by` report on a status_update pools,
  // opens, or appends to an incident lane. Best-effort like every daemon-side hook here — a failure
  // must never fail the status_update that carried the report. `!daemonComposed` is the recursion
  // belt; the composed replies being `act:'message'` (which this hook ignores) is the suspenders.
  //
  // On an enrolled JOINER the hook does not run at all (ADR 371 §2): the pool is the hub's. The
  // report crosses on this very status_update, and the hub pools it when the message folds there
  // (`handleFoldedMessages`, called from the hub's pull). Counting here too would be one pool per
  // machine — one incident lane per machine past the threshold, the exact thing §2 refuses.
  if (
    !daemonComposed &&
    env.act === 'status_update' &&
    !(await joinerEnrollment(ctx.db, team.id, team.slug))
  ) {
    try {
      await handleBlockedReport(ctx, team, sender, outgoingEnv);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', err: String(err) });
    }
  }

  // Self-reported token usage (meta.usage — ADR 082 slice 4): opt-in, harness-agnostic.
  recordTokenUsage(outgoingEnv);

  // The act is durable and origin-stamped: offer it to the hub now, not at the next 60 s tick
  // (debounced; a no-op where no push loop runs — a hub, cloud, an unenrolled machine).
  kickSyncPush(ctx);

  // Deliver live to whoever is present. Durability is the log; this is the push — its outcome per
  // recipient (live vs inboxed) is attempt history, recorded as span events (ADR 090), never rows.
  let delivered = 0;
  for (const recipientId of recipients) {
    const recipientName = recipientNames.get(recipientId);
    const toName = env.to.kind === 'member' && recipientName ? recipientName : null;
    const outgoing = rowToEnvelope(message, team.slug, sender.name, toName);
    const pushed = ctx.hub.deliver(recipientId, { type: 'deliver', envelope: outgoing });
    delivered += pushed;
    if (recipientName) recordDeliveryOutcome(recipientName, pushed > 0);
  }

  // Fan out to firehose observers (ADR 061): every envelope on the team, for read-only watchers like
  // the dashboard. Skip recipients (already delivered) and the one connection the act came in on (got
  // an ack) so no double-send. Not every connection of the sender: that member-wide skip kept a
  // human's own CLI sends off their open /live tab until a refresh (lane 01M4H7YKS5).
  const firehoseEnv = rowToEnvelope(
    message,
    team.slug,
    sender.name,
    env.to.kind === 'member' ? env.to.name : null,
  );
  // What a non-party subscriber may see is its ADR 407 grade (see `hub.broadcastFirehose`): a
  // directed envelope reaches every claimed seat, a confidential ask — ADR 407 §3, the one act that
  // names a seat as its subject — reaches admins and full observers only, and a public watch-link
  // gets team/broadcast acts alone. `confidentialAskSubject` is the same test the SQL read mirrors.
  const firehoseDelivered = ctx.hub.broadcastFirehose(
    team.id,
    { type: 'deliver', envelope: firehoseEnv },
    new Set(recipients),
    message.to_kind === 'member',
    confidentialAskSubject(env) !== null,
    senderConnId,
    humanPair,
  );

  // The to-human ask stream's guaranteed reach (ADR 147 §3): an `ask` routes to admin humans by default.
  // Live-push it to every admin connection on top of normal delivery — skipping admins already delivered
  // to as recipients (and the sender) so no one is double-sent. This is what makes "escalations always
  // technically reach the human" true even when the ask is directed at a non-admin: the durable message
  // row is the inbox reach, this push is the loud reach. (Its loud *surface* — Slack + /live — is item 3.)
  if (env.act === 'ask') {
    ctx.hub.deliverToAdmins(
      team.id,
      { type: 'deliver', envelope: firehoseEnv },
      new Set([...recipients, sender.id]),
    );
  }
  // The doorbell (ADR 443): ring any human this act rings, through musterd's own surfaces. Detached
  // and never throwing — the send has already persisted and delivered.
  await ringDoorbell(ctx, team, firehoseEnv);

  // Away channels (ADR 668, ADR 676): an advisory ask also goes to each addressed human's Slack
  // binding as an interactive message, and sealed to their musterd app. Detached and never throwing — delivery is a loud
  // surface beside the durable inbox reach, never a condition of the send.
  void deliverAskToSlackChannels(ctx, team, firehoseEnv);
  void deliverAskToAppChannels(ctx, team, firehoseEnv);

  log.info({
    msg: 'route',
    team: team.slug,
    member: sender.name,
    act: env.act,
    to: env.to.kind,
    recipients: recipients.length,
    delivered,
    firehose_delivered: firehoseDelivered,
  });

  // Durable record of both branches (ADR 231 Observability): the derivation is otherwise invisible
  // to the sender's transcript, and the ambiguous count is the counter-signal that says the warning
  // is being ignored. The no-lane case is deliberately unlogged — it is the legal path, and logging
  // it would drown the two that matter.
  if (handoffLane) {
    await appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'lane' in handoffLane ? 'handoff.lane_derived' : 'handoff.lane_ambiguous',
      target: message.id,
      result: 'allow',
      detail: {
        message: message.id,
        ...handoffLane,
        // ADR 243: which of the two candidate sets answered. Always written when a derivation
        // happened, so absence means "recorded before ADR 243" and never "the held set" — the
        // ADR 173 rule that a three-valued read needs an unambiguous write edge to mean anything.
        ...(handoffBasis ? { basis: handoffBasis } : {}),
      },
    });
  }
  return {
    message,
    recipients,
    delivered,
    ...(handoffLane ? { handoff_lane: handoffLane } : {}),
    ...(laneVerdict ? { lane_verdict: laneVerdict } : {}),
    ...(laneAuthorityRefused ? { lane_authority_refused: laneAuthorityRefused } : {}),
    ...(laneVerdictRefused ? { lane_verdict_refused: laneVerdictRefused } : {}),
    ...(laneEscalation ? { lane_escalation: laneEscalation } : {}),
    ...(laneAck ? { lane_ack: laneAck } : {}),
    ...(laneSuperseded ? { lane_superseded: laneSuperseded } : {}),
    ...(laneAdvisory ? { lane_advisory: laneAdvisory } : {}),
    ...(laneUnbound ? { lane_unbound: laneUnbound } : {}),
    ...(dispute ? { dispute } : {}),
    ...(acceptedHandoff ? { accepted_handoff: acceptedHandoff } : {}),
    ...(deafRecipient ? { deaf_recipient: deafRecipient } : {}),
  };
}

/**
 * Incident convergence inc 1 (spec 2026-08-14 §1–§3, no wakes). Records the `blocked_by` report,
 * then closes the loop the store can't: a DUPLICATE reporter (report matched an open incident) gets
 * the park-behind-it pointer immediately, and the OPENING pair each get one announcement naming the
 * new lane — routed through the normal delivery path, so live sessions get the existing
 * delivery-hint nudge for free and out seats get inbox rows. Daemon-composed envelopes are
 * `act:'message'`, which the caller's status_update guard never matches (recursion bound).
 *
 * The composed messages come from the team's `board` service seat (ADR 649, after ADR 646): the
 * daemon wrote them, so no member is named as their sender. The bodies still say who carries the
 * lane.
 */
/**
 * Push messages the fold just inserted to the sockets open on THIS machine — recipients first, then
 * firehose watchers — the delivery `routeEnvelope` does for a local send. The fold writes `messages`
 * and nothing else, so before this a remote act reached an open seat only when it next read its inbox
 * (ADR 325 "not yet true", fixed here). Live is the push, durable is the row: a seat that is not
 * connected simply gets it from its inbox, and a client that sees it live and again on a read
 * dedupes by `envelope.id` (at-least-once, 03-server.md). Delivery only — none of `routeEnvelope`'s
 * side effects (verdicts, incident pool, doorbell) run: those are the sender's machine's or the
 * hub's, and `handleFoldedMessages` fires the hub's. Never throws; a failed push is the inbox's job.
 */
export async function deliverFoldedLive(
  ctx: Ctx,
  teamSlug: string,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const team = await getTeamBySlug(ctx.db, teamSlug);
  if (!team) return 0;
  let delivered = 0;
  for (const id of messageIds) {
    try {
      const row = await ctx.db.get<MessageRow>(
        'SELECT * FROM messages WHERE team_id = ? AND id = ?',
        [team.id, id],
      );
      if (!row) continue;
      const sender = await getMemberById(ctx.db, row.from_member);
      if (!sender) continue;
      let recipients: { id: string; name: string }[];
      let humanPair = false;
      if (row.to_kind === 'member' && row.to_member) {
        const target = await getMemberById(ctx.db, row.to_member);
        recipients =
          target && target.left_at === null ? [{ id: target.id, name: target.name }] : [];
        humanPair = target !== null && target !== undefined && isHumanPair(sender, target);
      } else {
        recipients = await ctx.db.all<{ id: string; name: string }>(
          'SELECT id, name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?',
          [team.id, sender.id],
        );
      }
      const toName = row.to_kind === 'member' ? (recipients[0]?.name ?? null) : null;
      const env = rowToEnvelope(row, team.slug, sender.name, toName);
      for (const r of recipients) {
        delivered += ctx.hub.deliver(r.id, { type: 'deliver', envelope: env });
      }
      // Skip the recipients (delivered above) but NOT the sender: a folded act came from another
      // machine, so no connection here got an ack for it. The sender's own /live tab on this
      // machine is a firehose watcher like any other, the same rule the local path follows (lane
      // 01M4H7YKS5). Skipping it kept a human's hub-side accepts off their joiner tab until they
      // accepted again there (lane 01M4V95YGT, 2026-10-13).
      delivered += ctx.hub.broadcastFirehose(
        team.id,
        { type: 'deliver', envelope: env },
        new Set(recipients.map((r) => r.id)),
        row.to_kind === 'member',
        confidentialAskSubject(env) !== null,
        undefined,
        humanPair,
      );
    } catch (err) {
      log.warn({ msg: 'folded_live_delivery_failed', message: id, err: String(err) });
    }
  }
  return delivered;
}

/**
 * The hub's half of ADR 371 §2: run the route-time hooks a FOLDED message still owes. A joiner's
 * `status_update` carrying a `blocked_by` report was never routed here — it folded — so the pool
 * never saw it. Called from the hub's pull with the ids the fold just inserted (never from a scan
 * of `messages`, which would re-fire on every tick). The incident hook and the ADR 188 stage-two
 * human ask live here: every other route-time hook is either residence-local by design or already
 * replicated as its own kind.
 */
export async function handleFoldedMessages(
  ctx: Ctx,
  teamSlug: string,
  messageIds: string[],
): Promise<void> {
  const team = await getTeamBySlug(ctx.db, teamSlug);
  if (!team) return;
  for (const id of messageIds) {
    const row = await ctx.db.get<MessageRow>(
      'SELECT * FROM messages WHERE team_id = ? AND id = ?',
      [team.id, id],
    );
    if (!row || !row.meta) continue;
    if (row.act !== 'status_update' && row.act !== 'accept') continue;
    const sender = await getMemberById(ctx.db, row.from_member);
    if (!sender) continue;
    if (row.act === 'accept') {
      // ADR 188 stage two for a joiner's accept, which skipped it at route time (lane 01M3ZBTJKD).
      // ADR 539: a human's accept is the verdict, not a peer stage — nothing to fire.
      if (sender.kind === 'human') continue;
      const ref = (JSON.parse(row.meta) as { in_reply_to?: unknown }).in_reply_to;
      if (typeof ref !== 'string') continue;
      try {
        // ADR 667: an advisory ask's accept is never the peer stage, on fold too.
        if (await isAdvisoryAsk(ctx, team, ref)) continue;
        // ADR 545: an accept on an ask a re-route already closed escalates nothing, on fold too.
        if (await supersededLaneReview(ctx, team, ref)) continue;
        await fireGatedHumanAsk(ctx, team, sender, ref, row.body, row.id);
      } catch (err) {
        log.warn({ msg: 'gated_human_ask_failed', message: id, err: String(err) });
      }
      continue;
    }
    const to = row.to_member ? await getMemberById(ctx.db, row.to_member) : null;
    const env = rowToEnvelope(row, team.slug, sender.name, to?.name ?? null);
    if (!blockedByOf(env.meta)) continue;
    try {
      await handleBlockedReport(ctx, team, sender, env);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', message: id, err: String(err) });
    }
  }
}

async function handleBlockedReport(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
): Promise<void> {
  const report = blockedByOf(env.meta);
  if (!report) return;
  const outcome = await recordBlockedReport(
    ctx.db,
    team.id,
    team.slug,
    sender.name,
    report,
    env.id,
  );
  // `disabled` (team opted out) and `recorded` (still pooling) both mean there is no lane to point
  // anyone at — and in the disabled case nothing was written down at all.
  if (outcome.kind === 'recorded' || outcome.kind === 'disabled') return;

  const lane = outcome.lane;
  // ADR 649: the board speaks. Null only when `board` names a person or an agent: the report itself
  // is still durably recorded, and the board never speaks as somebody else.
  const fromRow = await boardSeat(ctx.db, team);
  if (!fromRow) return;

  if (outcome.kind === 'appended') {
    // Don't answer the lane's own carrier: the owner re-reporting their own incident needs no pointer.
    if (sender.name === lane.owner_seat) return;
    const reply = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: fromRow.name,
      to: { kind: 'member', name: sender.name },
      act: 'message',
      body:
        `[incident] already ${lane.owner_seat ? `owned by ${lane.owner_seat}` : 'open (unclaimed)'}, ` +
        `lane ${lane.id} — park behind it.`,
      thread: env.id,
      meta: { incident: { lane: lane.id, gate: report.gate } },
    });
    await routeEnvelope(ctx, team, fromRow, reply, undefined, true);
    await appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'incident.duplicate_replied',
      target: lane.id,
      result: 'allow',
      detail: { gate: report.gate, lane: lane.id },
    });
    return;
  }

  // opened: announce to every distinct reporter (the threshold pair, typically). The board is
  // never a reporter, so no announcement is a self-send.
  const reporters = await incidentReporters(ctx.db, team.id, lane.id);
  const voice = fromRow;
  for (const reporter of reporters) {
    const to = await getMemberByName(ctx.db, team.id, reporter);
    if (!to) continue;
    const announce = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: voice.name,
      to: { kind: 'member', name: reporter },
      act: 'message',
      body:
        `[incident] opened: ${report.gate} — lane ${lane.id}, unclaimed. ` +
        `If your red matches, park behind it; any seat may claim.`,
      meta: { incident: { lane: lane.id, gate: report.gate } },
    });
    await routeEnvelope(ctx, team, voice, announce, undefined, true);
  }
}

/**
 * Tell the seat an unclaimed incident was just handed to (ADR 271, spec §3), and tell the reporters
 * their red now has an owner.
 *
 * The board speaks (ADR 649). Before it, the voice had to be a reporter other than the recipient:
 * assignment has already set `owner_seat`, so a lane-derived voice was the new owner and every
 * message a self-send, which never reaches an inbox.
 *
 * Called from the reaper rather than a transport, on the `seeds/ingest.ts` precedent: a
 * daemon-composed act routed through normal delivery, so live sessions get the existing
 * delivery-hint nudge for free. `daemonComposed` is set, which is also the recursion belt — these
 * are `message` acts and would otherwise re-enter the blocked-report hook.
 */
export async function announceIncidentRouted(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  owner: string,
  waitedMs: number,
): Promise<void> {
  const reporters = await incidentReporters(ctx.db, team.id, lane.id);
  const voice = await boardSeat(ctx.db, team);
  if (!voice) return;

  const minutes = Math.round(waitedMs / 60_000);
  // The owner first, and they are told they can hand it back — an assignment nobody chose is a
  // routing default, not a verdict about who should fix it. Then the reporters, so the seats parked
  // behind the red learn it has an owner without anyone asking a human to relay it.
  const recipients: [string, string][] = [
    [
      owner,
      `[incident] routed to you: "${lane.title}" — lane ${lane.id}, unclaimed for ${minutes}m so it fell to your role. ` +
        `You did not choose it: hand it off or release it if someone with the context is closer.`,
    ],
    ...reporters
      .filter((r) => r !== owner)
      .map((r): [string, string] => [
        r,
        `[incident] "${lane.title}" now owned by ${owner} — lane ${lane.id}. Your report is on it; stay parked.`,
      ]),
  ];

  for (const [recipient, body] of recipients) {
    const to = await getMemberByName(ctx.db, team.id, recipient);
    if (!to) continue;
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: recipient },
        act: 'message',
        body,
        meta: { incident: { lane: lane.id, routed_to: owner } },
      }),
      undefined,
      true,
    );
  }
}

/**
 * Fan a resolved incident out to exactly the seats who reported it (ADR 271, spec §3).
 *
 * This is what every appended report was FOR. Increment 1 kept inserting a row per report even past
 * the threshold, on the stated bet that more refs make a better fan-out at resolve — this collects
 * it. A seat that parked a PR behind a shared red has no other way to learn it can move again short
 * of a human noticing and relaying, which is the exact job the spec set out to delete.
 *
 * Called from BOTH close paths — the board's PATCH and the ADR 202 acceptor `accept` — because
 * `recordLaneClose` deliberately cannot route envelopes (it is imported from the transport and the
 * protocol layer both, and routing from it would make that a cycle). Non-incident lanes return
 * immediately, so both call sites can call it unconditionally.
 */
export async function announceIncidentResolved(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  closedBy: string,
): Promise<void> {
  if (lane.kind !== 'incident') return;
  const reporters = await incidentReporters(ctx.db, team.id, lane.id);
  // ADR 649: the board speaks; the body names who closed it.
  const voice = await boardSeat(ctx.db, team);
  if (!voice) return;

  for (const reporter of reporters) {
    // The closer already knows; a self-send reaches no inbox anyway.
    if (reporter === closedBy) continue;
    const to = await getMemberByName(ctx.db, team.id, reporter);
    if (!to) continue;
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: reporter },
        act: 'message',
        body:
          `[incident] resolved by ${closedBy}: ${lane.title.replace(/^incident: /, '')} — ` +
          `lane ${lane.id}. Whatever you parked behind it can move; re-run before you trust it.`,
        meta: { incident: { lane: lane.id, resolved_by: closedBy } },
      }),
      undefined,
      true,
    );
  }
}

/**
 * ADR 188 stage two — the gated human ask. Fires when an ACCEPT lands whose replied-to message is a
 * lane-review ask (`meta.lane_review`) for a lane that is (a) risky and (b) still awaiting acceptance.
 * Composes the blocking-tier human ask FROM the lane's owner (the worker whose lane it is — same
 * sender as the stage-one ask) carrying the peer's findings, and audits `lane.review_peer_confirmed`
 * whether or not a human was live — `human_ask_fired: false` is the countable degradation
 * (ADR 173), and the close edge still derives `human_review_missed` when no human ever confirms.
 *
 * A peer accept on a NON-risky lane's review ask does nothing here: one review is that lane's whole
 * contract. Recursion is bounded — the composed act is an `ask`, which this hook never matches.
 *
 * Returns whether it ESCALATED — i.e. whether a human was asked and the lane is now waiting on them.
 * The caller needs that answer: since ADR 202 an accept also closes the lane it accepts, and a risky
 * lane whose peer review just escalated must stay open for the human whose verdict was demanded.
 */
/** The risky, awaiting-acceptance lane a peer's accept of `repliedToId` gates (ADR 188), or null. */
async function gatedLane(
  ctx: Ctx,
  team: TeamRow,
  repliedToId: string,
): Promise<{ lane: Lane; owner: MemberRow; grade: string | null } | null> {
  const replied = await ctx.db.get<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, repliedToId],
  );
  if (!replied?.meta) return null;
  let laneReview: { lane?: string; title?: string; grade?: string } | undefined;
  try {
    laneReview = (JSON.parse(replied.meta) as { lane_review?: typeof laneReview }).lane_review;
  } catch {
    return null;
  }
  if (!laneReview?.lane) return null;
  // ADR 667: an advisory ask's accept is never the peer stage.
  if ((laneReview as { advisory?: unknown }).advisory === true) return null;
  const lane = await getLane(ctx.db, team.id, laneReview.lane, team.slug);
  if (!lane || !humanReviewRequired(lane) || !isAwaitingAcceptance(lane.state)) return null;
  const owner = lane.owner_seat ? await getMemberByName(ctx.db, team.id, lane.owner_seat) : null;
  if (!owner) return null;
  return { lane, owner, grade: laneReview.grade ?? null };
}

async function fireGatedHumanAsk(
  ctx: Ctx,
  team: TeamRow,
  peer: MemberRow,
  repliedToId: string,
  peerFindings: string,
  /** The peer's accept message — kept on the ledger row so a later retry can carry its findings. */
  peerAcceptId: string | null = null,
): Promise<{ lane: string; human: string | null } | null> {
  const gated = await gatedLane(ctx, team, repliedToId);
  if (!gated) return null;
  const { lane, owner } = gated;

  // ADR 607: live human first, else an offline one (admin, then most recently seen). Null only when
  // the team has no eligible human seat — the one case the ADR 539 pending state still covers.
  const human = await humanReviewerFor(ctx.db, team.id, owner.name, ctx.config.presenceTimeoutMs);
  // ADR 539: replicated (it always sat in the fold's LANE_VERBS, but was written local-only), so a
  // joiner's brief can say "peer-confirmed, waiting for a human" about a hub-side confirmation.
  await appendReplicatedEvent(ctx.db, team.id, {
    actor: peer.name,
    action: 'lane.review_peer_confirmed',
    target: lane.id,
    result: 'allow',
    detail: {
      lane: lane.id,
      peer: peer.name,
      grade: gated.grade,
      human_ask_fired: human !== null,
      // ADR 607 §4: whether the human asked was live at the time — the ask fires either way.
      human_live: human?.live ?? false,
      ...(peerAcceptId ? { peer_accept: peerAcceptId } : {}),
    },
  });
  if (!human) return { lane: lane.id, human: null };
  await sendHumanStageAsk(
    ctx,
    team,
    lane,
    owner,
    peer.name,
    peerFindings,
    human.reviewer,
    false,
    human.live,
  );
  return { lane: lane.id, human: human.reviewer };
}

/** The stage-two ask itself (ADR 188 §4), composed FROM the lane owner, carrying the peer's findings. */
async function sendHumanStageAsk(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  owner: MemberRow,
  peerName: string,
  peerFindings: string,
  human: string,
  retried: boolean,
  /** ADR 607 §4: the human had live presence when asked. */
  humanLive: boolean,
): Promise<void> {
  const findings = peerFindings.length > 500 ? `${peerFindings.slice(0, 500)}…` : peerFindings;
  // ADR 612: the human sees what kind of landing it is before the peer's findings.
  const humanKind = lane.merged ? changeLabelText(lane.merged) : null;
  const checklist =
    'Judge the LANDED OUTCOME (not a code review): ' +
    '(1) Intent — matches the lane brief? ' +
    '(2) Principles — project/musterd hard rules? ' +
    '(3) Usable — exercise the path enough to say it works? ' +
    '(4) Feel — only if UI/copy/brand is in surface, else N/A. ' +
    'Accept → move the lane to done; reject → send it back to active with a concrete note.' +
    ACCEPTANCE_MOVES_NOTICE;
  const ask = makeEnvelope({
    id: ulid(),
    team: team.slug,
    from: owner.name,
    to: { kind: 'member', name: human },
    act: 'ask',
    body:
      `[lane] human acceptance required${humanKind ? ` (${humanKind})` : ''}: "${lane.title}" — peer ${peerName} accepted with: ` +
      `"${findings}". ${checklist}`,
    meta: {
      species: 'approve',
      tier: 'blocking',
      lane_review: {
        lane: lane.id,
        title: lane.title,
        branch: lane.branch,
        ...(lane.merged ? { merged: lane.merged } : {}),
        route: 'human_admin',
        grade: 'human',
        peer_confirmed_by: peerName,
        // ADR 506: the stage-two human ask's promise, on the same floor as every review ask.
        wait_ms: await acceptanceTimeoutMs(ctx.db, team.id, 'blocking'),
      },
    },
  });
  // daemonComposed: the daemon authored this ask, so its `lane_review` is authentic (ADR 225).
  await routeEnvelope(ctx, team, owner, ask, undefined, true);
  // ADR 539: the receipt that the human stage was asked — what turns "peer-confirmed, pending" off.
  await appendReplicatedEvent(ctx.db, team.id, {
    actor: null,
    action: 'lane.review_human_asked',
    target: lane.id,
    result: 'allow',
    detail: { lane: lane.id, human, ask: ask.id, peer: peerName, retried, human_live: humanLive },
  });
}

/**
 * ADR 539: the retry. A risky lane whose peer confirmed while no human was live sat forever in
 * `awaiting_acceptance` with nobody asked (nameplates lane, 2026-10-06 — the hub found no live
 * human at fold time and `human_ask_fired: false` was the last word). The reaper calls this on the
 * hub each tick: for every peer-confirmed-pending lane, if a human is live now, fire the stage-two
 * ask with the peer's original findings (read back from the peer's accept message) and record
 * `retried: true`. Never closes a lane, never invents a verdict — it only asks the human the lane
 * was always owed. Returns the lanes it asked for.
 */
export async function retryPendingHumanAsks(
  ctx: Ctx,
  team: TeamRow,
): Promise<Array<{ lane: string; human: string }>> {
  const asked: Array<{ lane: string; human: string }> = [];
  for (const pending of await pendingHumanReviews(ctx.db, team.id)) {
    const lane = await getLane(ctx.db, team.id, pending.lane, team.slug);
    if (!lane || !isAwaitingAcceptance(lane.state) || !humanReviewRequired(lane)) continue;
    const owner = lane.owner_seat ? await getMemberByName(ctx.db, team.id, lane.owner_seat) : null;
    if (!owner) continue;
    const human = await pickHumanReviewer(
      ctx.db,
      team.id,
      owner.name,
      ctx.config.presenceTimeoutMs,
    );
    if (!human) continue;
    const accept = pending.peer_accept
      ? await ctx.db.get<{ body: string }>(
          'SELECT body FROM messages WHERE team_id = ? AND id = ?',
          [team.id, pending.peer_accept],
        )
      : null;
    await sendHumanStageAsk(
      ctx,
      team,
      lane,
      owner,
      pending.peer,
      accept?.body ?? '(peer findings not on this node)',
      human.reviewer,
      true,
      true,
    );
    asked.push({ lane: lane.id, human: human.reviewer });
  }
  return asked;
}

/**
 * Lane 01M2P2E2H6 — "I have this" on an acceptance ask, without deciding it.
 *
 * Every other obligation on this rail has a non-terminal take: a `request_help` is accepted and
 * then discharged by doing the work. A `lane_review` ask had none, so the learned reflex —
 * `accept` with a body saying "taking this review" — was also the irreversible close, and the
 * daemon explained that only in the ack, after the write. Three seats sent that announcement in a
 * month; the first aimed at a real acceptance ask closed a teammate's lane unreviewed, under the
 * acceptor's own name and `verified: true` (2026-09-16 14:31, lane 01M2NR7N9V, by this lane's
 * author).
 *
 * Same narrowness as {@link applyAcceptanceVerdict}, and for the same reasons: only from a real
 * `lane_review` ask, only while the lane is still awaiting acceptance, never on a superseded ask.
 * One difference is deliberate — this writes an audit row and NOTHING else. It does not discharge
 * the ask (the verdict is still owed and `openAcceptanceLoad` must keep counting it), and it does
 * not touch lane state. An acknowledge that quietly changed something would be the defect it
 * replaces wearing a friendlier word.
 */
async function applyAcceptanceAck(
  ctx: Ctx,
  team: TeamRow,
  acceptor: MemberRow,
  repliedToId: string,
): Promise<RouteResult['lane_ack']> {
  const replied = await ctx.db.get<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, repliedToId],
  );
  if (!replied?.meta) return;
  let laneId: string | undefined;
  try {
    laneId = (JSON.parse(replied.meta) as { lane_review?: { lane?: string } }).lane_review?.lane;
  } catch {
    return;
  }
  if (!laneId) return;
  // ADR 667: an advisory ask's `wait` acknowledges nothing the lane waits on.
  if (isAdvisoryReviewMeta(safeParse(replied.meta))) return;
  const lane = await getLane(ctx.db, team.id, laneId, team.slug);
  if (!lane || !isAwaitingAcceptance(lane.state)) return;
  if ((await supersededAcceptanceAsks(ctx.db, team.id, laneId)).has(repliedToId)) return;
  await appendAudit(ctx.db, team.id, {
    actor: acceptor.name,
    action: 'lane.review_acknowledged',
    target: lane.id,
    result: 'allow',
    detail: { lane: lane.id, ask: repliedToId, acceptor: acceptor.name },
  });
  return { lane: lane.id };
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** ADR 667: is `askId` an acceptance ask the daemon marked advisory? */
async function isAdvisoryAsk(ctx: Ctx, team: TeamRow, askId: string): Promise<boolean> {
  const row = await ctx.db.get<{ meta: string | null }>(
    `SELECT meta FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'`,
    [team.id, askId],
  );
  return isAdvisoryReviewMeta(safeParse(row?.meta ?? null));
}

/**
 * ADR 667 — an accept/decline answering an ADVISORY acceptance ask: recorded against the lane as
 * `lane.review_advisory` (the answer's id, so the readout joins the verdict to its words), and
 * nothing else. Recorded in any lane state, a closed lane included: the advisory seat can be the
 * slower reviewer, and its late verdict is exactly what is being measured. Only the holder's own
 * answer counts — a bystander replying on someone else's advisory ask records nothing.
 */
async function recordAdvisoryVerdict(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  repliedToId: string,
  act: 'accept' | 'decline',
  answerId: string,
): Promise<RouteResult['lane_advisory']> {
  const ask = await ctx.db.get<{ meta: string | null; to_member: string | null }>(
    `SELECT meta, to_member FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'`,
    [team.id, repliedToId],
  );
  if (!ask) return;
  const meta = safeParse(ask.meta);
  if (!isAdvisoryReviewMeta(meta)) return;
  const laneId = (meta as { lane_review: { lane?: unknown } }).lane_review.lane;
  if (typeof laneId !== 'string') return;
  if (ask.to_member === sender.id)
    await appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'lane.review_advisory',
      target: laneId,
      result: 'allow',
      detail: {
        lane: laneId,
        ask: repliedToId,
        reviewer: sender.name,
        verdict: act,
        answer: answerId,
      },
    });
  return { lane: laneId, ask: repliedToId, verdict: act };
}

/**
 * ADR 545 — the reply answered a `lane_review` ask that a re-route (named, departed or reaped)
 * already superseded, or that a newer review ask on the lane replaced (lane 01M4VH00A8), on a lane
 * still awaiting acceptance: what it answered and which ask binds now. `undefined` for anything
 * else, including the live ask — the verdict path handles those.
 */
async function supersededLaneReview(
  ctx: Ctx,
  team: TeamRow,
  repliedToId: string,
): Promise<RouteResult['lane_superseded']> {
  const replied = await ctx.db.get<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, repliedToId],
  );
  if (!replied?.meta) return;
  let laneId: string | undefined;
  try {
    laneId = (JSON.parse(replied.meta) as { lane_review?: { lane?: string } }).lane_review?.lane;
  } catch {
    return;
  }
  if (!laneId) return;
  const lane = await getLane(ctx.db, team.id, laneId, team.slug);
  if (!lane || !isAwaitingAcceptance(lane.state)) return;
  // Two ways an ask stops being the one that binds: a re-route closed it, or a newer review ask
  // was minted on the lane (a resubmit, or the stage-two human ask). Lane 01M4VH00A8: a second
  // decline on an ask already answered before a resubmit sent the resubmitted lane back to active,
  // and the reviewer's accept on the live ask 4 s later then moved nothing (lane 01M4V95YGT,
  // 2026-10-13).
  if (
    !(await supersededAcceptanceAsks(ctx.db, team.id, laneId)).has(repliedToId) &&
    (await newestLaneReviewAsk(ctx, team, laneId)) === repliedToId
  )
    return;
  const current = await openAcceptanceAsk(ctx.db, team.id, laneId);
  log.info({ msg: 'acceptance_reply_on_superseded_ask', lane: laneId, ask: repliedToId });
  return {
    lane: laneId,
    ask: repliedToId,
    current: current ? { ask: current.id, reviewer: current.to } : null,
  };
}

/** The lane's most recent `lane_review` ask, answered or not — the only one a verdict can bind to. */
async function newestLaneReviewAsk(
  ctx: Ctx,
  team: TeamRow,
  laneId: string,
): Promise<string | undefined> {
  const row = await ctx.db.get<{ id: string }>(
    `SELECT id FROM messages m
        WHERE m.team_id = ? AND m.act = 'ask' AND json_extract(m.meta, '$.lane_review.lane') = ?
          AND ${bindingAskSql('m')}
        ORDER BY m.ts DESC, m.id DESC LIMIT 1`,
    [team.id, laneId],
  );
  return row?.id;
}

/**
 * ADR 680 — the reply answered a `lane_review` ask on a lane that has LEFT the acceptance stage:
 * the third way an ask stops being the one that binds (a re-route is ADR 545, an advisory ask is
 * ADR 667). The lane closed on a newer PR, was sent back, was parked or was abandoned, so no
 * verdict on it can move it — ADR 202 means one verdict closes a lane, and the second one is
 * simply nothing.
 *
 * It used to be nothing *and silent*: `applyAcceptanceVerdict` returns early once the lane is no
 * longer awaiting acceptance, and ADR 545's marker is gated on that same state, so the sender got
 * no "moved nothing" sentence and the audit trail got no row. big-body's 16:58 decline on
 * 2026-10-19 (lane 01M5ASVF3G, closed at 14:20 on a newer PR) bound to nothing in silence, and
 * the correction it carried sat on `main` for 2h20m after the lane closed.
 *
 * So: name it. The row is targeted at the lane, so it appears in that lane's history — a reviewer
 * who was not heard is visible there — and the ack tells the sender on the spot, which is what
 * ADR 545 did for its own case. Nothing is woken and nothing is copied: the lane is settled, and
 * the sender is the one who can act on what they just learned.
 */
async function unboundLaneReview(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  repliedToId: string,
  act: 'accept' | 'decline' | 'wait',
  answerId: string,
): Promise<RouteResult['lane_unbound']> {
  const replied = await ctx.db.get<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, repliedToId],
  );
  if (!replied?.meta) return;
  let laneId: string | undefined;
  try {
    laneId = (JSON.parse(replied.meta) as { lane_review?: { lane?: string } }).lane_review?.lane;
  } catch {
    return;
  }
  if (!laneId) return;
  // ADR 667: an advisory ask's reply is recorded and named by its own marker, in any lane state.
  if (isAdvisoryReviewMeta(safeParse(replied.meta))) return;
  const lane = await getLane(ctx.db, team.id, laneId, team.slug);
  // A lane still awaiting acceptance is ADR 545's case (the ask was superseded) or the live ask's
  // (the verdict binds) — both of those answer for themselves.
  if (!lane || isAwaitingAcceptance(lane.state)) return;
  await appendAudit(ctx.db, team.id, {
    actor: sender.name,
    action: 'lane.review_unbound',
    target: lane.id,
    result: 'allow',
    detail: {
      lane: lane.id,
      ask: repliedToId,
      reviewer: sender.name,
      verdict: act,
      answer: answerId,
      state: lane.state,
    },
  });
  log.info({
    msg: 'acceptance_verdict_unbound',
    lane: laneId,
    ask: repliedToId,
    verdict: act,
    state: lane.state,
  });
  return { lane: lane.id, ask: repliedToId, verdict: act, state: lane.state };
}

/**
 * Lane 01M5Z3NAJE: the ack for an accept the ADR 644 read rule refused. Addressed to the acceptor,
 * who cannot give the read verdict — the lane's owner records it after the read — so it names the
 * owner, the day, and that the ask stays open for the same accept once the verdict is in.
 */
function readVerdictRefusal(
  lane: Lane,
  askId: string,
): NonNullable<RouteResult['lane_verdict_refused']> {
  return {
    lane: lane.id,
    reason: 'read_verdict_missing',
    guidance:
      `Lane ${lane.id}: your accept did NOT close the lane — it reads on ${lane.reads_on ?? 'a set day'} ` +
      `(ADR 644), and a lane that reads closes done only with a read verdict. ` +
      `${lane.owner_seat ? `Its owner, ${lane.owner_seat},` : 'Its owner'} records it after the read (lane_update {read_verdict}); then send this accept again on ask ` +
      `${askId}, which stays open. Nothing moved.`,
  };
}

/**
 * ADR 202 — an acceptance verdict moves the lane it judges.
 *
 * `accept` closes the lane the ask named; `decline` sends it back to `active`, which is exactly what
 * the board's two acceptor verbs do (`boardWrite.laneActions`). This is the same transition by the
 * other door: the acceptor who answers in chat and the acceptor who clicks on the board now leave
 * the same record, and neither has to know that the other surface exists.
 *
 * Deliberately narrow, because this mutates state from a message path:
 * · Only from a real `lane_review` ask — the ask carries the lane id, so nothing is inferred.
 * · Only while the lane is still awaiting acceptance. That makes it idempotent (a second accept on
 *   the same ask does nothing) and keeps a stale ask from reopening or re-closing settled work.
 * · The close audit goes through `recordLaneClose`, the same derivation the board's PATCH uses, so
 *   verified-ness cannot come out differently depending on which door the verdict came through.
 *   An owner who accepts their own lane records `verified: false` by that same derivation — the
 *   honesty is structural, not a check I have to remember to write here.
 *
 * Returns the move it made — lane and new state — or `undefined` when it made none, so the ack can
 * say so (lane 01M2GQFJXG): Promise<an accept that closes a lane must not look, to its sender, like an
 * accept that merely answered a message.
 */
async function applyAcceptanceVerdict(
  ctx: Ctx,
  team: TeamRow,
  decider: MemberRow,
  repliedToId: string,
  act: 'accept' | 'decline',
  body: string,
  meta?: Record<string, unknown> | null,
  forwardedNodeId?: string,
): Promise<{
  verdict?: RouteResult['lane_verdict'];
  authorityRefused?: RouteResult['lane_authority_refused'];
  verdictRefused?: RouteResult['lane_verdict_refused'];
}> {
  const replied = await ctx.db.get<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, repliedToId],
  );
  if (!replied?.meta) return {};
  let laneId: string | undefined;
  try {
    laneId = (JSON.parse(replied.meta) as { lane_review?: { lane?: string } }).lane_review?.lane;
  } catch {
    return {};
  }
  if (!laneId) return {};
  // ADR 667: belt and braces — the caller already routed an advisory answer elsewhere, and an
  // advisory ask must never close or reopen a lane by any path.
  if (isAdvisoryReviewMeta(safeParse(replied.meta))) return {};
  const before = await getLane(ctx.db, team.id, laneId, team.slug);
  if (!before || !isAwaitingAcceptance(before.state)) return {};
  // A re-route (lane 01M1QYHJFY) told this seat the acceptance moved to someone else and closed
  // its ask. Its verdict still lands as a message — it is not refused as an act — but it binds to
  // nothing: the lane's acceptance is the NEW seat's to give, and honouring both would let two
  // seats close one lane.
  if ((await supersededAcceptanceAsks(ctx.db, team.id, laneId)).has(repliedToId)) {
    log.info({
      msg: 'acceptance_verdict_on_superseded_ask',
      lane: laneId,
      ask: repliedToId,
      decider: decider.name,
    });
    return {};
  }

  // ADR 662: a human's verdict is a listed act. Once that human has an enrolled device key,
  // the verdict binds only with an A2 signature over the server descriptor (carried on the
  // act as meta.approval); without it the act lands as a message and moves nothing — the
  // refusal itself is audited by the gate. Agent deciders are peer acceptance, not listed.
  if (decider.kind === 'human') {
    const proofParsed = ApprovalProofSchema.safeParse(meta?.['approval']);
    const check = await requireAuthority(ctx.db, {
      teamId: team.id,
      audience: team.slug,
      presenter: decider,
      credential: 'human',
      act: 'human_accept',
      target: laneId,
      payload: { lane: laneId, verdict: act },
      proof: proofParsed.success ? proofParsed.data : undefined,
      expectedOrigins: forwardedNodeId
        ? [ctx.config.webauthnNodeOrigins[forwardedNodeId]?.origin].filter(
            (origin): origin is string => typeof origin === 'string',
          )
        : ctx.config.webauthnOrigins,
      ...(forwardedNodeId ? { expectedNodeId: forwardedNodeId } : {}),
    });
    if (!check.ok) {
      log.info({ msg: 'authority_verdict_refused', lane: laneId, decider: decider.name });
      // Lane 01M5DTPMXN: the refusal goes back on the ack, not only into the audit — the
      // sender's surface must be able to say "that did not count" instead of answering
      // the ask away. `check.reason` is one of AUTHORITY_REFUSAL_REASONS.
      return { authorityRefused: { lane: laneId, reason: check.reason ?? 'no_signature' } };
    }
  }

  // ADR 644 §3: an accept closes the lane `done`, so it meets the same rule as any close: a lane
  // that reads on a day cannot close without a verdict. The refusal tells the acceptor why; the
  // owner gives the verdict (`lane_update {read_verdict}`) and the accept can be sent again.
  // Lane 01M5Z3NAJE: returned for the ack, not thrown — a throw here was caught by the caller and
  // logged, so the acceptor's ack came back clean and the lane sat unclosed with nobody told.
  if (act === 'accept') {
    try {
      decideReadVerdict(before, { state: 'done' });
    } catch (err) {
      if (!(err instanceof MusterdError)) throw err;
      log.info({ msg: 'acceptance_verdict_refused', lane: laneId, decider: decider.name });
      return { verdictRefused: readVerdictRefusal(before, repliedToId) };
    }
  }

  // ADR 585: the acceptor's independent re-check of the submitter's claims, run in the acceptor's
  // own clone and carried on the verdict act as `meta.claims`. Stamped with the decider's name
  // (never the body's), merged beside the submitter's reading, and written in the same guarded
  // transaction as the verdict so a claim row cannot exist without the close it belongs to.
  const checked = LaneClaimsSchema.safeParse(meta?.['claims']);
  const acceptorClaims = checked.success
    ? checked.data.map((c) => ({ ...c, checked_by: decider.name }))
    : undefined;
  // Guarded write: two verdicts racing on one lane (two acceptors, accept vs decline, or a board
  // PATCH) both pass the state check above; only the first may move the lane. The loser reads the
  // conflict as "already decided" — the same outcome the synchronous store gave it by ordering.
  let lane: Lane | null;
  try {
    lane = await updateLane(
      ctx.db,
      team.id,
      laneId,
      team.slug,
      {
        state: act === 'accept' ? 'done' : 'active',
        ...(acceptorClaims && acceptorClaims.length > 0 ? { claims: acceptorClaims } : {}),
      },
      Date.now(),
      { state: before.state, owner_seat: before.owner_seat },
      { actor: decider.name },
    );
  } catch (err) {
    if (err instanceof LaneConflictError) {
      log.info({ msg: 'acceptance_verdict_already_decided', lane: laneId, decider: decider.name });
      return {};
    }
    throw err;
  }
  if (!lane) return {};
  if (acceptorClaims && acceptorClaims.length > 0)
    await appendAudit(ctx.db, team.id, {
      actor: decider.name,
      action: 'lane.claims_verified',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        by: decider.name,
        ...summariseClaims(acceptorClaims),
        claims: acceptorClaims.map(({ kind, ref, verdict }) => ({ kind, ref, verdict })),
      },
    });

  if (act === 'accept') {
    await recordLaneClose(ctx.db, team.id, decider, before, lane);
    // ADR 271: the same fan-out the board's PATCH does. An incident closed by an acceptor's `accept`
    // owes its reporters exactly the same answer as one closed by a click — neither surface should
    // have to know the other exists. No-op for every ordinary lane.
    await announceIncidentResolved(ctx, team, lane, decider.name);
  } else {
    // ADR 192: an acceptor moving an awaiting_acceptance lane back to a live state is the rejection
    // — the counterpart said "not what we wanted". Audit action stays `lane.review_sent_back`
    // (frozen), and the reason rides along so a sent-back lane can be told from a manual reopen.
    const note = body.trim();
    await appendAudit(ctx.db, team.id, {
      actor: decider.name,
      action: 'lane.review_sent_back',
      target: lane.id,
      result: 'allow',
      // Keep the human's concrete rejection reason with the frozen audit action. Bound it like
      // peer findings: the message is already durable, but audit detail is used in reports and
      // must not become an unbounded copy of an arbitrary Act body.
      detail: {
        lane: lane.id,
        reviewer: decider.name,
        owner: before.owner_seat,
        ...(note ? { note: note.length > 500 ? `${note.slice(0, 500)}…` : note } : {}),
      },
    });
  }
  // The board-shape change the team sees, composed by the daemon (ADR 102) exactly as the PATCH
  // path composes it — same body, same meta, so a reader of the stream cannot tell which surface
  // the verdict arrived on, because it does not matter.
  const note =
    act === 'accept'
      ? {
          body: `[lane] resolved "${lane.title}"`,
          meta: { lane_resolve: { lane: lane.id, title: lane.title, state: lane.state } },
        }
      : {
          body: `[lane] "${lane.title}" → ${lane.state}`,
          meta: { lane_state: { lane: lane.id, title: lane.title, state: lane.state } },
        };
  await routeEnvelope(
    ctx,
    team,
    decider,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: decider.name,
      to: { kind: 'team' },
      act: 'message',
      body: note.body,
      meta: note.meta,
    }),
  );
  return { verdict: { lane: lane.id, state: act === 'accept' ? 'done' : 'active' } };
}

/**
 * Append the to-human ask stream's lifecycle rows (ADR 147). One row per event — the whole stream's
 * trace lives in the audit log, not in a new table, and the daemon fires no timeout (the agent owns the
 * clock, ADR 147 §2). The envelope is already schema-valid (`actMetaRules`), so the discriminating meta
 * is present when its act/field is; reads stay defensive anyway. Shapes only, never bodies (ADR 051).
 */
async function recordAskLifecycle(
  ctx: Ctx,
  team: TeamRow,
  actor: string,
  env: Envelope,
): Promise<void> {
  const meta = env.meta ?? {};
  // A new ask was raised — the species/tier that set its contract, and (if directed) whom it named.
  if (env.act === 'ask') {
    await appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.raised',
      target: env.to.kind === 'member' ? env.to.name : null,
      result: 'allow',
      detail: { species: meta['species'], tier: meta['tier'] },
    });
    return;
  }
  // The agent's no-answer resolution (rides `status_update`, ADR 147 §4): the timeout elapsed unanswered.
  const outcome = meta['ask_outcome'];
  const askRef = typeof meta['ask_ref'] === 'string' ? meta['ask_ref'] : null;
  if (outcome === 'held') {
    await appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.held',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef },
    });
    return;
  }
  // The strand terminal (ADR 153 §2): a top-tier ask with no reachable unblocker — the agent released
  // its lane (WIP recorded on the branch) and stopped, never proceeding. One append-only row makes the
  // dead-end queryable: "this seat legitimately could not proceed, and no unblocker existed."
  if (outcome === 'stranded') {
    await appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.stranded',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef, reason: 'no_reachable_unblocker' },
    });
    return;
  }
  if (outcome === 'risk_accepted') {
    await appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.risk_accepted',
      target: askRef,
      result: 'allow',
      // The record IS the risk-acceptance: what was risked, the approach taken, and that the human was
      // unreachable in the window — the auditable fact ADR 145 §3.1 promised, attributable to `actor`.
      detail: {
        ask_ref: askRef,
        risk: meta['risk'],
        chosen_approach: meta['chosen_approach'],
        human_unreachable: true,
      },
    });
    return;
  }
  // The human "deciding — check back in ⟨until⟩" reply (rides `wait`, ADR 147 §5).
  if (env.act === 'wait' && askRef) {
    await appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.deferred',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef, until: meta['until'] },
    });
  }
  // The recipient's own postponement (rides `wait`, ADR 211 §1). Distinct from `ask.deferred` above
  // in both actor and meaning: that one is the SENDER saying "deciding, check back"; this is the
  // RECIPIENT saying "not now, raise it when ⟨cond⟩".
  //
  // Detail is the condition KIND only. Not the lane id, not the body (ADR 051) — the eval needs the
  // split between condition kinds and the deferral→raise interval, and neither needs content. There
  // is deliberately no `raised` counterpart: a raise is derived at read time and has no event, and
  // emitting one would invent a fact the system does not have (ADR 189).
  const deferRef = meta['defer_ref'];
  if (env.act === 'wait' && typeof deferRef === 'string' && deferRef.length > 0) {
    const until = DeferUntilSchema.safeParse(meta['until']);
    if (until.success) {
      await appendAudit(ctx.db, team.id, {
        actor,
        action: 'inbox.deferred',
        target: deferRef,
        result: 'allow',
        detail: { until: 'reply' in until.data ? 'reply' : 'lane' },
      });
    }
  }
}

/**
 * ADR 490: a typed review request's thread is its own id, so the accept and the closing `resolve`
 * both land on it. An `accept` naming the request takes that thread when it carries none and is
 * refused when it names another; a `resolve` of the request must be Team-addressed, because the
 * close reaches requester and owner both — a private one would close the promise for one party only.
 */
async function threadReviewPromiseAct(ctx: Ctx, team: TeamRow, env: Envelope): Promise<Envelope> {
  const ref =
    env.act === 'accept' ? env.meta?.['in_reply_to'] : env.act === 'resolve' ? env.thread : null;
  if (typeof ref !== 'string' || !(await isTypedReviewRequest(ctx, team.id, ref))) return env;
  if (env.act === 'resolve') {
    if (env.to.kind === 'member') {
      throw new MusterdError(
        'validation',
        'a typed review request is resolved to @team, so requester and owner both see the close',
      );
    }
    return env;
  }
  if (env.thread === undefined || env.thread === null) return { ...env, thread: ref };
  if (env.thread !== ref) {
    throw new MusterdError(
      'validation',
      `an accept of typed review request ${ref} must be on its thread, not ${env.thread}`,
    );
  }
  return env;
}

async function isTypedReviewRequest(ctx: Ctx, teamId: string, id: string): Promise<boolean> {
  const row = await ctx.db.get<{ id: string }>(
    `SELECT id FROM messages
      WHERE team_id = ? AND id = ? AND act = 'request_help' AND thread_id IS NULL
        AND to_kind = 'member' AND json_extract(meta, '$.review') IS NOT NULL`,
    [teamId, id],
  );
  return row !== undefined;
}
