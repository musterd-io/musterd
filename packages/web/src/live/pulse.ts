/**
 * The seat pulse on the viewer (ADR 660 §3.3) — the daemon's `seat_pulse` frame read at draw time.
 *
 * A pulse is counts and kinds only: how many distinct harness tool calls the seat made in the last
 * minute, and the kind (read / edit / run / test) of the latest. The daemon sends one per seat at
 * most every ~5 s and **nothing when the seat is idle**, so liveness is decided here, from the
 * frame's own `ts`: three missed pulses (15 s) and the desk is still. There is no interval and no
 * extrapolation — the rAF loop is the only clock, and a hookless seat, which never pulses, sits
 * still at a lit screen honestly.
 *
 * `SeatPulse` is the `seat_pulse` frame (SPEC A.25) minus its `type` and `member`: `ts` is the
 * daemon clock when the pulse was computed, `intensity` the distinct tool calls in the trailing
 * 60 s, `kind` the latest call's kind (null for e.g. musterd's own tools), `last_ts` that call's
 * producer time.
 */
import type { PulseKind, SeatPulseFrame } from '@musterd/protocol';

export type { PulseKind };
export type SeatPulse = Pick<SeatPulseFrame, 'ts' | 'intensity' | 'kind' | 'last_ts'>;

/** A pulse older than this is stale: three missed ~5 s pulses. */
export const PULSE_TTL_MS = 15_000;

/** How long a `run` lights the monitor past the call itself. */
export const RUN_GLOW_MS = 3_000;

export function pulseLive(p: SeatPulse | undefined, now: number): boolean {
  return !!p && p.intensity > 0 && now - p.ts < PULSE_TTL_MS;
}

/** The frame's intensity while live, 0 after the TTL or with no pulse at all. */
export function pulseIntensity(p: SeatPulse | undefined, now: number): number {
  return pulseLive(p, now) ? p!.intensity : 0;
}

/**
 * 1 → 0 over `RUN_GLOW_MS` from the latest run, 0 for every other kind. A `last_ts` ahead of the
 * viewer's clock (producer/daemon skew) reads as "just now", never as negative.
 */
export function runGlow(p: SeatPulse | undefined, now: number): number {
  if (!p || p.kind !== 'run') return 0;
  const age = Math.max(0, now - p.last_ts);
  return age >= RUN_GLOW_MS ? 0 : 1 - age / RUN_GLOW_MS;
}
