/**
 * The app side of a notification action (ADR 676 decision 7).
 *
 * `.foreground` launches the app, which may start after the action was delivered, so the
 * native module keeps the action until `takePendingAnswer` and also emits `onPendingAnswer`.
 * Subscribe first, then take, so a tap that landed during launch is not missed and a later
 * tap is not missed either. Expo Go has no native module: the caller imports this file
 * dynamically and ignores the rejection.
 */

import { answerNotification, outcomeNote, type AnswerOutcome } from './answer';
import { loadPairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';

export async function takeNotificationAnswer(): Promise<AnswerOutcome | null> {
  const pending = await phoneKeys.takePendingAnswer();
  if (!pending) return null;
  let userInfo: unknown = null;
  try {
    userInfo = JSON.parse(pending.userInfo);
  } catch {
    userInfo = null;
  }
  const pin = await loadPairingPin();
  return answerNotification({ action: pending.action, userInfo, pin });
}

/** Subscribe, drain anything already waiting, and report a sentence only when one is owed. */
export function watchNotificationAnswers(onNote: (note: string) => void): { remove(): void } {
  let alive = true;
  const report = (outcome: AnswerOutcome | null) => {
    if (!alive || !outcome) return;
    const note = outcomeNote(outcome);
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
