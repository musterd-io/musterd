/**
 * What a verified delivery becomes on the lock screen (ADR 676 decisions 3, 7 and 8).
 *
 * The extension cannot run this file. `modules/musterd-keys/ios/extension/Notice.swift` is the
 * copy, and `swift-drift.test.ts` pins the sentences so the two cannot drift apart. The
 * category and action identifiers are the same strings the app registers with
 * `UNUserNotificationCenter`.
 *
 * A listed act (privileged, or an advisory ask that also carries an approval) gets no actions:
 * the tap only opens the app. An advisory ask with no approval gets Approve and Decline.
 * Either action still takes Face ID, and the enclave signature takes it again in the app —
 * a notification action cannot present the Secure Enclave prompt itself.
 */

import type { AppDelivery } from '@musterd/protocol/app-channel';
import type { NonceVerdict } from './nonceStore';

/** Decision 3's one sentence, in the app. Which check failed is an oracle and is never said. */
export const UNVERIFIED_TEXT = 'an ask could not be verified';

/**
 * The lock screen's fallback when the extension's check refuses (ADR 777): the app fetches the ask
 * again and checks it fully, so the way on is always to open it.
 */
export const LOCK_SCREEN_FALLBACK_TEXT = 'New ask — open musterd to see it.';

/**
 * Replay and expiry. The extension cannot withdraw an alert — Apple delivers the original
 * placeholder if the replacement body is empty — so a dropped delivery still has to say
 * something, and it must not be the unverified sentence.
 */
export const STALE_TEXT = 'This ask is no longer available.';

export const NOTICE_TITLE = 'musterd';

/** On an ask with lock-screen actions: they only show on a press and hold (nick, 2026-10-29). */
export const ANSWER_HINT = 'Press and hold to answer';

export const ADVISORY_CATEGORY = 'musterd.ask.advisory';
export const ACTION_APPROVE = 'musterd.answer.approve';
export const ACTION_REJECT = 'musterd.answer.reject';
/** A plain tap on the notification (Apple's own identifier): open that ask, answer nothing. */
export const ACTION_OPEN = 'com.apple.UNNotificationDefaultActionIdentifier';

export interface Notice {
  title: string;
  body: string;
  subtitle?: string;
  /** Set only for an advisory ask that can be answered from the notification. */
  category?: string;
  sound: boolean;
}

/** Before the nonce store is touched: a route expiry or an undrawable body is not consumed. */
export function gateBeforeNonce(
  delivery: AppDelivery,
  routeExpiresAt: number,
  now: number,
): 'open' | 'stale' | 'unverified' {
  if (routeExpiresAt <= now) return 'stale';
  if (delivery.kind === 'ask' && delivery.ask.body === '') return 'unverified';
  if (delivery.kind === 'paired' && delivery.member === '') return 'unverified';
  return 'open';
}

export function heldBody(count: number): string {
  return count === 1 ? '1 ask is held.' : `${count} asks are held.`;
}

export function waitingSubtitle(waiting: number): string | undefined {
  if (waiting === 1) return '1 more waiting';
  if (waiting > 1) return `${waiting} more waiting`;
  return undefined;
}

export function noticeFor(
  delivery: AppDelivery,
  verdict: NonceVerdict,
  routeExpiresAt: number,
  now: number,
): Notice {
  if (verdict !== 'fresh' || routeExpiresAt <= now) {
    return { title: NOTICE_TITLE, body: STALE_TEXT, sound: false };
  }
  if (delivery.kind === 'ask') {
    if (delivery.ask.body === '')
      return { title: NOTICE_TITLE, body: LOCK_SCREEN_FALLBACK_TEXT, sound: false };
    const category =
      delivery.ask.action_class === 'advisory' && delivery.approval === undefined
        ? ADVISORY_CATEGORY
        : undefined;
    const waiting = waitingSubtitle(delivery.waiting ?? 0);
    const subtitle = category ? (waiting ? `${ANSWER_HINT} · ${waiting}` : ANSWER_HINT) : waiting;
    return {
      title: NOTICE_TITLE,
      body: delivery.ask.body,
      ...(subtitle ? { subtitle } : {}),
      ...(category ? { category } : {}),
      sound: true,
    };
  }
  if (delivery.kind === 'held') {
    return { title: NOTICE_TITLE, body: heldBody(delivery.count), sound: true };
  }
  if (delivery.member === '')
    return { title: NOTICE_TITLE, body: LOCK_SCREEN_FALLBACK_TEXT, sound: false };
  return { title: NOTICE_TITLE, body: `Paired as ${delivery.member}.`, sound: true };
}

export function unverifiedNotice(): Notice {
  return { title: NOTICE_TITLE, body: LOCK_SCREEN_FALLBACK_TEXT, sound: false };
}

export function staleNotice(): Notice {
  return { title: NOTICE_TITLE, body: STALE_TEXT, sound: false };
}

/**
 * The asks list's Diagnostics line (ADR 777): lock-screen refusals in the last 24 hours, with their
 * reasons in first-seen order. Null when there were none.
 */
export function refusalLine(
  refusals: { reason: string; at: number }[],
  now: number,
): string | null {
  const recent = refusals.filter((r) => r.at > now - 24 * 3_600_000 && r.at <= now);
  if (recent.length === 0) return null;
  const reasons = [...new Set(recent.map((r) => r.reason))].join(', ');
  const count =
    recent.length === 1
      ? '1 lock-screen check failed'
      : `${recent.length} lock-screen checks failed`;
  return `Diagnostics: ${count} today (${reasons})`;
}
