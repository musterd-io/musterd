import * as Haptics from 'expo-haptics';

/**
 * The app's touch feedback (ADR 760): a light tick under a press, a success buzz when something
 * lands (an answer sent, a phone paired). Feedback is a nicety, so a failure is swallowed.
 */
export function tap(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

export function success(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** A warning buzz: "I did not expect this" flags a teammate. */
export function warning(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}
