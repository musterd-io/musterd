/**
 * Which rendered light state the room shows, and the crossfade between two (office realism,
 * plan Task 8; spec §3.3).
 *
 * The room ships one rendered shell per day state — `room/light-day`, `-evening`, `-night` — and
 * one additive ceiling overlay per ceiling state that has light in it — `room/ceiling-on`,
 * `-spill`. `computeLightEnv` keeps its clock; this module only turns its `hours` into "which
 * two images, and how far between them". The painted path's veil and lamps are unchanged: they
 * paint over the rendered room exactly as they paint over the painted one.
 *
 * A fade is FADE_HOURS long and starts AT the edge, so the mix is 0 before it, rises linearly
 * through it and is exactly 1 at its end — never a stuck half-blend, never a pop (Review Focus 3).
 */
import type { LightEnv } from '../lighting';

export type DayState = 'day' | 'evening' | 'night';
export type CeilingState = 'on' | 'off' | 'spill';
export type RoomState = `${DayState}-${CeilingState}`;

export interface RoomMix {
  from: RoomState;
  to: RoomState;
  /** 0..1 — how much of `to` is drawn over `from`. 0 whenever `from === to`. */
  mix: number;
}

/** Hour-of-day each day state begins (PST, like `LightEnv.hours`). */
export const DAY_EDGES = { dayFrom: 7.0, eveningFrom: 16.5, nightFrom: 19.0 } as const;
/** A crossfade's length in hours — 45 minutes. */
export const FADE_HOURS = 0.75;

/** The day state at `h`, ignoring fades. */
function dayStateAt(h: number): DayState {
  if (h >= DAY_EDGES.nightFrom || h < DAY_EDGES.dayFrom) return 'night';
  if (h >= DAY_EDGES.eveningFrom) return 'evening';
  return 'day';
}

/** The day states on either side of the fade that `h` is inside, and how far along it is. */
function dayMixAt(h: number): { from: DayState; to: DayState; mix: number } {
  const edges: Array<[number, DayState, DayState]> = [
    [DAY_EDGES.dayFrom, 'night', 'day'],
    [DAY_EDGES.eveningFrom, 'day', 'evening'],
    [DAY_EDGES.nightFrom, 'evening', 'night'],
  ];
  for (const [edge, from, to] of edges) {
    const t = (h - edge) / FADE_HOURS;
    if (t === 0) return { from, to: from, mix: 0 }; // the edge itself is still the old state
    if (t > 0 && t < 1) return { from, to, mix: t };
  }
  const s = dayStateAt(h);
  return { from: s, to: s, mix: 0 };
}

/** The ceiling bank, from the same facts the painted room reads (`overheadOn`, `afterHours`). */
export function ceilingStateFor(env: LightEnv): CeilingState {
  if (env.overheadOn) return 'on';
  if (env.afterHours && env.ambient > 0) return 'spill';
  return 'off';
}

export function roomMixFor(env: LightEnv): RoomMix {
  const d = dayMixAt(env.hours);
  const c = ceilingStateFor(env);
  return { from: `${d.from}-${c}`, to: `${d.to}-${c}`, mix: d.from === d.to ? 0 : d.mix };
}

/** The day state of a room state — which shell image it draws. */
export function dayOf(state: RoomState): DayState {
  return state.split('-')[0] as DayState;
}

/** The ceiling state of a room state — which overlay it adds, if any. */
export function ceilingOf(state: RoomState): CeilingState {
  return state.split('-')[1] as CeilingState;
}

/**
 * A multiply tint for rendered figures, so a day-lit sprite sheet sits in the evening and night
 * rooms (spec §3.3). Follows `daylight` continuously — the same curve the veil follows — so it
 * cannot pop at a state edge. White by day; a cool, dimmer cast at night.
 */
export function figureTintFor(env: LightEnv): string {
  const t = Math.max(0, Math.min(1, env.daylight));
  const night: [number, number, number] = [0xb4, 0xbc, 0xd6];
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${night.map((n) => hex(n + (255 - n) * t)).join('')}`;
}
