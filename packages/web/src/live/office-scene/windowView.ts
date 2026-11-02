import type { Fit, Pt } from './iso';
import { FLOOR, project, WALL_H } from './iso';
import { WINDOWS } from './layout';
import type { LightEnv } from './lighting';
import type { RenderedAssets } from './rendered/assets';
import { viewPlates, type DayState } from './rendered/manifest';
import { dayOf, roomMixFor } from './rendered/roomState';
import type { Weather } from './weather';

/**
 * The world outside the windows (window views, spec 2026-11-02, lane 01M6ENGW2H). Each pane in the
 * rendered shell is transparent; this paints, inside the pane's quad and under the shell: a sky
 * gradient on the continuous clock, the two nearest land plates crossfaded at the room's own day-state
 * edges, a weather tint, and the glass. The sky is runtime so the hour moves every minute; the land is a
 * plate so its lit faces are real ones. A pane with no plate (an older art set, a stale span) shows the
 * sky alone — never a hole.
 */
export type ViewSetting = 'city' | 'coast' | 'mountain';
export const DEFAULT_VIEW: ViewSetting = 'city';
export const VIEW_SETTINGS: readonly ViewSetting[] = ['city', 'coast', 'mountain'];

/** The `?view=` dev override, the same shape as `?weather=`; null when absent or unknown. */
export function viewOverride(search: string): ViewSetting | null {
  try {
    const q = new URLSearchParams(search).get('view')?.trim().toLowerCase();
    return q && (VIEW_SETTINGS as readonly string[]).includes(q) ? (q as ViewSetting) : null;
  } catch {
    return null;
  }
}

type Rgb = [number, number, number];
/** The sky's top and bottom colour by hour (the v2 mockup's curve): night, dawn, day, golden hour, dusk. */
const SKY_KEYS: ReadonlyArray<[hour: number, top: Rgb, bottom: Rgb]> = [
  [0, [12, 18, 44], [30, 38, 72]],
  [5, [24, 30, 68], [96, 72, 98]],
  [6.5, [112, 142, 204], [255, 176, 118]],
  [8, [118, 178, 236], [205, 228, 246]],
  [12, [84, 158, 236], [198, 226, 246]],
  [16, [108, 164, 230], [236, 214, 172]],
  [18, [96, 112, 172], [255, 152, 92]],
  [19.5, [38, 44, 94], [156, 82, 104]],
  [21, [16, 22, 54], [38, 46, 84]],
  [24, [12, 18, 44], [30, 38, 72]],
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgb = (c: Rgb) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

/** Cloudy desaturates and dims; rain dims more; snow goes paler and bluer. Applied to the sky colours. */
function weatherSky(c: Rgb, weather: Weather): Rgb {
  const grey = (c[0] + c[1] + c[2]) / 3;
  switch (weather) {
    case 'cloudy':
      return mix(c, [grey, grey, grey], 0.4).map((v) => v * 0.85) as Rgb;
    case 'rain':
      return mix(c, [grey, grey, grey], 0.5).map((v) => v * 0.7) as Rgb;
    case 'snow':
      return [lerp(c[0], 255, 0.3), lerp(c[1], 255, 0.3), lerp(c[2], 255, 0.36)];
    default:
      return c;
  }
}

/** The sky at `hours` under `weather`: `[top, bottom]` as CSS colours. */
export function skyStops(hours: number, weather: Weather): [top: string, bottom: string] {
  const h = ((hours % 24) + 24) % 24;
  let top: Rgb = SKY_KEYS[0]![1];
  let bottom: Rgb = SKY_KEYS[0]![2];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    const [h0, t0, b0] = SKY_KEYS[i]!;
    const [h1, t1, b1] = SKY_KEYS[i + 1]!;
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      top = mix(t0, t1, t);
      bottom = mix(b0, b1, t);
      break;
    }
  }
  return [rgb(weatherSky(top, weather)), rgb(weatherSky(bottom, weather))];
}

/** How the land plates are tinted by weather (a `ctx.filter`, skipped where unsupported). */
export function plateTint(weather: Weather): { brightness: number; saturate: number } {
  switch (weather) {
    case 'cloudy':
      return { brightness: 0.85, saturate: 0.6 };
    case 'rain':
      return { brightness: 0.7, saturate: 0.55 };
    case 'snow':
      return { brightness: 1.05, saturate: 0.5 };
    default:
      return { brightness: 1, saturate: 1 };
  }
}

/** The two back-wall edges as `t ∈ [0,1] → floor point`: 0 is the lx=0 wall, 1 the ly=0 wall. */
export const WALL_EDGES: ReadonlyArray<(t: number) => [number, number]> = [
  (t) => [0, t * FLOOR],
  (t) => [t * FLOOR, 0],
];

/** A wall-surface point: `t` along the edge, `u` up the wall (0 floor … 1 top). */
export function wallPt(edge: (t: number) => [number, number], t: number, u: number, fit: Fit): Pt {
  const [lx, ly] = edge(t);
  const p = project(lx, ly, fit);
  return { x: p.x, y: p.y - u * WALL_H * fit.scale };
}

/** The pane's four corners on screen: bottom-left, bottom-right, top-right, top-left along the wall. */
export function paneQuad(fit: Fit, which: 0 | 1, i: number): [Pt, Pt, Pt, Pt] {
  const w = WINDOWS[i]!;
  const edge = WALL_EDGES[which]!;
  return [
    wallPt(edge, w.t0, w.u0, fit),
    wallPt(edge, w.t1, w.u0, fit),
    wallPt(edge, w.t1, w.u1, fit),
    wallPt(edge, w.t0, w.u1, fit),
  ];
}

function clipQuad(ctx: CanvasRenderingContext2D, q: [Pt, Pt, Pt, Pt]): void {
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  ctx.lineTo(q[1].x, q[1].y);
  ctx.lineTo(q[2].x, q[2].y);
  ctx.lineTo(q[3].x, q[3].y);
  ctx.closePath();
  ctx.clip();
}

/**
 * Blit a plate onto the pane. A plate is the camera's whole frame — the pane plus `margin` on every
 * side, never cropped (review C1: a crop trimmed the sky off the top and stretched the land up to
 * the lintel) — so the source rect is the pane inside that margin, mapped onto the quad: x along the
 * wall (bottom-left → bottom-right), y up it (bottom-left → top-left). No anchor needed.
 */
function blitOntoQuad(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  margin: number,
  q: [Pt, Pt, Pt, Pt],
): void {
  const sx = w * margin;
  const sy = h * margin;
  const sw = w * (1 - 2 * margin);
  const sh = h * (1 - 2 * margin);
  const ax = (q[1].x - q[0].x) / sw;
  const ay = (q[1].y - q[0].y) / sw;
  const bx = (q[3].x - q[0].x) / sh;
  const by = (q[3].y - q[0].y) / sh;
  // image y runs down, wall u runs up: the origin is the top-left corner, i.e. q[3].
  ctx.save();
  ctx.transform(ax, ay, -bx, -by, q[3].x, q[3].y);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore();
}

/**
 * Paint every pane: sky, the plates for the two nearest day states crossfaded by the room's clock,
 * then the glass. Runs inside the cached shell, before the shell image is blitted over it.
 */
export function drawWindowViews(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  art: RenderedAssets,
  weather: Weather,
  view: ViewSetting,
): void {
  const mixState = roomMixFor(env);
  const from: DayState = dayOf(mixState.from);
  const to: DayState = dayOf(mixState.to);
  const [top, bottom] = skyStops(env.hours, weather);
  const tint = plateTint(weather);
  for (const which of [0, 1] as const) {
    for (let i = 0; i < WINDOWS.length; i++) {
      const q = paneQuad(fit, which, i);
      ctx.save();
      clipQuad(ctx, q);
      const sky = ctx.createLinearGradient(q[3].x, q[3].y, q[0].x, q[0].y);
      sky.addColorStop(0, top);
      sky.addColorStop(1, bottom);
      ctx.fillStyle = sky;
      ctx.fill();
      const plates = viewPlates(art.manifest, view, which, i);
      const draw = (state: DayState, alpha: number) => {
        const a = plates[state];
        const img = a && art.images.get(a.id);
        if (!a || !img) return;
        ctx.globalAlpha = alpha;
        if (tint.brightness !== 1 || tint.saturate !== 1)
          ctx.filter = `brightness(${tint.brightness}) saturate(${tint.saturate})`;
        blitOntoQuad(ctx, img, a.w, a.h, a.view?.margin ?? 0, q);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      };
      draw(from, 1);
      if (mixState.mix > 0 && to !== from) draw(to, mixState.mix);
      // the glass: a soft diagonal highlight, so the pane reads as glass, not a hole
      const glass = ctx.createLinearGradient(q[3].x, q[3].y, q[1].x, q[1].y);
      glass.addColorStop(0, 'rgba(255,255,255,0.14)');
      glass.addColorStop(0.35, 'rgba(255,255,255,0)');
      glass.addColorStop(1, 'rgba(255,255,255,0.08)');
      ctx.fillStyle = glass;
      ctx.fill();
      ctx.restore();
    }
  }
}
