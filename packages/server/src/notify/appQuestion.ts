import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  AppQuestionAnswerSchema,
  AppQuestionKeyEnrollSchema,
  appQuestionAnswerSigningBytes,
  makeEnvelope,
  questionKeyEnrollBytes,
  questionOf,
  type Answer,
  type AskTier,
  type Question,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { routeEnvelope } from '../protocol/route.js';
import { setAppQuestionKey, type AppKeys } from '../store/appPairing.js';
import { appendAudit } from '../store/audit.js';
import { getDeviceKey } from '../store/authority.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { getMemberById } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * The phone side of question asks (ADR 773/774), kept out of `appAdapter.ts` so the question path
 * reads on its own: what a delivery carries, how loud it is, enrolling the silent question key, and
 * an answer that goes through the ordinary send route — so the first-answer-wins claim, the proof
 * stamp and the wake are the same code `/live` uses.
 */

/** A question has no clock; its delivery token lives this long (ADR 773 §1). */
export const QUESTION_APP_TTL_MS = 7 * 24 * 60 * 60_000;
/** "No phone buzz while you are active on /live" — a web presence seen this recently. */
export const LIVE_ACTIVE_WINDOW_MS = 2 * 60_000;

/** The tier a question rides for the channel settings' gates: blocking pierces, others are advisory. */
export function questionTier(q: Question): AskTier {
  return q.blocking ? 'blocking' : 'advisory';
}

/** Whether a question buzzes (ADR 773 defaults): blocking, and the person is not on `/live`. */
export async function questionInterruption(
  ctx: Ctx,
  memberId: string,
  q: Question,
  now: number,
): Promise<'active' | 'passive'> {
  if (!q.blocking) return 'passive';
  const live = await ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND surface = 'web' AND last_seen_at >= ?`,
    [memberId, now - LIVE_ACTIVE_WINDOW_MS],
  );
  return (live?.n ?? 0) > 0 ? 'passive' : 'active';
}

/** The humans a question reaches: its addressee, or every person for a team question. */
export function questionAudience<M extends { name: string; kind: string }>(
  humans: M[],
  to: { kind: string; name?: string },
  q: Question,
): M[] {
  const people = humans.filter((m) => m.kind === 'human');
  if (q.audience === 'team' || to.kind !== 'member') return people;
  return people.filter((m) => m.name === to.name);
}

export { questionOf };

function p256(point: string): KeyObject {
  const raw = Buffer.from(point, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('not an uncompressed P-256 point');
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
}

function verifies(key: KeyObject, bytes: string, signature: string): boolean {
  try {
    return cryptoVerify(
      'sha256',
      Buffer.from(bytes, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** The binding's Face ID phone key, when it is still standing for this binding's member. */
async function phoneKey(
  ctx: Ctx,
  teamId: string,
  binding: ChannelBinding,
  keys: AppKeys,
): Promise<KeyObject | null> {
  const key = keys.device_key_id ? await getDeviceKey(ctx.db, teamId, keys.device_key_id) : null;
  if (!key || key.revokedAt !== null || key.kind !== 'phone' || key.memberId !== binding.member_id)
    return null;
  return createPublicKey({
    key: Buffer.from(key.publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Enroll the question key (ADR 774 §5). The enrollment is signed by the Face ID phone key — one
 * biometric evaluation, once — and names this binding, so it cannot be replayed onto another.
 */
export async function enrollQuestionKey(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  opened: Uint8Array,
  now: number,
): Promise<{ ok: boolean; reason?: string }> {
  const parsed = (() => {
    try {
      return AppQuestionKeyEnrollSchema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
      return null;
    }
  })();
  if (!parsed?.success || parsed.data.binding !== binding.id)
    return { ok: false, reason: 'bad_request' };
  const enroll = parsed.data;
  try {
    p256(enroll.question_key);
  } catch {
    return { ok: false, reason: 'bad_request' };
  }
  const signer = await phoneKey(ctx, team.id, binding, keys);
  if (!signer) return { ok: false, reason: 'key_revoked' };
  const bytes = questionKeyEnrollBytes({
    team: team.slug,
    binding: binding.id,
    question_key: enroll.question_key,
    nonce: enroll.nonce,
  });
  if (!verifies(signer, bytes, enroll.signature)) return { ok: false, reason: 'bad_signature' };
  if (!(await setAppQuestionKey(ctx.db, team.id, binding.id, enroll.question_key, now)))
    return { ok: false, reason: 'binding_stale' };
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'app.question_key_enrolled',
    target: binding.id,
    result: 'allow',
    detail: { replaced: keys.question_key !== undefined },
  });
  return { ok: true };
}

/**
 * Open a question answer's signature: the question key, or the Face ID phone key (a phone that
 * answered from inside the app). Either way the bytes carry this binding and this ask, under the
 * question domain tag, so nothing else can be passed off as one.
 */
export async function verifyQuestionAnswer(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  askId: string,
  opened: Uint8Array,
): Promise<
  | { ok: true; answer: ReturnType<typeof AppQuestionAnswerSchema.parse> }
  | { ok: false; reason: string }
> {
  const parsed = (() => {
    try {
      return AppQuestionAnswerSchema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
      return null;
    }
  })();
  if (!parsed?.success) return { ok: false, reason: 'bad_request' };
  const answer = parsed.data;
  const key =
    answer.key === 'question'
      ? keys.question_key
        ? p256(keys.question_key)
        : null
      : await phoneKey(ctx, team.id, binding, keys);
  if (!key) return { ok: false, reason: 'key_revoked' };
  const bytes = appQuestionAnswerSigningBytes({
    team: team.slug,
    binding: binding.id,
    ask: askId,
    token: answer.token,
    nonce: answer.nonce,
    answer: answer.answer,
  });
  if (!verifies(key, bytes, answer.signature)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, answer };
}

/**
 * Send the verified answer as the bound person, through the ordinary route. The route claims the
 * question (first answer wins — a `/live` answer seconds earlier makes this a 409) and wakes the
 * asker; this stamps the proof the route keeps for a daemon-composed answer.
 */
export async function sendQuestionAnswer(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  input: { askId: string; asker: string; answer: Answer; now: number },
): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }> {
  const person = await getMemberById(ctx.db, binding.member_id);
  if (!person || person.kind !== 'human') return { ok: false, reason: 'binding_stale' };
  const teamRow = await getTeamBySlug(ctx.db, team.slug);
  if (!teamRow) return { ok: false, reason: 'binding_stale' };
  const messageId = `app-${input.askId}-${input.now}`;
  try {
    await routeEnvelope(
      ctx,
      teamRow,
      person,
      makeEnvelope({
        id: messageId,
        team: team.slug,
        from: person.name,
        to: { kind: 'member', name: input.asker },
        act: 'accept',
        body: '',
        thread: input.askId,
        meta: {
          in_reply_to: input.askId,
          answer: input.answer,
          answer_proof: { channel: 'app', verified: true, by: person.name },
        },
        ts: input.now,
      }),
      undefined,
      true,
    );
  } catch (err) {
    if (err instanceof MusterdError && err.message.startsWith('question_already_answered'))
      return { ok: false, reason: 'question_already_answered' };
    if (err instanceof MusterdError) return { ok: false, reason: 'refused' };
    throw err;
  }
  return { ok: true, messageId };
}
