/**
 * The wind-down card's words and timing (lane 01M5GDACC0), pure so the stream and the tests read the
 * same sentence. The deadline comes from the daemon (`GET /teams/:slug/stream/winddown`), which holds
 * the same number the CLI stops the stream by — the card cannot promise a different time.
 */

/** The notice `stream stop` gives (mirrors the CLI's WIND_DOWN_MS); the sun's arc is drawn over it. */
export const WIND_DOWN_MS = 30 * 60_000;

export interface WindDownView {
  /** The sentence the stream shows. */
  text: string;
  /** 1 when the notice was just given, 0 at the deadline — how high the sun still sits. */
  daylight: number;
}

/** Null when no stop is queued or its deadline has passed (the stream is about to go anyway). */
export function windDownView(team: string, stopAt: number | null, now: number): WindDownView | null {
  if (stopAt === null || stopAt <= now) return null;
  const left = stopAt - now;
  const mins = Math.ceil(left / 60_000);
  const when = mins <= 1 ? 'in a minute' : `in ${mins} minutes`;
  return {
    text: `team ${team} will be ending its day ${when}`,
    daylight: Math.min(1, left / WIND_DOWN_MS),
  };
}

/** How long until the card next needs redrawing: each minute in the last five, else every five. */
export function nextRedrawMs(stopAt: number, now: number): number {
  const left = stopAt - now;
  const step = left <= 5 * 60_000 ? 60_000 : 5 * 60_000;
  // Land on the minute boundary the sentence changes at, not `step` after whenever we polled.
  const toBoundary = left % step || step;
  return Math.max(1_000, toBoundary);
}
