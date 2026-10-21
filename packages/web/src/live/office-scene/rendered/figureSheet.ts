/**
 * Sprite-sheet geometry for the rendered figure (office realism, plan Task 10; spec §3.2).
 *
 * A sheet is a grid: one row per (animation, direction), one column per frame. `SheetSpec` is
 * what `render.py --figure` writes as `figure.json`; `frameRect` turns the scene clock into the
 * source rectangle to blit, and `dir8FromHeading` turns the actor's continuous heading into one of
 * eight rows — with hysteresis, so a figure walking along a sector boundary never flickers
 * between two sheets frame to frame (Review Focus 4).
 */
import type { Dir } from '../types';

export type Dir8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
/** Row order on every sheet: clockwise from E, the way the heading grows (0 = E, π/2 = S, y down). */
export const DIR8: readonly Dir8[] = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

export type Anim = 'idle' | 'walk' | 'sit-type' | 'sit-idle' | 'speak' | 'turn' | 'sit-down' | 'stand-up';
export const ANIMS: readonly Anim[] = ['idle', 'walk', 'sit-type', 'sit-idle', 'speak', 'turn', 'sit-down', 'stand-up'];

export interface AnimSpec {
  /** First row of this animation; direction `d` is row `row + DIR8.indexOf(d)`. */
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export interface SheetSpec {
  /** Source px per floor unit the sheets were rendered at (the manifest's `scale`, per asset). */
  scale: number;
  /** One nominal frame's size in source px — the box every cell's offset is measured in. */
  frame: { w: number; h: number };
  /** The figure's floor point inside a nominal frame, in source px (`blit.ts` puts it on `project(lx, ly)`). */
  anchor: { x: number; y: number };
  /** The crown of the head in floor units — nameplates and bubbles hang above it (96 when absent). */
  height?: number;
  anims: Record<Anim, AnimSpec>;
  /**
   * Per layer, the packed atlas cells: six numbers per cell — `x, y, w, h` in the atlas and
   * `ox, oy`, where the cell sits inside the nominal frame — in ANIMS order, then DIR8, then
   * frame. A frame with no pixels on that layer is all zeros. Cropping each frame to its own
   * pixels is what keeps 27 layers from decoding to gigabytes: a glasses cell is a few hundred
   * pixels, not a whole frame. Absent (an older figure.json), the sheet is a plain grid.
   */
  cells?: Record<string, number[]>;
}

const SECTOR = Math.PI / 4;
/** How far past a boundary the heading must go before the sector flips, when a previous one is known. */
const HYSTERESIS = (4 * Math.PI) / 180;

/** Wrap a heading to (−π, π]. */
function wrap(h: number): number {
  const w = ((h + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return w - Math.PI;
}

/** The sector index (0 = E … 7 = NE) of a heading, sharp boundaries at odd multiples of π/8. */
function sectorOf(h: number): number {
  return ((Math.round(wrap(h) / SECTOR) % 8) + 8) % 8;
}

export function dir8FromHeading(headingRad: number, prev?: Dir8): Dir8 {
  const raw = sectorOf(headingRad);
  if (prev === undefined) return DIR8[raw]!;
  const p = DIR8.indexOf(prev);
  const step = ((raw - p) % 8) + 8;
  if (step % 8 === 0) return prev;
  // Only an ADJACENT sector gets hysteresis: a jump of two or more is a real turn, take it at once.
  if (step % 8 !== 1 && step % 8 !== 7) return DIR8[raw]!;
  // How far past the shared boundary are we? Measured from prev's centre, the boundary sits at ±π/8.
  const fromPrev = wrap(headingRad - p * SECTOR);
  const past = Math.abs(fromPrev) - SECTOR / 2;
  return past >= HYSTERESIS ? DIR8[raw]! : prev;
}

export function dir8FromDir(d: Dir): Dir8 {
  return d;
}

export interface FrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** A one-shot has reached its last frame (always false for a loop). */
  done: boolean;
}

/** Which frame of `anim` plays at `t`, and whether a one-shot has finished. */
export function frameIndex(spec: SheetSpec, anim: Anim, t: number, startT: number): { i: number; done: boolean } {
  const a = spec.anims[anim];
  const elapsed = Math.max(0, t - startT);
  const n = Math.floor(elapsed * a.fps + 1e-6);
  return { i: a.loop ? n % a.frames : Math.min(n, a.frames - 1), done: !a.loop && n >= a.frames - 1 };
}

export function frameRect(spec: SheetSpec, anim: Anim, dir: Dir8, t: number, startT: number): FrameRect {
  const { i, done } = frameIndex(spec, anim, t, startT);
  const a = spec.anims[anim];
  return {
    sx: i * spec.frame.w,
    sy: (a.row + DIR8.indexOf(dir)) * spec.frame.h,
    sw: spec.frame.w,
    sh: spec.frame.h,
    done,
  };
}

/** A packed cell: the atlas rect plus where it sits inside the nominal frame. `sw === 0` means nothing to draw. */
export interface FrameCell extends FrameRect {
  ox: number;
  oy: number;
}

/** The index of (anim, dir, frame) in a layer's `cells` list: ANIMS order, then DIR8, then frame. */
export function cellIndex(spec: SheetSpec, anim: Anim, dir: Dir8, frame: number): number {
  let base = 0;
  for (const a of ANIMS) {
    if (a === anim) break;
    base += spec.anims[a].frames * DIR8.length;
  }
  return base + DIR8.indexOf(dir) * spec.anims[anim].frames + frame;
}

/**
 * The cell to blit for `layer` at `t`: from the packed atlas when the spec carries cells, else the
 * grid frame (offset 0, 0). The destination is `anchor − (ox, oy)` from the floor point.
 */
export function frameCell(spec: SheetSpec, layer: string, anim: Anim, dir: Dir8, t: number, startT: number): FrameCell {
  const cells = spec.cells?.[layer];
  if (!cells) return { ...frameRect(spec, anim, dir, t, startT), ox: 0, oy: 0 };
  const { i, done } = frameIndex(spec, anim, t, startT);
  const at = cellIndex(spec, anim, dir, i) * 6;
  const [sx = 0, sy = 0, sw = 0, sh = 0, ox = 0, oy = 0] = cells.slice(at, at + 6);
  return { sx, sy, sw, sh, ox, oy, done };
}
