/**
 * The phone's question key (ADR 774 §5) and the two things signed with it or for it.
 *
 * - **Enrollment**, once per binding: the question key's public point, signed by the Face ID
 *   signing key over `questionKeyEnrollBytes`. One Face ID prompt. The daemon then accepts the
 *   question key on answers to questions only.
 * - **An answer to a question**, signed by the question key over `appQuestionAnswerSigningBytes`,
 *   with no Face ID, so a notification action can answer while the phone is locked. The answer
 *   authorizes nothing (ADR 773 §6); approvals and verdicts keep the Face ID path in `answer.ts`.
 *
 * Sealing and sending both wait on the delivery shape and the `question_key` callback (seats ask
 * lane 1f). This file builds and signs; it does not send.
 */

import {
  AppQuestionAnswerSchema,
  AppQuestionKeyEnrollSchema,
  appQuestionAnswerSigningBytes,
  questionKeyEnrollBytes,
  type AppQuestionAnswer,
  type AppQuestionKeyEnroll,
} from '@musterd/protocol/app-channel';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';

type Answer = AppQuestionAnswer['answer'];

/** The enrollment for this phone's binding. Prompts Face ID once; null before pairing finishes. */
export async function buildQuestionKeyEnroll(input: {
  pin: PairingPin;
  nonce: string;
}): Promise<AppQuestionKeyEnroll | null> {
  const { pin, nonce } = input;
  if (!pin.binding) return null;
  const questionKey = await phoneKeys.questionPublicKey();
  const signature = await phoneKeys.sign(
    questionKeyEnrollBytes({
      team: pin.team,
      binding: pin.binding,
      question_key: questionKey,
      nonce,
    }),
  );
  const enroll = { v: 1, binding: pin.binding, question_key: questionKey, nonce, signature };
  const parsed = AppQuestionKeyEnrollSchema.safeParse(enroll);
  return parsed.success ? parsed.data : null;
}

/**
 * An answer to one question, signed silently by the question key. `token` and `nonce` are the
 * delivery's own; `ask` is the question's id. Null for an answer the wire would refuse.
 */
export async function signQuestionAnswer(input: {
  pin: PairingPin;
  ask: string;
  token: string;
  nonce: string;
  answer: Answer;
}): Promise<AppQuestionAnswer | null> {
  const { pin, ask, token, nonce, answer } = input;
  if (!pin.binding) return null;
  if (answer.choice === undefined && (answer.text === undefined || answer.text.length === 0))
    return null;
  const signature = await phoneKeys.signQuestion(
    appQuestionAnswerSigningBytes({
      team: pin.team,
      binding: pin.binding,
      ask,
      token,
      nonce,
      answer,
    }),
  );
  const parsed = AppQuestionAnswerSchema.safeParse({
    v: 1,
    token,
    answer,
    nonce,
    key: 'question',
    signature,
  });
  return parsed.success ? parsed.data : null;
}
