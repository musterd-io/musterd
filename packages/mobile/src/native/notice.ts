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

import type { AppDelivery, AppQuickAction, QuickActionResult } from '@musterd/protocol/app-channel';
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
/** A question this phone cannot answer from the lock screen (no key, or the daemon holds another). */
export const OPEN_HINT = 'Open musterd to answer';

export const ADVISORY_CATEGORY = 'musterd.ask.advisory';
export const ACTION_APPROVE = 'musterd.answer.approve';
export const ACTION_REJECT = 'musterd.answer.reject';
/**
 * A question's actions (ADR 773/774, `Question.swift`): its first three options as buttons and a
 * Reply field (which asks for an unlock first), answered in the background with the silent
 * question key. A question with options
 * gets a category of its own (`QUESTION_OPTIONS_CATEGORY_PREFIX` + its nonce); one without, Reply
 * only. Neither has actions until this binding's question key is enrolled.
 */
export const QUESTION_REPLY_CATEGORY = 'musterd.question';
export const QUESTION_OPTIONS_CATEGORY_PREFIX = 'musterd.question.options.';
export const ACTION_QUESTION_CHOICE_PREFIX = 'musterd.question.choice.';
export const ACTION_QUESTION_REPLY = 'musterd.question.reply';
export const QUESTION_BUTTONS_MAX = 3;
/** Said by a notification when a lock-screen answer could not reach the relay (QuestionAnswer.swift). */
export const QUESTION_UNDELIVERED_TEXT =
  'Your answer hasn’t reached your team yet. Open musterd to send it again.';

/** A plain tap on the notification (Apple's own identifier): open that ask, answer nothing. */
export const ACTION_OPEN = 'com.apple.UNNotificationDefaultActionIdentifier';

type QuickAction = AppQuickAction['action'];

/** The quick actions' button labels (ADR 779/792), in the order the app shows them. */
export const QUICK_ACTION_LABELS: Record<QuickAction, string> = {
  start: 'Start',
  check_inbox: 'Check inbox',
  check_pr: 'Check PR',
  resume: 'Resume',
  stop: 'Stop',
};

/** The order the buttons show in: Stop last. */
export const QUICK_ACTION_ORDER = Object.keys(QUICK_ACTION_LABELS) as QuickAction[];

/**
 * ADR 806: "Waiting on nick · 42m" — a seat's open question, as /live's card says it. `to` null is
 * a question to the team. The wait reads `now`, `2m`, `1h`, `3d`, the same steps as /live.
 */
export function waitingLine(waiting: { to: string | null; since: number }, now: number): string {
  const m = Math.floor(Math.max(0, now - waiting.since) / 60_000);
  const waited =
    m < 1
      ? 'now'
      : m < 60
        ? `${m}m`
        : m < 1440
          ? `${Math.floor(m / 60)}h`
          : `${Math.floor(m / 1440)}d`;
  return `Waiting on ${waiting.to ?? 'the team'} · ${waited}`;
}

/**
 * The actions that make sense for a seat as the roster shows it (nick, build 44: "shouldn't all
 * the buttons be contextual?"; build 45: "what happened to the check inbox and other actions?").
 * Check inbox and Resume are always there: a sleeping seat reads them when it wakes or comes back.
 * Start only for a seat that is not live, Stop only for one that is, Check PR only with a lane.
 * Start on a seat nothing can wake would do nothing now, so it is left off.
 */
export function seatActions(seat: {
  online: boolean;
  wakeable: boolean;
  lane: unknown;
}): QuickAction[] {
  const lane = seat.lane !== null;
  return [
    ...(!seat.online && seat.wakeable ? (['start'] as const) : []),
    'check_inbox',
    ...(lane ? (['check_pr'] as const) : []),
    'resume',
    ...(seat.online ? (['stop'] as const) : []),
  ];
}

export const ROSTER_TEXT = 'Seats updated.';

/** What a quick action did (ADR 791): `offline` means the steer waits in the seat's inbox. */
export function quickResultText(
  seat: string,
  action: QuickAction,
  result: QuickActionResult,
): string {
  const label = QUICK_ACTION_LABELS[action];
  return result === 'started'
    ? `${label} reached ${seat}.`
    : `${seat} is offline. ${label} waits in its inbox.`;
}

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
  /** This binding has an enrolled question key, so a question is answerable from here. */
  questionKey = false,
): Notice {
  if (verdict !== 'fresh' || routeExpiresAt <= now) {
    return { title: NOTICE_TITLE, body: STALE_TEXT, sound: false };
  }
  if (delivery.kind === 'ask' && delivery.ask.question) {
    const { question } = delivery.ask;
    const category = !questionKey
      ? undefined
      : question.options?.length
        ? `${QUESTION_OPTIONS_CATEGORY_PREFIX}${delivery.nonce}`
        : QUESTION_REPLY_CATEGORY;
    return {
      title: NOTICE_TITLE,
      body: question.text,
      ...(category ? { category, subtitle: ANSWER_HINT } : { subtitle: OPEN_HINT }),
      sound: delivery.ask.interruption !== 'passive',
    };
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
  // ADR 791: a quick action's result is data for the person who pressed it, not an alert. The
  // roster is never pushed (the app pulls it); a stray one lands quietly too.
  if (delivery.kind === 'quick_action_result')
    return {
      title: NOTICE_TITLE,
      body: quickResultText(delivery.seat, delivery.action, delivery.result),
      sound: false,
    };
  // ADR 807: a poll result is pulled too, never pushed; a stray one lands quietly.
  if (delivery.kind === 'roster' || delivery.kind === 'portrait' || delivery.kind === 'poll_result')
    return { title: NOTICE_TITLE, body: ROSTER_TEXT, sound: false };
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
