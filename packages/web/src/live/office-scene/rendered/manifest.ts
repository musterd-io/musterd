/**
 * The rendered-art manifest (office realism, spec 2026-10-20 §3.1, plan Task 1).
 *
 * `packages/web/art/office/render.py` writes `rendered/assets/manifest.json` beside the PNGs it
 * renders; the scene reads it back through {@link parseManifest}. One manifest describes one render:
 * every asset in it was rendered from the same orthographic camera (`camera`) at the same scale, so
 * a blit only has to agree on `scale` once to land every asset on the painted floor.
 *
 * Hand-written shape check rather than zod: the web package carries no schema library, and a
 * manifest is a build input we author, not external input (hard rule 4 is about the wire).
 */
import { WINDOWS } from '../layout';

export interface RenderedAsset {
  /** Stable id the painters look up, e.g. `desk/base`, `room/floor`, `desk/lamp-on`. */
  id: string;
  /** Basename of the PNG, e.g. `office-art-desk-base.png` — the `office-art-` prefix is what the byte budget sums. */
  file: string;
  /** Source size in px, rendered at 2× (spec §5). */
  w: number;
  h: number;
  /** Where the asset's floor point (its `lx, ly` origin) sits inside the source, in source px. */
  anchor: { x: number; y: number };
  /** Source px per floor unit at 2×; the same for every asset of one render. */
  scale: number;
  /** A window-view plate (window views, lane 01M6ENGW2H): the pane it was framed to. */
  view?: ViewSpan;
}

/** Which wall (0 = the lx=0 wall, 1 = the ly=0 wall) and the pane's span along and up it, as `WINDOWS`. */
export interface ViewSpan {
  which: 0 | 1;
  t0: number;
  t1: number;
  u0: number;
  u1: number;
  /** The frame's slack around the pane, as a fraction of the pane span on every side (0 = none).
   *  A plate is the FULL camera frame, never cropped, so the pane is the rect inside this margin. */
  margin: number;
}

export interface RenderedManifest {
  version: 1;
  /** The orthographic camera the render used — must match `iso.ts`'s `Camera` for the active path. */
  camera: { kx: number; ky: number };
  assets: RenderedAsset[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseAsset(v: unknown, i: number): RenderedAsset {
  if (!isRecord(v)) throw new Error(`manifest asset ${i} is not an object`);
  const { id, file, w, h, anchor, scale } = v;
  if (typeof id !== 'string' || !id) throw new Error(`manifest asset ${i} needs an id`);
  if (typeof file !== 'string' || !file) throw new Error(`manifest asset ${id} needs a file`);
  if (!isNum(w) || !isNum(h)) throw new Error(`manifest asset ${id} needs numeric w and h`);
  if (!isRecord(anchor) || !isNum(anchor['x']) || !isNum(anchor['y']))
    throw new Error(`manifest asset ${id} needs an anchor {x, y}`);
  if (!isNum(scale) || scale <= 0) throw new Error(`manifest asset ${id} needs a positive scale`);
  const view = parseViewSpan(v['view']);
  return { id, file, w, h, anchor: { x: anchor['x'], y: anchor['y'] }, scale, ...(view ? { view } : {}) };
}

/** A malformed span is dropped, not fatal: the plate then never matches a window and the sky still paints. */
function parseViewSpan(v: unknown): ViewSpan | undefined {
  if (!isRecord(v)) return undefined;
  const { which, t0, t1, u0, u1, margin } = v;
  if ((which !== 0 && which !== 1) || !isNum(t0) || !isNum(t1) || !isNum(u0) || !isNum(u1)) return undefined;
  return { which, t0, t1, u0, u1, margin: isNum(margin) && margin >= 0 && margin < 0.5 ? margin : 0 };
}

/** Parse a manifest JSON value; throws with the offending field named. */
export function parseManifest(json: unknown): RenderedManifest {
  if (!isRecord(json)) throw new Error('manifest is not an object');
  if (json['version'] !== 1) throw new Error(`manifest version ${String(json['version'])} is not 1`);
  const camera = json['camera'];
  if (!isRecord(camera) || !isNum(camera['kx']) || !isNum(camera['ky']))
    throw new Error('manifest needs a camera {kx, ky}');
  const assets = json['assets'];
  if (!Array.isArray(assets)) throw new Error('manifest needs an assets array');
  return {
    version: 1,
    camera: { kx: camera['kx'], ky: camera['ky'] },
    assets: assets.map(parseAsset),
  };
}

/**
 * Does a manifest's camera match the camera the scene will project through? A desk rendered at one
 * elevation blitted under another lands on the wrong pixels and reads as a broken drawing, which is
 * worse than the painted desk; so a mismatch leaves the room painted (and says so, once).
 */
export function cameraMatches(m: RenderedManifest, cam: { kx: number; ky: number }, tol = 1e-4): boolean {
  return Math.abs(m.camera.kx - cam.kx) <= tol && Math.abs(m.camera.ky - cam.ky) <= tol;
}

export function assetById(m: RenderedManifest, id: string): RenderedAsset | undefined {
  return m.assets.find((a) => a.id === id);
}

import type { DayState } from './roomState';
export type { DayState };
const DAY_STATES: readonly DayState[] = ['day', 'evening', 'night'];

/**
 * The plates for one pane: `view/<setting>/<which>-<i>-<state>` whose `view` span matches the window the
 * scene will clip to (`layout.ts` WINDOWS) within 1e-3. A stale plate — rendered when WINDOWS sat
 * elsewhere — is left out rather than stretched across the wrong quad; the pane then shows sky alone.
 */
export function viewPlates(
  m: RenderedManifest,
  setting: string,
  which: 0 | 1,
  i: number,
  win: { t0: number; t1: number; u0: number; u1: number } = WINDOWS[i]!,
): Partial<Record<DayState, RenderedAsset>> {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3;
  const out: Partial<Record<DayState, RenderedAsset>> = {};
  for (const state of DAY_STATES) {
    const a = assetById(m, `view/${setting}/${which}-${i}-${state}`);
    if (!a?.view || a.view.which !== which) continue;
    if (!near(a.view.t0, win.t0) || !near(a.view.t1, win.t1) || !near(a.view.u0, win.u0) || !near(a.view.u1, win.u1))
      continue;
    out[state] = a;
  }
  return out;
}
