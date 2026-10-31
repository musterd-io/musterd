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
 * {@link enrollQuestionKey} sends the enrollment as the `question_key` callback, and
 * {@link sendQuestionAnswer} answers a question from the app. A notification's option or Reply is
 * answered natively instead (`QuestionAnswer.swift`), because the app is not in front for it.
 */

import {
  AppCallbackSchema,
  AppQuestionAnswerSchema,
  AppQuestionKeyEnrollSchema,
  appQuestionAnswerSigningBytes,
  questionKeyEnrollBytes,
  type AppQuestionAnswer,
  type AppQuestionKeyEnroll,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { relayUrl, samePlace, sealAndSend, type AnswerOutcome } from './answer';
import type { AskDelivery } from './asks';
import { b64urlEncode, utf8Encode } from './bytes';
import { post, RETRY_MS, type OutboxStorage } from './outbox';
import type { PairingPin } from './pairingPin';
import { phoneKeys, phoneKeysErrorCode } from './phoneKeys';
import type { PushRoute } from './push';

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
  /** `signing`: the Face ID key, for a phone whose question key is not enrolled yet. */
  key?: 'question' | 'signing';
}): Promise<AppQuestionAnswer | null> {
  const { pin, ask, token, nonce, answer } = input;
  const key = input.key ?? 'question';
  if (!pin.binding) return null;
  if (answer.choice === undefined && (answer.text === undefined || answer.text.length === 0))
    return null;
  const bytes = appQuestionAnswerSigningBytes({
    team: pin.team,
    binding: pin.binding,
    ask,
    token,
    nonce,
    answer,
  });
  const signature =
    key === 'question' ? await phoneKeys.signQuestion(bytes) : await phoneKeys.sign(bytes);
  const parsed = AppQuestionAnswerSchema.safeParse({
    v: 1,
    token,
    answer,
    nonce,
    key,
    signature,
  });
  return parsed.success ? parsed.data : null;
}

/** The daemon refuses an enrollment seal that expires more than 10 minutes out (ADR 774 §5). */
const ENROLL_WINDOW_MS = 10 * 60_000;
const ENROLL_AHEAD_MS = 9 * 60_000;

export type EnrollOutcome = 'enrolled' | 'cancelled' | 'unpaired' | 'failed';

/**
 * Whether this phone should enroll: paired, and the question key the daemon last heard of is not
 * this binding's current key (never enrolled, re-paired, or the key was re-created).
 */
export async function needsQuestionKey(pin: PairingPin | null): Promise<boolean> {
  if (!pin?.binding) return false;
  const enrolled = phoneKeys.questionEnrollment();
  if (!enrolled || enrolled.binding !== pin.binding) return true;
  return enrolled.key !== (await phoneKeys.questionPublicKey());
}

/**
 * Enroll this phone's question key: one Face ID, then the `question_key` callback. Each enrollment
 * has a fresh nonce and a seal expiry later than the last one's, both of which the daemon checks.
 * The relay's 202 is all the phone hears; it records the enrollment then, and the extension starts
 * giving questions their buttons.
 */
export async function enrollQuestionKey(input: {
  pin: PairingPin;
  now?: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<EnrollOutcome> {
  const { pin } = input;
  if (!pin.binding) return 'unpaired';
  const now = input.now ?? Date.now();
  const previous = phoneKeys.questionEnrollment();
  const expiresAt = Math.max(now + ENROLL_AHEAD_MS, (previous?.expires_at ?? 0) + 1);
  if (expiresAt > now + ENROLL_WINDOW_MS) return 'failed';
  let enroll: AppQuestionKeyEnroll | null;
  try {
    enroll = await buildQuestionKeyEnroll({ pin, nonce: await phoneKeys.randomNonce() });
  } catch (error) {
    return phoneKeysErrorCode(error) === 'biometry-failed' ? 'cancelled' : 'failed';
  }
  if (!enroll) return 'failed';
  const route = { team: pin.team, binding: pin.binding, ref: `qk-${enroll.nonce.slice(0, 16)}` };
  let sealed;
  try {
    sealed = await phoneKeys.seal({
      recipientPublic: pin.receive,
      plaintext: JSON.stringify(enroll),
      purpose: 'question_key',
      aad: b64urlEncode(utf8Encode(canonicalJson({ ...route, expires_at: expiresAt }))),
    });
  } catch {
    return 'failed';
  }
  const callback = {
    app: 1 as const,
    kind: 'question_key' as const,
    binding: route.binding,
    ref: route.ref,
    expires_at: expiresAt,
    sealed,
  };
  if (!AppCallbackSchema.safeParse(callback).success) return 'failed';
  const url = relayUrl(pin.relay, `app/${encodeURIComponent(pin.team)}/callback`);
  if (!url) return 'failed';
  const item = { url, body: JSON.stringify(callback), ref: route.ref, expires_at: expiresAt };
  let sent = await post(item, input.fetchImpl);
  if (!sent) {
    await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? RETRY_MS));
    sent = await post(item, input.fetchImpl);
  }
  if (!sent) return 'failed';
  phoneKeys.saveQuestionEnrollment(pin.binding, enroll.question_key, expiresAt);
  return 'enrolled';
}

/**
 * Answer a question from the app: an option, typed text, or both. Signed silently by the question
 * key once it is enrolled for this binding, and by the Face ID key before that; either way under
 * the question domain tag. Sent like any answer, and kept for the next open if the relay is down.
 */
export async function sendQuestionAnswer(input: {
  pin: PairingPin;
  route: PushRoute;
  delivery: AskDelivery;
  answer: Answer;
  fetchImpl?: typeof fetch;
  /** Tests only: where an undelivered answer is kept, and the pause before the second try. */
  outbox?: { storage: OutboxStorage; pauseMs: number };
}): Promise<AnswerOutcome> {
  const { pin, route, delivery, answer } = input;
  if (!samePlace(pin, route)) return 'unverified';
  const question = delivery.ask.question;
  if (!question) return 'refused';
  if (answer.choice !== undefined && answer.choice >= (question.options?.length ?? 0))
    return 'refused';
  const enrolled = phoneKeys.questionEnrollment();
  const silent =
    enrolled !== null &&
    enrolled.binding === pin.binding &&
    enrolled.key === (await phoneKeys.questionPublicKey());
  let signed: AppQuestionAnswer | null;
  try {
    signed = await signQuestionAnswer({
      pin,
      ask: route.ref,
      token: delivery.token,
      nonce: delivery.nonce,
      answer,
      key: silent ? 'question' : 'signing',
    });
  } catch (error) {
    return phoneKeysErrorCode(error) === 'biometry-failed' ? 'cancelled' : 'unverified';
  }
  if (!signed) return 'refused';
  return sealAndSend({
    pin,
    route,
    plaintext: JSON.stringify(signed),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.outbox ? { outbox: input.outbox } : {}),
  });
}
