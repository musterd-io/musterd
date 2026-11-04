/**
 * The phone's quick actions and seat roster (ADR 791).
 *
 * - **The roster** is pulled, never pushed (ADR 791, amended 2026-11-03): `GET body/<binding>/
 *   roster-<ts>` with `ts` a little behind this phone's clock, because the daemon serves any `ts`
 *   at or before its own now and within ten minutes of it. It comes back sealed and signed like
 *   any delivery, so it is opened by the same composition (`delivery.ts`).
 * - **A quick action** is one seat and one action, signed silently by the question key once it is
 *   enrolled for this binding (nick, 2026-11-03: no Face ID for a quick action), and by the Face ID
 *   key before that. It is sealed with purpose `quick_action`, its ref is its nonce, and it is sent
 *   twice at most: an old press is not worth keeping for the next open.
 *
 * The result comes back as a `quick_action_result` push, which the extension renders quietly.
 */

import {
  AppCallbackSchema,
  AppQuickActionSchema,
  appQuickActionSigningBytes,
  portraitRef,
  type AppDelivery,
  type AppQuickAction,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { fetchBody, relayUrl, type FetchMiss } from './answer';
import { b64urlEncode, utf8Encode } from './bytes';
import { openDelivery } from './delivery';
import { post, RETRY_MS } from './outbox';
import type { PairingPin } from './pairingPin';
import { phoneKeys, phoneKeysErrorCode } from './phoneKeys';

export type QuickAction = AppQuickAction['action'];
export type Roster = AppDelivery & { kind: 'roster' };
export type RosterSeat = Roster['seats'][number];

/** How far behind this phone's clock the roster ref is, so a daemon clock a little slow still serves it. */
export const ROSTER_SKEW_MS = 30_000;
/** The daemon refuses a seal that expires more than 10 minutes out (`APP_QUICK_ACTION_WINDOW_MS`). */
const QUICK_AHEAD_MS = 9 * 60_000;

/** The team's agent seats as of now, or why not. */
export async function fetchRoster(input: {
  pin: PairingPin;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<Roster | FetchMiss> {
  const { pin } = input;
  if (!pin.binding) return { miss: 'gone' };
  const now = input.now ?? Date.now();
  const ref = `roster-${now - ROSTER_SKEW_MS}`;
  const fetched = await fetchBody(
    pin.relay,
    { team: pin.team, binding: pin.binding, ref, expires_at: 0 },
    input.fetchImpl ?? fetch,
  );
  if ('miss' in fetched) return fetched;
  const { route, sealed } = fetched;
  if (!sealed) return { miss: 'gone' };
  if (route.team !== pin.team || route.binding !== pin.binding || route.ref !== ref)
    return { miss: 'gone' };
  try {
    const delivery = await openDelivery({
      sealed,
      route,
      pinnedIdentity: pin.identity,
      now,
    });
    return delivery.kind === 'roster' ? delivery : { miss: 'gone' };
  } catch {
    return { miss: 'gone' };
  }
}

/** ADR 797: portraits this app has opened, by digest, for the life of the app. */
const portraits = new Map<string, string>();

/**
 * A seat's portrait (ADR 797) as a `data:` URI, fetched once per digest through the relay and kept
 * for the life of the app. Null when the daemon has no such picture or it could not be fetched; the
 * seat keeps its letter.
 */
export async function fetchPortrait(input: {
  pin: PairingPin;
  digest: string;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const held = portraits.get(input.digest);
  if (held) return held;
  const { pin } = input;
  if (!pin.binding) return null;
  const ref = portraitRef(input.digest);
  const fetched = await fetchBody(
    pin.relay,
    { team: pin.team, binding: pin.binding, ref, expires_at: 0 },
    input.fetchImpl ?? fetch,
  );
  if ('miss' in fetched || !fetched.sealed) return null;
  const { route, sealed } = fetched;
  if (route.team !== pin.team || route.binding !== pin.binding || route.ref !== ref) return null;
  try {
    const delivery = await openDelivery({
      sealed,
      route,
      pinnedIdentity: pin.identity,
      now: input.now ?? Date.now(),
    });
    if (delivery.kind !== 'portrait' || delivery.digest !== input.digest) return null;
    const b64 = delivery.png.replace(/-/g, '+').replace(/_/g, '/');
    const uri = `data:image/png;base64,${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
    portraits.set(input.digest, uri);
    return uri;
  } catch {
    return null;
  }
}

export type QuickOutcome = 'sent' | 'cancelled' | 'unpaired' | 'failed';

/** Whether this binding's question key is enrolled, so the action is signed with no Face ID. */
async function silentKey(pin: PairingPin): Promise<boolean> {
  const enrolled = phoneKeys.questionEnrollment();
  return (
    enrolled !== null &&
    enrolled.binding === pin.binding &&
    enrolled.key === (await phoneKeys.questionPublicKey())
  );
}

/** One quick action for one seat. The relay's 202 is all the phone hears; the result is pushed. */
export async function sendQuickAction(input: {
  pin: PairingPin;
  seat: string;
  action: QuickAction;
  now?: number;
  fetchImpl?: typeof fetch;
  /** The pause before the second try; tests pass 0. */
  pauseMs?: number;
}): Promise<QuickOutcome> {
  const { pin, seat, action } = input;
  if (!pin.binding) return 'unpaired';
  const now = input.now ?? Date.now();
  const expiresAt = now + QUICK_AHEAD_MS;
  let body: AppQuickAction;
  try {
    const nonce = await phoneKeys.randomNonce();
    let key: 'question' | 'signing' = (await silentKey(pin)) ? 'question' : 'signing';
    const bytes = appQuickActionSigningBytes({
      team: pin.team,
      binding: pin.binding,
      seat,
      action,
      nonce,
      ts: now,
    });
    let signature: string;
    try {
      signature =
        key === 'question' ? await phoneKeys.signQuestion(bytes) : await phoneKeys.sign(bytes);
    } catch (error) {
      // A question key that will not sign this (an older native build, or a key the enclave lost)
      // falls back to Face ID rather than failing the press.
      if (key !== 'question') throw error;
      key = 'signing';
      signature = await phoneKeys.sign(bytes);
    }
    const parsed = AppQuickActionSchema.safeParse({
      v: 1,
      seat,
      action,
      nonce,
      ts: now,
      key,
      signature,
    });
    if (!parsed.success) return 'failed';
    body = parsed.data;
  } catch (error) {
    return phoneKeysErrorCode(error) === 'biometry-failed' ? 'cancelled' : 'failed';
  }
  const route = { team: pin.team, binding: pin.binding, ref: body.nonce };
  let sealed;
  try {
    sealed = await phoneKeys.seal({
      recipientPublic: pin.receive,
      plaintext: JSON.stringify(body),
      purpose: 'quick_action',
      aad: b64urlEncode(utf8Encode(canonicalJson({ ...route, expires_at: expiresAt }))),
    });
  } catch {
    return 'failed';
  }
  const callback = {
    app: 1 as const,
    kind: 'quick_action' as const,
    binding: route.binding,
    ref: route.ref,
    expires_at: expiresAt,
    sealed,
  };
  if (!AppCallbackSchema.safeParse(callback).success) return 'failed';
  const url = relayUrl(pin.relay, `app/${encodeURIComponent(pin.team)}/callback`);
  if (!url) return 'failed';
  const item = { url, body: JSON.stringify(callback), ref: route.ref, expires_at: expiresAt };
  if (await post(item, input.fetchImpl)) return 'sent';
  await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? RETRY_MS));
  return (await post(item, input.fetchImpl)) ? 'sent' : 'failed';
}
