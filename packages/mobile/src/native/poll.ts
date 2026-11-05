/**
 * Twitch polls from the phone (ADR 807 §5).
 *
 * - **Start** is signed by the Face ID key — opening mints the poll's credential, so the silent
 *   question key never signs it — over `appPollOpenSigningBytes`, sealed with purpose `poll_open`.
 * - **End / Cancel** mint nothing, but they stop a live poll on stream, so Face ID signs them too
 *   (the question key's enclave guard signs only answers and quick actions). Purpose `poll_close`.
 * - **The outcome** is pulled, never pushed: the relay carries no answer back, so after sending the
 *   phone fetches `poll-<nonce>` until the daemon has handled it. The open poll itself rides the
 *   roster (`roster.poll`), present only for an admin's binding.
 */

import {
  AppCallbackSchema,
  AppPollCloseSchema,
  AppPollOpenSchema,
  appPollCloseSigningBytes,
  appPollOpenSigningBytes,
  type AppDelivery,
  type AppPollOpen,
  type AppPollState,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { fetchBody, relayUrl } from './answer';
import { b64urlEncode, utf8Encode } from './bytes';
import { openDelivery } from './delivery';
import { post, RETRY_MS } from './outbox';
import type { PairingPin } from './pairingPin';
import { phoneKeys, phoneKeysErrorCode } from './phoneKeys';

export type PollResult = AppDelivery & { kind: 'poll_result' };
export type PollSpec = AppPollOpen['spec'];
export type { AppPollState };

/** The daemon refuses a seal that expires more than 10 minutes out. */
const AHEAD_MS = 9 * 60_000;

export type PollSendOutcome =
  | { sent: true; nonce: string }
  | { sent: false; why: 'cancelled' | 'unpaired' | 'failed' };

/** Seal a signed body to the daemon and post it through the relay, twice at most. */
async function sendSealed(input: {
  pin: PairingPin & { binding: string };
  kind: 'poll_open' | 'poll_close';
  body: { nonce: string };
  expiresAt: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<boolean> {
  const { pin } = input;
  const route = { team: pin.team, binding: pin.binding, ref: input.body.nonce };
  let sealed;
  try {
    sealed = await phoneKeys.seal({
      recipientPublic: pin.receive,
      plaintext: JSON.stringify(input.body),
      purpose: input.kind,
      aad: b64urlEncode(utf8Encode(canonicalJson({ ...route, expires_at: input.expiresAt }))),
    });
  } catch {
    return false;
  }
  const callback = {
    app: 1 as const,
    kind: input.kind,
    binding: route.binding,
    ref: route.ref,
    expires_at: input.expiresAt,
    sealed,
  };
  if (!AppCallbackSchema.safeParse(callback).success) return false;
  const url = relayUrl(pin.relay, `app/${encodeURIComponent(pin.team)}/callback`);
  if (!url) return false;
  const item = {
    url,
    body: JSON.stringify(callback),
    ref: route.ref,
    expires_at: input.expiresAt,
  };
  if (await post(item, input.fetchImpl)) return true;
  await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? RETRY_MS));
  return post(item, input.fetchImpl);
}

/** Start a poll: Face ID signs the exact spec. */
export async function sendPollOpen(input: {
  pin: PairingPin;
  spec: PollSpec;
  now?: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<PollSendOutcome> {
  const { pin } = input;
  if (!pin.binding) return { sent: false, why: 'unpaired' };
  const now = input.now ?? Date.now();
  let body;
  try {
    const nonce = await phoneKeys.randomNonce();
    const signature = await phoneKeys.sign(
      appPollOpenSigningBytes({
        team: pin.team,
        binding: pin.binding,
        spec: input.spec,
        nonce,
        ts: now,
      }),
    );
    const parsed = AppPollOpenSchema.safeParse({
      v: 1,
      spec: input.spec,
      nonce,
      ts: now,
      signature,
    });
    if (!parsed.success) return { sent: false, why: 'failed' };
    body = parsed.data;
  } catch (error) {
    return {
      sent: false,
      why: phoneKeysErrorCode(error) === 'biometry-failed' ? 'cancelled' : 'failed',
    };
  }
  const ok = await sendSealed({
    pin: { ...pin, binding: pin.binding },
    kind: 'poll_open',
    body,
    expiresAt: now + AHEAD_MS,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.pauseMs !== undefined ? { pauseMs: input.pauseMs } : {}),
  });
  return ok ? { sent: true, nonce: body.nonce } : { sent: false, why: 'failed' };
}

/** End (the votes so far) or cancel (no winner) the open poll. */
export async function sendPollClose(input: {
  pin: PairingPin;
  pollId: string;
  how: 'end' | 'cancel';
  now?: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<PollSendOutcome> {
  const { pin } = input;
  if (!pin.binding) return { sent: false, why: 'unpaired' };
  const now = input.now ?? Date.now();
  let body;
  try {
    const nonce = await phoneKeys.randomNonce();
    const bytes = appPollCloseSigningBytes({
      team: pin.team,
      binding: pin.binding,
      poll_id: input.pollId,
      how: input.how,
      nonce,
      ts: now,
    });
    const key = 'signing' as const;
    const signature = await phoneKeys.sign(bytes);
    const parsed = AppPollCloseSchema.safeParse({
      v: 1,
      poll_id: input.pollId,
      how: input.how,
      nonce,
      ts: now,
      key,
      signature,
    });
    if (!parsed.success) return { sent: false, why: 'failed' };
    body = parsed.data;
  } catch (error) {
    return {
      sent: false,
      why: phoneKeysErrorCode(error) === 'biometry-failed' ? 'cancelled' : 'failed',
    };
  }
  const ok = await sendSealed({
    pin: { ...pin, binding: pin.binding },
    kind: 'poll_close',
    body,
    expiresAt: now + AHEAD_MS,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.pauseMs !== undefined ? { pauseMs: input.pauseMs } : {}),
  });
  return ok ? { sent: true, nonce: body.nonce } : { sent: false, why: 'failed' };
}

/**
 * Pull what a poll request did. The daemon handles the callback a moment after the relay's 202,
 * so this asks a few times; null when nothing came back in time.
 */
export async function fetchPollResult(input: {
  pin: PairingPin;
  nonce: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  tries?: number;
  pauseMs?: number;
}): Promise<PollResult | null> {
  const { pin } = input;
  if (!pin.binding) return null;
  const ref = `poll-${input.nonce}`;
  const tries = input.tries ?? 6;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, input.pauseMs ?? 1_000));
    const fetched = await fetchBody(
      pin.relay,
      { team: pin.team, binding: pin.binding, ref, expires_at: 0 },
      input.fetchImpl ?? fetch,
    );
    if ('miss' in fetched) {
      if (fetched.miss === 'ended') return null;
      continue;
    }
    const { route, sealed } = fetched;
    if (!sealed || route.team !== pin.team || route.binding !== pin.binding || route.ref !== ref)
      continue;
    try {
      const d = await openDelivery({
        sealed,
        route,
        pinnedIdentity: pin.identity,
        now: (input.now ?? Date.now)(),
      });
      if (d.kind === 'poll_result' && d.nonce === input.nonce) return d;
    } catch {
      // Not openable as ours: ask again.
    }
  }
  return null;
}

/** A refusal as the person reads it. */
export function pollReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'not_live':
      return 'Polls open while you’re live on Twitch.';
    case 'already_open':
      return 'A poll is already running.';
    case 'not_open':
      return 'That poll has already closed.';
    case 'not_admin':
      return 'Only a team admin can run polls.';
    case 'hub_only':
      return 'Polls run from the hub’s /live for now.';
    case 'bad_signature':
    case 'key_revoked':
      return 'This phone’s key wasn’t accepted. Pair again.';
    default:
      return 'That didn’t go through. Try again.';
  }
}
