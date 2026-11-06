/**
 * How much simulated time one drawn frame advances the office by.
 *
 * The office steps walks, gestures, the pet, the receptionist and act cues by the wall time since the
 * last drawn frame. Until 2026-11-06 that step was capped at 50 ms (the cap dates from the first
 * walking office, ADR 079, July 2026), so the room kept wall time only while the page drew at least
 * 20 frames a second. A desktop browser always does; the stream box does not. It has no GPU, composites
 * in software and grabs and encodes the screen on the same four cores, and it has measured 17–29 page
 * draws a second (docs/perf/broadcast-baseline.md). Below 20 a second the clock fell behind: at 15
 * draws a second the room ran at 75% speed, and an act, which adds work to every frame, pushed it
 * slower still. nick saw it on the stream as fans, bubbles and walkers in slow motion that got slower
 * on every event (lane 01M6S4FE8C).
 *
 * A slow page should look choppier, not slower. The cap is still worth having, because a frame that
 * arrives after the main thread was blocked for seconds should not teleport every walker across the
 * room, but it sits at 250 ms, the drift heartbeat's own beat: the slowest rate the office is ever
 * meant to paint at. Every integrator stepped with it carries remainders (a walk spends the whole step
 * across waypoints) or clamps (`toward`, the turn rate, the pet's acceleration), so a bigger step lands
 * in the same place as several small ones.
 */

/** The longest step one frame may advance the room by, in seconds. Equal to the drift beat (250 ms). */
export const MAX_FRAME_DT_S = 0.25;

/** Seconds of room time a frame advances by, given the wall milliseconds since the last one. */
export function frameDt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.min(MAX_FRAME_DT_S, elapsedMs / 1000);
}
