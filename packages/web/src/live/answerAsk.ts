import type { Envelope, MemberSummary } from '@musterd/protocol';
import { classifyAskAction } from '@musterd/protocol/wire';
import type { AskView } from './asks';
import { sendAct, sendActWithVerdict, type LiveConfig } from './client';

export type AnswerKind = 'accept' | 'decline' | 'deciding';

/**
 * Answer an ask the way the rail always has — one path for every surface that answers (the rail's
 * sheet; lane 01M6DBDSGH's "Waiting on you" card used it too until lane 01M6EP0ZR9 retired it). Lifted out of `AsksStrip`
 * unchanged so a verdict signed on the card is the same act as a verdict signed on the rail:
 *
 * - `deciding` sends the ADR 147 §5 deferral (`wait` + `ask_ref`, "check back in 1h").
 * - A human's verdict on a lane-review ask carries its passkey proof (ADR 662, lane 01M5DTPMXN);
 *   the daemon's refusal comes back as `error`, and the ask stays open.
 * - A privileged ask (`classifyAskAction`) from a human seat carries its proof too.
 * - Everything else is a plain accept/decline envelope; a picked option rides as the body.
 *
 * Returns the ack to fold into the local derivation so the card settles before the firehose copy
 * lands, or an `error` sentence for the surface to show. Throws on a transport failure.
 */
export async function answerAsk(
  cfg: LiveConfig,
  roster: readonly MemberSummary[],
  ask: AskView,
  kind: AnswerKind,
  body?: string,
): Promise<{ ack: Envelope } | { error: string }> {
  const to = { kind: 'member', name: ask.env.from } as const;
  const thread = ask.env.thread ?? ask.env.id;
  if (kind === 'deciding') {
    const ack = await sendAct(cfg, {
      act: 'wait',
      to,
      thread,
      body: 'deciding — check back in 1h',
      meta: { ask_ref: ask.env.id, until: '1h' },
    });
    return { ack };
  }
  const laneId = (ask.env.meta?.['lane_review'] as { lane?: unknown } | undefined)?.lane;
  const humanSeat = roster.find((m) => m.name === cfg.as)?.kind === 'human';
  if (typeof laneId === 'string' && humanSeat) {
    // Lazily loaded: a verdict is rare, and the ceremony code should not ride in every /live load.
    const { authorityProofForVerdict } = await import('./authorityProof');
    const proof = await authorityProofForVerdict(cfg, laneId, kind);
    const sent = await sendActWithVerdict(cfg, {
      act: kind,
      to,
      thread,
      ...(body ? { body } : {}),
      meta: { in_reply_to: ask.env.id, ...(proof ? { approval: proof } : {}) },
    });
    if (sent.lane_authority_refused) {
      // The same sentence the daemon's 403 would carry, so `refusalCopy` reads it the same way on
      // both paths (lane 01M6EPWAJP): the person gets the line, the record keeps the code and why.
      const r = sent.lane_authority_refused;
      return {
        error: `authority refused (${r.reason}): a verdict on a lane needs an A2 device signature (ADR 662)${r.why ? ` — ${r.why}` : ''}`,
      };
    }
    if (!sent.lane_verdict && !sent.lane_escalation) {
      return { error: 'that verdict did not move the lane — the ask is still open.' };
    }
    return { ack: sent.ack };
  }
  if (humanSeat && classifyAskAction(ask.env.meta) === 'privileged') {
    const { authorityProofForAsk } = await import('./authorityProof');
    const proof = await authorityProofForAsk(cfg, ask.env.id, kind);
    const ack = await sendAct(cfg, {
      act: kind,
      to,
      thread,
      ...(body ? { body } : {}),
      meta: { in_reply_to: ask.env.id, ...(proof ? { approval: proof } : {}) },
    });
    return { ack };
  }
  const ack = await sendAct(cfg, {
    act: kind,
    to,
    thread,
    // A picked option rides as the body (lane 01M511XNQC), so the record says which one.
    ...(body ? { body } : {}),
    meta: { in_reply_to: ask.env.id },
  });
  return { ack };
}
