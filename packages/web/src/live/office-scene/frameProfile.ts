/**
 * Where a broadcast frame's main-thread time goes, by stage (lane 01M6S5V5DY).
 *
 * The stream box drew ~10 frames a second on 2026-11-06 against 24–29 in October, and reading the
 * 85 office changes in between could not rank the suspects (wall fixtures re-blitted every frame, the
 * window movers, the shell's rebakes). This puts a number on each stage instead. The scene marks the
 * end of each stage; the time since the previous mark is added to that stage's total. `stats()`
 * returns the totals and `musterd broadcast --perf` logs their per-second deltas, so
 * `musterd stream perf` reads them off the live box with no extra tooling.
 *
 * What it measures is JavaScript time on the main thread between marks. Canvas 2D calls may defer
 * part of their rasterisation to a flush at the end of the frame; that lands outside every stage and
 * shows as the gap between `frame` (the whole rAF interval) and the sum of the stages. Read a large
 * gap as raster and compositing work the marks cannot attribute, not as idle time.
 *
 * Broadcast only, and cheap: two `performance.now()` reads per stage, no allocation per frame.
 */

export interface FrameProfile {
  /** Start timing a stretch; the next `mark` measures from here. */
  begin(): void;
  /** Add the time since the last `begin`/`mark` to `stage`, and restart the clock. */
  mark(stage: string): void;
  /** Add `ms` to `stage` without touching the clock — for a span measured elsewhere (the rAF gap). */
  add(stage: string, ms: number): void;
  /** Frames this profile has covered (the scene counts one per drawn frame). */
  frames: number;
  /** Cumulative milliseconds per stage since the profile was made. */
  readonly totals: Readonly<Record<string, number>>;
}

export function makeFrameProfile(now: () => number = () => performance.now()): FrameProfile {
  const totals: Record<string, number> = {};
  let last = now();
  return {
    begin() {
      last = now();
    },
    mark(stage) {
      const t = now();
      totals[stage] = (totals[stage] ?? 0) + (t - last);
      last = t;
    },
    add(stage, ms) {
      totals[stage] = (totals[stage] ?? 0) + ms;
    },
    frames: 0,
    totals,
  };
}

/** A copy of `totals` rounded to 0.1 ms — what `stats()` hands out, so a sample stays small. */
export function profileSnapshot(totals: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(totals)) out[k] = Math.round(v * 10) / 10;
  return out;
}
