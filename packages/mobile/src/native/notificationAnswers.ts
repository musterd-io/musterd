/**
 * The app side of a notification action (ADR 676 decision 7).
 *
 * `.foreground` launches the app, which may start after the action was delivered, so the
 * native module keeps the action until `takePendingAnswer` and also emits `onPendingAnswer`.
 * Subscribe first, then take, so a tap that landed during launch is not missed and a later
 * tap is not missed either. Expo Go has no native module: the caller imports this file
 * dynamically and ignores the rejection.
 */

import { answerNotification, outcomeNote, samePlace, type AnswerOutcome } from './answer';
import { openDelivery } from './delivery';
import { ACTION_OPEN } from './notice';
import { loadPairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import { readPush, routeOf, type PushRoute } from './push';

export type NotificationTap = { answered: AnswerOutcome } | { open: PushRoute } | null;

export async function takeNotificationAnswer(): Promise<NotificationTap> {
  const pending = await phoneKeys.takePendingAnswer();
  if (!pending) return null;
  let userInfo: unknown = null;
  try {
    userInfo = JSON.parse(pending.userInfo);
  } catch {
    userInfo = null;
  }
  const pin = await loadPairingPin();
  if (pending.action === ACTION_OPEN) {
    const push = readPush(userInfo);
    if (!push || !pin || !samePlace(pin, push)) return null;
    // An inline body says what it is; only an ask opens the ask screen. A body fetched by ref is
    // always an ask (held summaries and the paired notice ride inline).
    if (push.sealed) {
      try {
        const route = routeOf(push);
        const delivery = await openDelivery({
          sealed: push.sealed,
          route,
          pinnedIdentity: pin.identity,
        });
        if (delivery.kind !== 'ask') return null;
      } catch {
        return null;
      }
    }
    return { open: routeOf(push) };
  }
  return { answered: await answerNotification({ action: pending.action, userInfo, pin }) };
}

/**
 * Subscribe, drain anything already waiting, report a sentence only when one is owed, and hand a
 * plain tap's route to `onOpen`.
 */
export function watchNotificationAnswers(
  onNote: (note: string) => void,
  onOpen: (route: PushRoute) => void,
): { remove(): void } {
  let alive = true;
  const report = (tap: NotificationTap) => {
    if (!alive || !tap) return;
    if ('open' in tap) {
      onOpen(tap.open);
      return;
    }
    const note = outcomeNote(tap.answered);
    if (note) onNote(note);
  };
  const subscription = phoneKeys.addListener('onPendingAnswer', () => {
    void takeNotificationAnswer().then(report);
  });
  void takeNotificationAnswer().then(report);
  return {
    remove() {
      alive = false;
      subscription.remove();
    },
  };
}
