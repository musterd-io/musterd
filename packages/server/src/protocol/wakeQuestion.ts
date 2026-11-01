import { inferQuestion, makeEnvelope, type Question } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { checkInferredQuestion } from './questionAnswer.js';
import { routeEnvelope } from './route.js';

/**
 * ADR 783: the inferred-question catcher for a headless wake. The host carries the settled run's
 * last message on the supplementary wake report; when it ends on a question, the daemon raises it
 * as the seat, with the same check (ADR 781 §1) and the same rules (§3) as the turn-end hook. The
 * run is over, so nothing can be withdrawn later — the card closes when it is answered.
 *
 * Returns the ask's id, or null when there is no question or a rule refuses it (an agent seat only;
 * no other open question). Never throws: the wake report has already done its job.
 */
export async function raiseWakeQuestion(
  ctx: Ctx,
  team: TeamRow,
  seat: MemberRow,
  finalMessage: string,
  laneId?: string | null,
): Promise<string | null> {
  try {
    const inferred = inferQuestion(finalMessage);
    if (!inferred) return null;
    const question: Question = {
      ...inferred,
      ...(laneId ? { context: { lane: laneId } } : {}),
      blocking: false,
      audience: 'team',
      inferred: true,
    };
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: seat.name,
      to: { kind: 'team' },
      act: 'ask',
      body: finalMessage.trim(),
      meta: { species: 'consult', question },
    });
    await checkInferredQuestion(ctx.db, team, seat, env);
    await routeEnvelope(ctx, team, seat, env, undefined, true);
    return env.id;
  } catch {
    return null;
  }
}
