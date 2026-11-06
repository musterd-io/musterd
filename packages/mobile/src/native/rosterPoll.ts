/** ADR 814 decision 4: how often the Now screen pulls the roster while it is in front. */
export const ROSTER_POLL_MS = 30_000;

/**
 * When the next pull is due, in ms from `now`: 0 means now, null means not while this holds. The
 * schedule is pure so the rule is tested without a clock: no pull while another screen is in
 * front (the ask screen holds a token the pull would re-issue) or while the app is in the
 * background; otherwise the rest of the interval since the last pull.
 */
export function nextPollDelay(
  state: { focused: boolean; appActive: boolean; lastAt: number },
  now: number,
  intervalMs: number,
): number | null {
  if (!state.focused || !state.appActive) return null;
  return Math.max(0, state.lastAt + intervalMs - now);
}
