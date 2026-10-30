import {
  AnswerProofSchema,
  questionOf,
  type AnswerChannel,
  type AnswerProof,
  type Envelope,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendAudit } from '../store/audit.js';
import { claimAnswer, mayAnswer, questionView } from '../store/questions.js';
import type { MemberRow, TeamRow } from '../store/rows.js';

/**
 * The answer to a question ask (ADR 773 §4–§5): an `accept` carrying `meta.answer`. Before persist
 * the route calls {@link prepareQuestionAnswer}, which checks the target and the answerer, claims
 * the question (the first answer wins), and stamps the server's own `meta.answer_proof`.
 */

/**
 * The channel a direct (non-daemon-composed) send arrived on. `/live` labels its requests with
 * surface `web`; anything else a person sends with their own credential is the CLI. The label is
 * only a label: what makes the answer verified is the human credential the route already checked.
 */
export function directChannel(surface: string | undefined): AnswerChannel {
  return surface === 'web' ? 'live' : 'cli';
}

/** Strip a client's `answer_proof` — server-controlled, like `channel_answer` (ADR 773 §5). */
export function stripAnswerProof(env: Envelope, daemonComposed: boolean): Envelope {
  if (daemonComposed || !env.meta || !('answer_proof' in env.meta)) return env;
  const { answer_proof: _client, ...rest } = env.meta;
  return { ...env, meta: rest };
}

/**
 * Check and claim an answer, returning the envelope with its proof stamped. A daemon-composed
 * answer (the phone path, ADR 774) brings its own proof, which must parse; a direct send gets
 * `{channel, verified: sender is human, by}`.
 */
export async function prepareQuestionAnswer(
  db: Driver,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
  opts: { daemonComposed: boolean; surface?: string | undefined; now?: number },
): Promise<Envelope> {
  if (env.act !== 'accept' || env.meta?.['answer'] === undefined) return env;
  const questionId = env.meta['in_reply_to'];
  const view = typeof questionId === 'string' ? await questionView(db, team.id, questionId) : null;
  if (!view) {
    throw new MusterdError('bad_request', 'meta.answer answers a question ask only (ADR 773)');
  }
  if (env.to.kind !== 'member' || env.to.name !== view.asker) {
    // The asker is the answer's addressee: the ring and the wake follow `to` (ADR 773 §7).
    throw new MusterdError('bad_request', `an answer is addressed to the asker, ${view.asker}`);
  }
  // ADR 773 §2: questions go to people. A seat cannot answer one — not even a team question — or an
  // unverified answer would claim it ahead of the person it was for (first answer wins).
  if (sender.kind !== 'human') {
    throw new MusterdError('forbidden', 'a question is answered by a person, not a seat (ADR 773)');
  }
  if (!mayAnswer(view, sender.name)) {
    throw new MusterdError(
      'forbidden',
      `not_the_addressee: this question is for ${view.to ?? 'the team'} (ADR 773 §2)`,
    );
  }
  const stamped = opts.daemonComposed
    ? AnswerProofSchema.safeParse(env.meta['answer_proof'])
    : null;
  const late = view.state === 'withdrawn' || view.state === 'lane_closed';
  const proof: AnswerProof = stamped?.success
    ? { ...stamped.data, ...(late ? { late: true } : {}) }
    : {
        channel: directChannel(opts.surface),
        verified: sender.kind === 'human',
        by: sender.name,
        ...(late ? { late: true } : {}),
      };
  const claimed = await claimAnswer(db, team.id, {
    questionId: view.id,
    answerId: env.id,
    asker: view.asker,
    by: proof.by,
    channel: proof.channel,
    verified: proof.verified,
    late,
    at: opts.now ?? Date.now(),
  });
  if (!claimed.ok) {
    throw new MusterdError(
      'conflict',
      `question_already_answered: answered by ${claimed.by} on ${claimed.channel}`,
    );
  }
  return { ...env, meta: { ...env.meta, answer_proof: proof } };
}

/** After persist: the answer is durable, so now it is audited (ADR 773 Observability). */
export async function auditQuestionAnswer(db: Driver, team: TeamRow, env: Envelope): Promise<void> {
  const proof = AnswerProofSchema.safeParse(env.meta?.['answer_proof']);
  if (env.act !== 'accept' || !proof.success) return;
  await appendAudit(db, team.id, {
    actor: proof.data.by,
    action: 'question.answered',
    target: typeof env.meta?.['in_reply_to'] === 'string' ? env.meta['in_reply_to'] : null,
    result: 'allow',
    detail: {
      answer: env.id,
      channel: proof.data.channel,
      verified: proof.data.verified,
      late: proof.data.late === true,
    },
  });
}
