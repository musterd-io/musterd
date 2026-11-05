import {
  APP_QUICK_ACTION_WINDOW_MS,
  AppPollCloseSchema,
  AppPollOpenSchema,
  appPollCloseSigningBytes,
  appPollOpenSigningBytes,
  type AppCallback,
  type AppDelivery,
  type AppPollState,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { closeAndAnnounce, openAndAnnounce } from '../protocol/pollWatch.js';
import { spendAppQuickActionNonce, type AppKeys } from '../store/appPairing.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { getMemberById } from '../store/members.js';
import { openPollReply } from '../store/polls.js';
import { resolveCapabilities, type MemberRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
import { verifyPhoneSigned } from './appQuestion.js';
import { loadAppChannelKeys, openFromPhone } from './appSeal.js';

/**
 * Twitch polls from the phone (ADR 807 §5). A human admin's paired phone opens the team's poll
 * with a body signed by its Face ID key — an enrolled A2 device key, so that signature is the
 * `credential_mint` proof — or ends or cancels it with either phone key. The daemon then opens or
 * closes the poll through the same path `/live` and the CLI use, as the binding's person.
 *
 * The relay does not carry the daemon's answer back, so the outcome is kept on the binding and the
 * phone pulls it by {@link pollResultRef} (never pushed: the notification extension shows nothing
 * for it). Sealing the delivery is `appAdapter.ts`'s; this module imports nothing from it.
 */

type PollCallback = Extract<AppCallback, { kind: 'poll_open' | 'poll_close' }>;
type Op = 'open' | 'end' | 'cancel';

/** The relay ref the phone pulls a poll request's outcome by. */
export const pollResultRef = (nonce: string) => `poll-${nonce}`;
/** A poll result can be pulled for this long after the request. */
export const APP_POLL_RESULT_TTL_MS = 10 * 60_000;

/** The team's poll as the phone shows it: never the counts token. */
export async function appPollState(ctx: Ctx, teamId: string, now: number): Promise<AppPollState> {
  const reply = await openPollReply(ctx.db, teamId, { broadcast: false }, now);
  if (!reply.poll) return { live: reply.live, open: null, last: reply.last ?? null };
  const { poll_token: _token, ...open } = reply.poll;
  return { live: reply.live, open, last: reply.last ?? null };
}

/** A human admin, still on the team — the only person a phone may open or close a poll as. */
function admin(person: MemberRow | null | undefined): person is MemberRow {
  return (
    !!person &&
    person.kind === 'human' &&
    person.left_at === null &&
    resolveCapabilities(person).is_admin
  );
}

/** Keep this binding's last poll outcome, so the phone's pull of `poll-<nonce>` can read it. */
async function recordResult(
  ctx: Ctx,
  teamId: string,
  bindingId: string,
  result: { nonce: string; op: Op; ok: boolean; reason?: string; at: number },
): Promise<void> {
  await ctx.db.tx(async (t) => {
    const row = await t.get<{ app_keys: string | null }>(
      'SELECT app_keys FROM channel_bindings WHERE id = ? AND team_id = ?',
      [bindingId, teamId],
    );
    if (!row?.app_keys) return;
    const keys = JSON.parse(row.app_keys) as AppKeys & { poll_result?: unknown };
    await t.run('UPDATE channel_bindings SET app_keys = ? WHERE id = ? AND team_id = ?', [
      JSON.stringify({ ...keys, poll_result: result }),
      bindingId,
      teamId,
    ]);
  });
}

/**
 * Open, check and act on one poll callback. Every check that can refuse runs before the nonce is
 * spent, except the daemon's own refusals after it (not live, one already open): those are
 * answers, recorded for the phone like a success.
 */
export async function handleAppPoll(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  cb: PollCallback,
  now: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (cb.expires_at <= now || cb.expires_at > now + APP_QUICK_ACTION_WINDOW_MS)
    return { ok: false, reason: 'expired' };
  let opened: Uint8Array;
  try {
    opened = await openFromPhone({
      keys: await loadAppChannelKeys(),
      route: { team: team.slug, binding: binding.id, ref: cb.ref, expires_at: cb.expires_at },
      sealed: cb.sealed,
      purpose: cb.kind,
    });
  } catch {
    return { ok: false, reason: 'sealed_body' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(opened));
  } catch {
    return { ok: false, reason: 'bad_request' };
  }

  let op: Op;
  let signed: Awaited<ReturnType<typeof verifyPhoneSigned>>;
  let body:
    | { kind: 'open'; spec: Parameters<typeof openAndAnnounce>[3] }
    | { kind: 'close'; pollId: string; how: 'end' | 'cancel' };
  if (cb.kind === 'poll_open') {
    const p = AppPollOpenSchema.safeParse(raw);
    if (!p.success) return { ok: false, reason: 'bad_request' };
    if (p.data.nonce !== cb.ref) return { ok: false, reason: 'nonce_mismatch' };
    op = 'open';
    // The Face ID key only: opening mints the poll's credential (ADR 807 §5).
    signed = await verifyPhoneSigned(
      ctx,
      team.id,
      binding,
      keys,
      'signing',
      appPollOpenSigningBytes({
        team: team.slug,
        binding: binding.id,
        spec: p.data.spec,
        nonce: p.data.nonce,
        ts: p.data.ts,
      }),
      p.data.signature,
    );
    body = { kind: 'open', spec: p.data.spec };
  } else {
    const p = AppPollCloseSchema.safeParse(raw);
    if (!p.success) return { ok: false, reason: 'bad_request' };
    if (p.data.nonce !== cb.ref) return { ok: false, reason: 'nonce_mismatch' };
    op = p.data.how;
    signed = await verifyPhoneSigned(
      ctx,
      team.id,
      binding,
      keys,
      p.data.key,
      appPollCloseSigningBytes({
        team: team.slug,
        binding: binding.id,
        poll_id: p.data.poll_id,
        how: p.data.how,
        nonce: p.data.nonce,
        ts: p.data.ts,
      }),
      p.data.signature,
    );
    body = { kind: 'close', pollId: p.data.poll_id, how: p.data.how };
  }
  if (!signed.ok) return signed;

  const person = await getMemberById(ctx.db, binding.member_id);
  if (!admin(person)) return { ok: false, reason: 'not_admin' };
  const teamRow = await getTeamBySlug(ctx.db, team.slug);
  if (!teamRow) return { ok: false, reason: 'binding_stale' };
  const spent = await spendAppQuickActionNonce(ctx.db, team.id, binding.id, cb.ref);
  if (spent !== 'ok') return { ok: false, reason: spent };

  const answer = async (ok: boolean, reason?: string) => {
    await recordResult(ctx, team.id, binding.id, {
      nonce: cb.ref,
      op,
      ok,
      ...(reason ? { reason } : {}),
      at: now,
    });
    // The open and the close write their own audit rows (`poll.open`, `poll.close`).
    return ok ? { ok: true } : { ok: false, reason: reason! };
  };

  // The hub owns polls; a joiner's phone path has no proof to relay, so it says where to go.
  if (await joinerEnrollment(ctx.db, team.id, team.slug)) return answer(false, 'hub_only');

  try {
    if (body.kind === 'open') {
      await openAndAnnounce(ctx, teamRow, person, body.spec, 'A2', now);
    } else {
      const state = await openPollReply(ctx.db, team.id, { broadcast: false }, now);
      if (!state.poll || state.poll.id !== body.pollId) return answer(false, 'not_open');
      const record = await closeAndAnnounce(
        ctx,
        teamRow,
        body.pollId,
        body.how === 'end' ? 'ended' : 'cancelled',
        person,
        now,
      );
      if (!record) return answer(false, 'not_open');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not live on Twitch/i.test(msg)) return answer(false, 'not_live');
    if (/already open/i.test(msg)) return answer(false, 'already_open');
    throw err;
  }
  return answer(true);
}

/**
 * Rebuild a poll request's outcome for the phone's pull of `poll-<nonce>`: the recorded result for
 * that nonce and the poll as it stands now. Null for any other ref, an unknown nonce, or an old one.
 */
export async function fetchPollResult(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  ref: string,
  now: number,
): Promise<{ delivery: AppDelivery; expiresAt: number } | null> {
  if (!ref.startsWith('poll-')) return null;
  const nonce = ref.slice('poll-'.length);
  const kept = (keys as AppKeys & { poll_result?: Record<string, unknown> }).poll_result;
  if (!kept || kept['nonce'] !== nonce || typeof kept['at'] !== 'number') return null;
  const expiresAt = kept['at'] + APP_POLL_RESULT_TTL_MS;
  if (now >= expiresAt) return null;
  const op = kept['op'];
  if (op !== 'open' && op !== 'end' && op !== 'cancel') return null;
  return {
    expiresAt,
    delivery: {
      v: 1,
      kind: 'poll_result',
      team: team.slug,
      binding: binding.id,
      nonce,
      op,
      ok: kept['ok'] === true,
      ...(typeof kept['reason'] === 'string' ? { reason: kept['reason'] } : {}),
      poll: await appPollState(ctx, team.id, now),
    },
  };
}

/** The roster's poll field: only for a binding whose person is a human admin. */
export async function rosterPoll(
  ctx: Ctx,
  teamId: string,
  binding: ChannelBinding,
  now: number,
): Promise<AppPollState | undefined> {
  const person = await getMemberById(ctx.db, binding.member_id);
  return admin(person) ? appPollState(ctx, teamId, now) : undefined;
}
