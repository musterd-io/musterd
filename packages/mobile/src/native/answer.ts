/**
 * An advisory answer from a notification action (ADR 676 decision 7).
 *
 * The action already asked for Face ID (`authenticationRequired`) and opened the app
 * (`foreground`). This function asks again: the signature is the Secure Enclave key, and a
 * notification action cannot present that prompt itself. Listed acts are refused here without
 * a signature — they have no notification action, and a forged one still must not sign.
 *
 * The seen-nonce store is not consulted. It blocks a second *display* of the same delivery;
 * the action is on the notification already on screen, so the seal is opened again from the
 * `musterd` userInfo the extension left in place.
 *
 * No pairing pin means the answer cannot be checked or sent, so Face ID is not prompted for
 * a signature that would be thrown away.
 */

import {
  AppAnswerSchema,
  AppCallbackSchema,
  appAnswerSigningBytes,
  type AppDelivery,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { b64urlEncode, utf8Encode } from './bytes';
import { DeliveryExpiredError, openDelivery } from './delivery';
import { STALE_TEXT, UNVERIFIED_TEXT } from './notice';
import { showOffer, type ShownOffer } from './offer';
import { RETRY_MS, sendOrKeep, type OutboxStorage } from './outbox';
import type { PairingPin } from './pairingPin';
import { phoneKeys, phoneKeysErrorCode } from './phoneKeys';
import { readFetchedBody, readPush, routeOf, type PushRoute } from './push';

export type AnswerOutcome =
  | 'sent'
  | 'unverified'
  | 'stale'
  | 'unpaired'
  | 'refused'
  | 'undelivered'
  | 'cancelled';

const FETCH_TIMEOUT_MS = 10_000;

export function outcomeNote(outcome: AnswerOutcome): string | null {
  switch (outcome) {
    case 'sent':
      return null;
    case 'unverified':
      return UNVERIFIED_TEXT;
    case 'stale':
      return STALE_TEXT;
    case 'unpaired':
      return 'Pair this phone before answering from a notification.';
    case 'refused':
      return 'This ask has to be answered in the app.';
    case 'undelivered':
      return 'Your answer hasn’t reached your team yet. musterd keeps trying while it’s open.';
    case 'cancelled':
      return 'Face ID did not confirm the answer.';
  }
}

function decisionFor(action: string): 'approve' | 'reject' | null {
  if (action === 'musterd.answer.approve') return 'approve';
  if (action === 'musterd.answer.reject') return 'reject';
  return null;
}

function answerable(delivery: AppDelivery): delivery is AppDelivery & { kind: 'ask' } {
  return (
    delivery.kind === 'ask' &&
    delivery.ask.action_class === 'advisory' &&
    delivery.approval === undefined
  );
}

export function samePlace(pin: PairingPin, route: PushRoute): boolean {
  // A pin written at pair time has no binding yet. An answer waits until the extension has
  // learned it from a verified delivery, and a missing binding is not a match for any route.
  return pin.binding !== undefined && pin.team === route.team && pin.binding === route.binding;
}

/** `https://relay.example/app/<team>/...`, never leaving the pin's origin. */
export function relayUrl(relay: string, path: string): string | null {
  const url = new URL(path, `${relay}/`);
  if (url.origin !== new URL(relay).origin) return null;
  return url.toString();
}

/**
 * Why a fetch came back empty: the relay's 404 means the daemon holds no live ask by that ref
 * (answered, expired, or not this phone's); anything else — a 503 or 504 while the daemon is
 * away or slow, a timeout, no network — means this phone could not reach it, and a retry may.
 */
export type FetchMiss = { miss: 'gone' | 'unreachable' };

export async function fetchBody(
  relay: string,
  route: PushRoute,
  fetchImpl: typeof fetch,
): Promise<
  | {
      route: PushRoute;
      sealed: NonNullable<ReturnType<typeof readPush>>['sealed'];
    }
  | FetchMiss
> {
  const url = relayUrl(
    relay,
    `app/${encodeURIComponent(route.team)}/body/${encodeURIComponent(route.binding)}/${encodeURIComponent(route.ref)}`,
  );
  if (!url) return { miss: 'unreachable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { miss: response.status === 404 ? 'gone' : 'unreachable' };
    const body = readFetchedBody(await response.json());
    if (!body) return { miss: 'unreachable' };
    return { route: routeOf(body), sealed: body.sealed };
  } catch {
    return { miss: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function answerNotification(input: {
  action: string;
  userInfo: unknown;
  pin: PairingPin | null;
  now?: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<AnswerOutcome> {
  const decision = decisionFor(input.action);
  if (!decision) return 'refused';
  if (!input.pin) return 'unpaired';
  const pin = input.pin;
  const push = readPush(input.userInfo);
  if (!push || !samePlace(pin, push)) return 'unverified';

  let resolved = push.sealed
    ? { route: routeOf(push), sealed: push.sealed }
    : await fetchBody(pin.relay, routeOf(push), input.fetchImpl ?? fetch);
  // A relay that answered nothing gets one more try; still nothing is `undelivered`, never
  // `unverified` — the ask may well be fine (2026-10-30).
  if ('miss' in resolved && resolved.miss === 'unreachable') {
    await new Promise((resolve) => setTimeout(resolve, input.pauseMs ?? RETRY_MS));
    resolved = await fetchBody(pin.relay, routeOf(push), input.fetchImpl ?? fetch);
    if ('miss' in resolved && resolved.miss === 'unreachable') return 'undelivered';
  }
  if ('miss' in resolved || !resolved.sealed) return 'unverified';
  if (!samePlace(pin, resolved.route)) return 'unverified';

  const now = input.now ?? Date.now();
  let delivery: AppDelivery;
  try {
    delivery = await openDelivery({
      sealed: resolved.sealed,
      route: resolved.route,
      pinnedIdentity: pin.identity,
      now,
    });
  } catch (error) {
    if (error instanceof DeliveryExpiredError) return 'stale';
    return 'unverified';
  }
  if (resolved.route.expires_at <= now) return 'stale';
  if (!answerable(delivery)) return 'refused';
  if (delivery.ask.id !== resolved.route.ref) return 'unverified';
  if (delivery.expires_at !== resolved.route.expires_at) return 'unverified';

  return sendAnswer({
    pin,
    route: resolved.route,
    delivery,
    decision,
    reported: false,
    now,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

/**
 * Sign, seal and POST one answer to a verified delivery — the notification action's tail, and
 * the whole of an answer from the app (lane 7h). The caller has opened the delivery and checked
 * it against `route`.
 *
 * - An advisory ask signs `appAnswerSigningBytes` once.
 * - A listed act (an `approval` on the delivery) signs the answer bytes and the descriptor the
 *   phone rebuilt for `decision` ({@link showOffer}), both under one Face ID, and names this
 *   phone's device key as the proof's `key_id`. A digest that does not match is never signed.
 * - `reported` ("I did not expect this", ADR 676 §8) rides only on a reject.
 */
export async function sendAnswer(input: {
  pin: PairingPin;
  route: PushRoute;
  delivery: AppDelivery & { kind: 'ask' };
  decision: 'approve' | 'reject';
  reported: boolean;
  now: number;
  fetchImpl?: typeof fetch;
  /** Tests only: where an undelivered answer is kept, and the pause before the second try. */
  outbox?: { storage: OutboxStorage; pauseMs: number };
}): Promise<AnswerOutcome> {
  const { pin, route, delivery, decision } = input;
  if (!samePlace(pin, route)) return 'unverified';
  const reported = input.reported && decision === 'reject';
  const message = appAnswerSigningBytes({
    team: route.team,
    binding: route.binding,
    ask: route.ref,
    token: delivery.token,
    decision,
    nonce: delivery.nonce,
    reported,
  });

  let offer: ShownOffer | null = null;
  if (delivery.approval) {
    if (!pin.device_key_id) return 'unpaired';
    offer = showOffer(delivery.approval[decision], { team: route.team, now: input.now });
    if (!offer) return 'unverified';
  } else if (delivery.ask.action_class !== 'advisory') {
    return 'refused';
  }

  let signatures: string[];
  try {
    signatures = offer
      ? await phoneKeys.signAll([message, offer.signingBytes])
      : [await phoneKeys.sign(message)];
  } catch (error) {
    if (phoneKeysErrorCode(error) === 'biometry-failed') return 'cancelled';
    return 'unverified';
  }
  const [signature, descriptorSignature] = signatures;
  if (!signature || (offer && !descriptorSignature)) return 'unverified';

  const answer = {
    v: 1 as const,
    token: delivery.token,
    decision,
    nonce: delivery.nonce,
    signature,
    ...(reported ? { reported: true } : {}),
    ...(offer && descriptorSignature && pin.device_key_id
      ? {
          approval: {
            key_id: pin.device_key_id,
            nonce: offer.descriptor.nonce,
            signature: descriptorSignature,
          },
        }
      : {}),
  };
  if (!AppAnswerSchema.safeParse(answer).success) return 'unverified';
  const resolved = { route };
  const routeJson = canonicalJson(resolved.route);
  let sealed;
  try {
    sealed = await phoneKeys.seal({
      recipientPublic: pin.receive,
      plaintext: JSON.stringify(answer),
      purpose: 'answer',
      aad: b64urlEncode(utf8Encode(routeJson)),
    });
  } catch {
    return 'unverified';
  }

  const callback = {
    app: 1 as const,
    kind: 'answer' as const,
    binding: resolved.route.binding,
    ref: resolved.route.ref,
    expires_at: resolved.route.expires_at,
    sealed,
  };
  if (!AppCallbackSchema.safeParse(callback).success) return 'unverified';
  const url = relayUrl(pin.relay, `app/${encodeURIComponent(resolved.route.team)}/callback`);
  if (!url) return 'unverified';
  // Twice now, then kept and re-sent on every open until the relay takes it (outbox.ts).
  const sent = await sendOrKeep(
    {
      url,
      body: JSON.stringify(callback),
      ref: resolved.route.ref,
      expires_at: resolved.route.expires_at,
    },
    {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.outbox ? { storage: input.outbox.storage, pauseMs: input.outbox.pauseMs } : {}),
    },
  );
  return sent ? 'sent' : 'undelivered';
}
