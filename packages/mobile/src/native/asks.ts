/**
 * The asks list's data (ADR 676 decisions 7–9, lane 7h).
 *
 * Where the list comes from: Notification Center holds what the extension admitted, each with
 * its route. Those refs say which asks reached this phone — they do not say which are still
 * open, because an ask answered on /live or in Slack leaves its notification behind. So each
 * ref is fetched through the relay (`GET /app/<team>/body/<binding>/<ref>`), and the daemon
 * answers only for an ask still live on this binding, with a fresh token (the one it replaces is
 * spent). The daemon stays the source of truth; nothing here stores an ask.
 *
 * A missed push is not a lost ask: on open the app sends `redeliver`, and the daemon re-pushes
 * this binding's pending set. Those land as new notifications and refresh the list.
 *
 * A `held` summary (decision 8's hourly ceiling) carries no ask and is not fetched; the newest
 * one still inside its hour is shown as a line.
 */

import { AppCallbackSchema, type AppDelivery } from '@musterd/protocol/app-channel';
import { fetchBody, relayUrl, samePlace } from './answer';
import { openDelivery } from './delivery';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import { readPush, routeOf, type PushRoute } from './push';

export type AskDelivery = AppDelivery & { kind: 'ask' };

export interface AskEntry {
  route: PushRoute;
  delivery: AskDelivery;
}

export interface AsksView {
  /** Open asks, newest first. A listed act carries `delivery.waiting`. */
  asks: AskEntry[];
  /** Listed-act asks the hourly ceiling is holding, while the hour lasts. */
  held: { count: number; until: number } | null;
}

/** Open one sealed body against the pin; null for anything that does not verify or is late. */
async function open(
  pin: PairingPin,
  route: PushRoute,
  sealed: Parameters<typeof openDelivery>[0]['sealed'],
  now: number,
): Promise<AppDelivery | null> {
  if (!samePlace(pin, route) || route.expires_at <= now) return null;
  try {
    return await openDelivery({ sealed, route, pinnedIdentity: pin.identity, now });
  } catch {
    // Unverified and expired alike: neither is listed. The extension already said which.
    return null;
  }
}

/** Fetch one ask by ref and open it. Null when the daemon no longer has it live for this phone. */
export async function fetchAsk(input: {
  pin: PairingPin;
  route: PushRoute;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<AskEntry | null> {
  const now = input.now ?? Date.now();
  if (!samePlace(input.pin, input.route)) return null;
  const fetched = await fetchBody(input.pin.relay, input.route, input.fetchImpl ?? fetch);
  if (!fetched?.sealed) return null;
  const delivery = await open(input.pin, fetched.route, fetched.sealed, now);
  if (!delivery || delivery.kind !== 'ask') return null;
  if (delivery.ask.id !== fetched.route.ref || delivery.ask.id !== input.route.ref) return null;
  if (delivery.expires_at !== fetched.route.expires_at) return null;
  return { route: fetched.route, delivery };
}

export async function loadAsks(input: {
  pin: PairingPin;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<AsksView> {
  const now = input.now ?? Date.now();
  const { pin } = input;
  let delivered: Awaited<ReturnType<typeof phoneKeys.deliveredPushes>>;
  try {
    delivered = await phoneKeys.deliveredPushes();
  } catch {
    return { asks: [], held: null };
  }

  // One route per ref — the newest notification's — and the newest held summary.
  const refs = new Map<string, { route: PushRoute; at: number }>();
  let held: AsksView['held'] = null;
  let heldAt = -1;
  for (const item of delivered) {
    let userInfo: unknown;
    try {
      userInfo = JSON.parse(item.userInfo);
    } catch {
      continue;
    }
    const push = readPush(userInfo);
    if (!push || !samePlace(pin, push)) continue;
    const route = routeOf(push);
    if (push.sealed) {
      // Only a held summary is read from the notification itself; an ask is always re-fetched.
      const opened = await open(pin, route, push.sealed, now);
      if (opened?.kind === 'held') {
        if (opened.until > now && item.deliveredAt > heldAt) {
          held = { count: opened.count, until: opened.until };
          heldAt = item.deliveredAt;
        }
        continue;
      }
      if (opened && opened.kind !== 'ask') continue;
    }
    const seen = refs.get(route.ref);
    if (!seen || item.deliveredAt > seen.at) refs.set(route.ref, { route, at: item.deliveredAt });
  }

  const fetched = await Promise.all(
    [...refs.values()].map(({ route }) =>
      fetchAsk({
        pin,
        route,
        now,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      }),
    ),
  );
  const asks = fetched
    .filter((entry): entry is AskEntry => entry !== null)
    .sort((a, b) => b.delivery.ask.ts - a.delivery.ask.ts);
  return { asks, held };
}

/** Opening the app fires both a first focus and a foreground; one re-push serves both. */
const REDELIVER_GAP_MS = 60_000;
let lastRedeliver = 0;

/**
 * Ask the daemon, through the relay, to re-push this binding's pending set (ADR 676 decision 9).
 * The relay answers 202 whatever the daemon does; the result comes back as notifications. At most
 * one request a minute: each one re-pushes every pending ask.
 */
export async function requestRedelivery(input: {
  pin: PairingPin;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<boolean> {
  const { pin } = input;
  if (!pin.binding) return false;
  const now = input.now ?? Date.now();
  if (now - lastRedeliver < REDELIVER_GAP_MS) return false;
  lastRedeliver = now;
  const callback = { app: 1 as const, kind: 'redeliver' as const, binding: pin.binding };
  if (!AppCallbackSchema.safeParse(callback).success) return false;
  const url = relayUrl(pin.relay, `app/${encodeURIComponent(pin.team)}/callback`);
  if (!url) return false;
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callback),
    });
    return response.status === 202;
  } catch {
    return false;
  }
}
