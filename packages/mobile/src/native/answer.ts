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
      return 'The answer did not leave this phone.';
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

function samePlace(pin: PairingPin, route: PushRoute): boolean {
  // A pin written at pair time has no binding yet. An answer waits until the extension has
  // learned it from a verified delivery, and a missing binding is not a match for any route.
  return pin.binding !== undefined && pin.team === route.team && pin.binding === route.binding;
}

/** `https://relay.example/app/<team>/...`, never leaving the pin's origin. */
function relayUrl(relay: string, path: string): string | null {
  const url = new URL(path, `${relay}/`);
  if (url.origin !== new URL(relay).origin) return null;
  return url.toString();
}

async function fetchBody(
  relay: string,
  route: PushRoute,
  fetchImpl: typeof fetch,
): Promise<{
  route: PushRoute;
  sealed: NonNullable<ReturnType<typeof readPush>>['sealed'];
} | null> {
  const url = relayUrl(
    relay,
    `app/${encodeURIComponent(route.team)}/body/${encodeURIComponent(route.binding)}/${encodeURIComponent(route.ref)}`,
  );
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = readFetchedBody(await response.json());
    if (!body) return null;
    return { route: routeOf(body), sealed: body.sealed };
  } catch {
    return null;
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
}): Promise<AnswerOutcome> {
  const decision = decisionFor(input.action);
  if (!decision) return 'refused';
  if (!input.pin) return 'unpaired';
  const pin = input.pin;
  const push = readPush(input.userInfo);
  if (!push || !samePlace(pin, push)) return 'unverified';

  const resolved = push.sealed
    ? { route: routeOf(push), sealed: push.sealed }
    : await fetchBody(pin.relay, routeOf(push), input.fetchImpl ?? fetch);
  if (!resolved?.sealed) return 'unverified';
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

  const reported = false;
  const message = appAnswerSigningBytes({
    team: resolved.route.team,
    binding: resolved.route.binding,
    ask: resolved.route.ref,
    token: delivery.token,
    decision,
    nonce: delivery.nonce,
    reported,
  });
  let signature: string;
  try {
    signature = await phoneKeys.sign(message);
  } catch (error) {
    if (phoneKeysErrorCode(error) === 'biometry-failed') return 'cancelled';
    return 'unverified';
  }

  const answer = {
    v: 1 as const,
    token: delivery.token,
    decision,
    nonce: delivery.nonce,
    signature,
  };
  if (!AppAnswerSchema.safeParse(answer).success) return 'unverified';
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
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callback),
    });
    return response.status === 202 ? 'sent' : 'undelivered';
  } catch {
    return 'undelivered';
  }
}
