import { canvasFont } from '../canvasFont';
import type { LaneState, WorkingHours } from '@musterd/protocol';
import type { Appearance } from './appearance';
import { deskWaitingKey } from './deskWaiting';
import { animFor, drawCharacter } from './character';
import {
  cameraOf,
  CORNER_CAMERA,
  depth,
  FLOOR,
  project,
  THICK,
  WALL_H,
  type Camera,
  type Fit,
  type FitBox,
  type Pt,
} from './iso';
import type { SpriteCache } from './sprite-cache';
import type { PetState } from './pet';
import { RECEPTION_CUE_S, RECEPTIONIST_WAKE_S, type ReceptionistState } from './receptionist';
import {
  ART,
  BOOKSHELVES,
  CHAIR_OFF,
  DESK_D,
  deskDims,
  BENCH,
  DESK_SLOTS,
  DESK_UP,
  ENTRANCE,
  FRONT_DESK,
  RECEPTIONIST,
  FWD,
  KEYBOARD_ALONG,
  LEISURE_SPOTS,
  LOUNGE,
  MEETING,
  NOOK,
  BIN,
  PLANTS,
  PODS,
  PRINTER,
  RECEPTION,
  SHELF_CHIMES,
  WALL_BOARD,
  WIKI_SHELF,
  WORKING_HOURS_CALENDAR,
  WINDOWS,
  type DeskSlot,
} from './layout';
import type { ReadStatus } from '../experimentReads';
import { READ_PIN_CAP, readPins, stickySway, WALL_COLUMNS, type WallBoard } from './wallboard';
import { DAY_ENV, deskLampOn, sunBeam, type LightEnv } from './lighting';
import type { Weather } from './weather';
import { CANVAS_EASE } from './motion';
import { deskMoodFor, deskMoodStyle } from './moods';
import { workingAtDesk, type Placement } from './seating';
import { pulseIntensity, pulseLive, runGlow } from '../pulse';
import { chairShift, chairYaw, GESTURE, handsInLap, seedOf, typingFromPulse } from './skeleton';
import type { UnitHook } from './damage';
import { blitAsset } from './rendered/blit';
import { tintFrame } from './rendered/tint';
import { ceilingOf, dayOf, figureTintFor, roomMixFor } from './rendered/roomState';
import type { FigureAssets, RenderedAssets } from './rendered/assets';
import { dogCell, dogDir, dogFrame } from './rendered/dogSheet';
import type { Dir8 } from './rendered/figureSheet';
import type { CarryKind, Dir, OfficeNode, Pose, WelcomePaint } from './types';
import { TOSS_S } from './welcomeRoom';
import { formatWorkingHours } from './workingHours';

/**
 * Canvas-2D drawing for the office. Everything is painter-ordered by logical depth (lx+ly) so seated
 * members sit correctly behind their desks and nearer pods overlap farther ones. The static scene is
 * baked once per data/resize; transient act cues are drawn on top each frame. Fidelity ported from the
 * Figma "Floor Plan": legged desks + task chairs + oriented glowing monitors, a rich break nook
 * (couch + armchairs + kitchenette), huddle spaces, and big floor plants.
 */

/**
 * Theme-varying scene surfaces — the floor and the wooden/upholstered furniture. Furniture-*intrinsic*
 * colours (books, monitors, plants, skin, glass, the entrance door) are identity, not theme, and stay
 * fixed. index.ts resolves these from the office tokens (`--floor`, `--floor-2`, `--wood`, `--couch`)
 * that the active theme cascades to the canvas host, then calls `setScenePalette` before each bake — so
 * the same scene paints daylight on a light page and dusk inside the `.lc` stage.
 */
export interface ScenePalette {
  floor: string;
  floor2: string;
  wood: string;
  couch: string;
  /** The back walls — a warm interior surface (the `--wall` token, unused until now). */
  wall: string;
}

/** Dusk office (mirrors the dusk tokens in tokens.css) — also the fallback when a token can't be read. */
export const DARK_PALETTE: ScenePalette = {
  floor: '#ebae64',
  floor2: '#c8863c',
  wood: '#85552c',
  couch: '#e3a72b',
  wall: '#2a2030', // the dusk `--wall` token (tokens.css)
};

let PAL: ScenePalette = DARK_PALETTE;
export function setScenePalette(p: ScenePalette): void {
  PAL = p;
}

// ── colour utils ──────────────────────────────────────────────────────────
function hexRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
/** Multiply a hex colour toward black — for iso side/front face shading. */
/**
 * Scale a hex colour's channels. **Returns hex, so its own output can be fed back in** — `box()` shades a
 * solid's side faces by re-`dim()`ing the colour it was handed, so anything that returns a colour here is
 * a potential input to this function.
 *
 * It used to return `rgb(r, g, b)`, which `hexRgb` can't parse: `parseInt('rg', 16)` is `NaN`, so a
 * re-shaded colour came out `rgb(NaN, NaN, …)`. Canvas **silently ignores an invalid `fillStyle` and keeps
 * the previous one** — no throw, no warning — so those faces were painted in whatever colour the last draw
 * happened to leave behind, which changed with the depth-sort order. That's what turned the kitchenette
 * counter's sides green once idle members moved off the desks and reordered the scene. `render.test.ts`
 * guards it: every colour the scene assigns must be one canvas can actually parse.
 */
function mul(h: string, f: number): string {
  const [r, g, b] = hexRgb(h);
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v * f)));
  const hex = (v: number) => c(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
/** Darken/lighten an `hsl()` string by a lightness factor. */
function hslL(color: string, f: number): string {
  const m = /hsl\(\s*([-\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)/.exec(color);
  if (!m) return color;
  return `hsl(${m[1]}, ${m[2]}%, ${Math.max(0, Math.min(100, Number(m[3]) * f))}%)`;
}
/** Shade either an `hsl()` (member) or `#hex` (furniture) colour. */
function dim(color: string, f: number): string {
  return color.startsWith('hsl') ? hslL(color, f) : mul(color, f);
}

/** The office act-tone palette (mirrors Live.css `--lc-*`). */
export function toneColor(tone: string): string {
  switch (tone) {
    case 'accent':
      return '#f4cf52';
    case 'success':
      return '#5cd49a';
    case 'danger':
      return '#f3776a';
    case 'info':
      return '#88a9cf';
    case 'handoff':
      return '#7fc8d8'; // sea blue (mirrors --lc-handoff) — violet until 2026-10-12
    case 'lane':
      return '#7fa6e6'; // cornflower (mirrors --lc-lane) — lane transitions + defer's plan mutation
    case 'status':
      return '#2ad6bb';
    case 'steer':
      return '#ef6bbd'; // magenta-rose (mirrors --lc-steer) — interrupt-class redirect, prominent
    case 'challenge':
      return '#4bc4e0'; // cyan (mirrors --lc-challenge) — the epistemic "justify?"
    default:
      return '#ffd49a';
  }
}

// ── primitives ──────────────────────────────────────────────────────────────
function quad(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function ellipse(ctx: CanvasRenderingContext2D, c: Pt, rx: number, ry: number, fill: string): void {
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0.2, rx), Math.max(0.2, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * The pool of shade where a solid meets the surface it stands on.
 *
 * Until this existed the room had exactly ONE contact shadow — `drawGroundShadow`, which grounds the
 * whole floor slab on the panel — plus a handful of hand-placed pools under the plants and the dog.
 * Every desk, chair, cabinet, printer and monitor had nothing underneath it, which is the difference
 * between an object resting ON a surface and an object floating a millimetre above one. It reads as
 * weightlessness even when you cannot say why: the eye takes contact shade as the evidence that two
 * things touch, and without it a flat-shaded solid is just a shape pasted at that coordinate.
 *
 * Drawn at `baseUp` rather than at the floor, so it lands on whatever the solid actually stands on —
 * the floor for a desk, the desk top for the monitor on it. That is the whole reason this takes the
 * same parameters as the caller's own footprint instead of a floor position.
 *
 * WARM, not cool, and deliberately so even though the room just gained a cool counterweight: the
 * scene's standing rule (stated at `drawGroundShadow` and again in the roundness pass) is that a
 * neutral or cold shade on a warm floor reads as dirt. The counterweight belongs to the walls, which
 * are lit; this is contact, which is not.
 *
 * Cost: `box`/`frustum` run at BAKE time only — the room is drawn once into an offscreen buffer and
 * re-baked on resize or a veil/lamp step, not per frame (ADR 085's two-tier render). So this is paid
 * on a rebake, never on the 20fps ambient loop.
 */
export function contactPool(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  w: number,
  d: number,
  baseUp: number,
): void {
  const span = (w + d) / 2;
  /* A desk is not one box. It is a top, four legs, a monitor, a keyboard and a mug, and EVERY one of
     them comes through here — so the first cut of this compounded: a dozen overlapping pools per pod
     turned the desks into a dark brown mass and took the light out of the middle of the room. Two
     guards, both about the fact that a contact pool is a per-OBJECT effect being applied per-solid:
       · below `MIN_SPAN` nothing is drawn at all. A keyboard does not have a shadow you would notice,
         and twenty of them do have one you cannot miss.
       · the alpha is a fraction of what a lone pool would want, because these are meant to be READ in
         aggregate. Tuned by eye against the muddied version, not by picking a round number. */
  const MIN_SPAN = 9;
  if (span < MIN_SPAN) return;
  const c = project(lx, ly, fit);
  const cy = c.y - baseUp * fit.scale;
  // The penumbra spills a little past the footprint, and the pool is offset a touch toward the
  // viewer — the room's light comes from the windows behind, so shade falls to the front.
  const cam = cameraOf(fit);
  const rx = span * cam.kx * fit.scale * 0.78;
  const ry = span * cam.ky * fit.scale * 0.92;
  ctx.save();
  ctx.translate(c.x, cy + ry * 0.18);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, 'rgba(58, 34, 12, 0.13)');
  g.addColorStop(0.45, 'rgba(58, 34, 12, 0.07)');
  g.addColorStop(1, 'rgba(58, 34, 12, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** An iso block: three faces (top lightest, front medium, right darkest), footprint w×d (logical),
 * height hPx (screen px at scale 1), floated `baseUp` px off the floor. */
function box(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  w: number,
  d: number,
  hPx: number,
  base: string,
  baseUp = 0,
): void {
  const A = project(lx - w / 2, ly - d / 2, fit);
  const B = project(lx + w / 2, ly - d / 2, fit);
  const C = project(lx + w / 2, ly + d / 2, fit);
  const D = project(lx - w / 2, ly + d / 2, fit);
  const lo = baseUp * fit.scale;
  const hi = (baseUp + hPx) * fit.scale;
  const dn = (p: Pt, u: number): Pt => ({ x: p.x, y: p.y - u });
  contactPool(ctx, fit, lx, ly, w, d, baseUp);
  quad(ctx, [dn(B, lo), dn(C, lo), dn(C, hi), dn(B, hi)], shade(base, 0.72));
  quad(ctx, [dn(D, lo), dn(C, lo), dn(C, hi), dn(D, hi)], shade(base, 0.86));
  quad(ctx, [dn(A, hi), dn(B, hi), dn(C, hi), dn(D, hi)], base);
}

/** Face shading that also handles hsl bases (member-tinted furniture like chairs). */
function shade(base: string, f: number): string {
  return dim(base, f);
}

// ── grounding: the diorama sits on the panel, not floating over it ──────────────────────────────────────
/**
 * A soft contact shadow pooled under the floor slab. Drawn first, before the floor — the opaque slab
 * paints over its middle, leaving only the penumbra spilling past the slab's edges, so the office reads
 * as a little model resting on the panel surface rather than a slab hanging in space. Elliptical (the
 * iso footprint), pooled toward the front where the slab base meets the ground.
 */
function drawGroundShadow(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const back = project(0, 0, fit);
  const front = project(FLOOR, FLOOR, fit);
  const cx = fit.ox;
  const cy = (back.y + front.y) / 2 + THICK * fit.scale * 0.9; // pooled toward the slab's front base
  const cam = cameraOf(fit);
  const rx = FLOOR * cam.kx * fit.scale * 1.08;
  const ry = FLOOR * cam.ky * fit.scale * 1.24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx); // draw a circle, squash it to the iso ellipse
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, 'rgba(46, 30, 16, 0.30)');
  g.addColorStop(0.6, 'rgba(46, 30, 16, 0.17)');
  g.addColorStop(1, 'rgba(46, 30, 16, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A gentle edge vignette framing the whole diorama, so the scene fades into the panel toward the corners
 * instead of hitting a hard rectangular cut. Drawn last, in device pixels (transform reset), so it covers
 * the panel exactly at any DPR — the same "overshoots-are-harmless" trick the night veil uses, but here we
 * need the true panel centre, so we go through the identity transform.
 */
function drawVignette(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const diag = Math.hypot(w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(cx, cy, diag * 0.33, cx, cy, diag * 0.62);
  g.addColorStop(0, 'rgba(26, 17, 9, 0)');
  g.addColorStop(1, 'rgba(26, 17, 9, 0.2)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── the room shell: the two back walls + their windows (office-walls-windows.md) ────────────────────────
// The floor diamond's back corner is (0,0). The two back walls rise from the two upper edges meeting there:
// the `ly=0` edge (back-right) and the `lx=0` edge (back-left, the one the door sits in). They are drawn
// ONCE as a backdrop — right after the floor, before the depth-sorted items — because a wall spans many
// depths (it is one plane) and so can't take a single depth key; nothing on the floor is ever *behind* the
// back edges, so a backdrop that every furniture piece paints over is correct at every position.

// WALL_H (the back-wall height in screen px at scale 1) lives in iso.ts now — the fit has to reserve room
// for it above the diamond, so it's owned there and imported here for the drawing.

// The windows + beam geometry live in layout.ts (the dog's sunbeam nap spots derive from the same data).

/**
 * The glass colour: bright sky by day (warm at golden hour via `skyTint`), a dark pane with a faint city
 * glow by night. Interpolated on `daylight`, so it tracks the same PST clock as the beam and the veil.
 */

export function glassColor(env: LightEnv): string {
  const [sr, sg, sb] = hexRgb('#0f1626'); // night pane
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(env.skyTint);
  const [dr, dg, db] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [206, 226, 244];
  const t = env.daylight;
  const c = (n: number, d: number) => Math.round(n + (d - n) * t);
  return `rgb(${c(sr, dr)}, ${c(sg, dg)}, ${c(sb, db)})`;
}

/**
 * Draw the two back walls and their windows. `edge(t,u)` maps a wall coordinate to the floor point + lift,
 * so the same body serves both walls — the back-right wall runs `lx` along the `ly=0` edge, the back-left
 * runs `ly` along the `lx=0` edge.
 */
/** The two back-wall edges, as `t ∈ [0,1] → floor point` — shared by the walls, the string-light cable,
 * and the ambient-magic overlay anchors (`magicAnchors`). */
const WALL_EDGES: ReadonlyArray<(t: number) => [number, number]> = [
  (t) => [0, t * FLOOR], // back-left wall (the lx=0 edge)
  (t) => [t * FLOOR, 0], // back-right wall (the ly=0 edge)
];

/** A wall-surface point: `t` along the edge, `u` up the wall (0 floor … 1 top). */
function wallPt(edge: (t: number) => [number, number], t: number, u: number, fit: Fit): Pt {
  const [lx, ly] = edge(t);
  const p = project(lx, ly, fit);
  return { x: p.x, y: p.y - u * WALL_H * fit.scale };
}

/** The sagging string-light cable for one wall — bulbs hang at the odd indices (see drawWalls). */
function cablePts(edge: (t: number) => [number, number], fit: Fit): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = 0.1 + (i / 12) * 0.8;
    const sag = Math.sin((i / 12) * Math.PI) * 0.045;
    out.push(wallPt(edge, t, 0.91 - sag, fit));
  }
  return out;
}

// ── back-wall dressing ────────────────────────────────────────────────────────────────────────────────
// The walls already carry the windows and the string lights; everything hung on them lives here. It all
// goes in the gaps the windows leave (t ∈ [0.02,0.26] · [0.48,0.56] · [0.80,0.98]) and above the
// bookshelves (u > 0.36), so the dressing never fights the room's existing furniture or its light.

const DRESS = {
  frame: '#5b4130',
  mat: '#f2e7d5',
  clockFace: '#f6ead2',
  clockRim: '#4b3524',
  tick: '#94795c',
  hand: '#3a2a1c',
  rope: '#8a6a4a',
  pot: '#b9603a',
  potRim: '#cb6f45',
  vine: '#5f8f4b',
} as const;

/** A rectangle in wall space: `t` along the wall, `u` up it. */
function wallRect(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  t0: number,
  u0: number,
  t1: number,
  u1: number,
  fill: string,
): void {
  const pt = (t: number, u: number): Pt => wallPt(edge, t, u, fit);
  quad(ctx, [pt(t0, u0), pt(t1, u0), pt(t1, u1), pt(t0, u1)], fill);
}

/**
 * A disc of logical radius `r` lying flat *on* the wall. `wallPt` shears it onto the wall plane, so a
 * circle drawn here lands on screen as the ellipse a real circle on that wall would — the radius has to be
 * converted per axis (the wall is FLOOR long and WALL_H tall) or it comes out an egg.
 */
function wallDisc(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  r: number,
  fill: string,
): void {
  const pts: Pt[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push(wallPt(edge, tc + (Math.sin(a) * r) / FLOOR, uc + (Math.cos(a) * r) / WALL_H, fit));
  }
  quad(ctx, pts, fill);
}

/**
 * The prints' ink. Deliberately few colours, and all of them the room's own: each frame occupies only
 * ~30–45px on screen, where a motif reads as a silhouette plus two or three flats and any further
 * shade is just mud.
 */
const INK = {
  // A dusk sand, not the near-mat cream it wants to be: against #f2e7d5 the sky has to hold its own or
  // the print reads as shapes floating on the mat with no paper under them.
  sky: '#e8cfa8',
  paper: '#efe2c8',
  terracotta: '#c2694a',
  sage: '#5d7f6d',
  sageDeep: '#3f5747',
  ochre: '#d2a24c',
  teal: '#4e7d8c',
  plum: '#8a5a6d',
  line: '#4b3524',
} as const;

/**
 * The surface one print is painted on: `a` runs across the mat opening and `b` up it, both in logical
 * units out from its centre. It is the wall-space convention `wallDisc`/`wallClock` already use, which is
 * what keeps a motif's disc a real circle *on the wall* rather than a screen-space egg pasted over it.
 */
interface ArtSurface {
  rect: (a0: number, b0: number, a1: number, b1: number, fill: string) => void;
  disc: (a: number, b: number, r: number, fill: string) => void;
}

/** A print's composition, painted into an opening of half-width `hw` and half-height `hh`. */
type Motif = (g: ArtSurface, hw: number, hh: number) => void;

/**
 * The four prints. Every one of them survives being mirrored, and not by luck: the back-left wall runs
 * `+t` screen-*left*, which is the same quirk that forced the clock onto the right wall. Abstract
 * compositions are the answer — a mirrored cairn is still a cairn, where a mirrored clock lies.
 */
const MOTIFS = {
  /** A sun going down behind two bands of hill. Wants a landscape frame — the horizon is the whole idea. */
  sunrise: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.sky);
    g.disc(hw * 0.08, -hh * 0.12, hh * 0.48, INK.terracotta); // the sun sits *in* the hills, not over them
    g.rect(-hw, -hh, hw, -hh * 0.3, INK.sage);
    g.rect(-hw, -hh, hw, -hh * 0.62, INK.sageDeep);
  },
  /** A cairn of three balanced stones: the one motif whose silhouette alone carries it, so it takes the
   * small portrait frame where nothing else would survive the size. */
  cairn: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    g.rect(-hw, -hh, hw, -hh * 0.72, INK.line);
    g.disc(0, -hh * 0.42, hh * 0.3, INK.terracotta);
    g.disc(hw * 0.1, hh * 0.02, hh * 0.24, INK.teal);
    g.disc(-hw * 0.06, hh * 0.4, hh * 0.17, INK.ochre);
  },
  /** Two arches, overlapping, on a ground line. */
  arches: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    const arch = (a0: number, a1: number, top: number, fill: string): void => {
      g.rect(a0, -hh, a1, top, fill);
      g.disc((a0 + a1) / 2, top, (a1 - a0) / 2, fill); // the dome — its radius is half the pier's width
    };
    arch(hw * 0.14, hw * 0.78, -hh * 0.12, INK.teal);
    arch(-hw * 0.72, -hw * 0.04, hh * 0.1, INK.terracotta);
    g.rect(-hw, -hh, hw, -hh * 0.8, INK.line);
  },
  /** Bauhaus-ish: a cornered quarter-disc, a bar, a floating dot, a rule. The quirky one. */
  bauhaus: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    g.disc(-hw, -hh, hh * 1.15, INK.plum); // the clip is what makes this a quarter, not a circle
    g.rect(hw * 0.04, -hh, hw * 0.44, hh * 0.5, INK.ochre);
    g.disc(hw * 0.62, hh * 0.34, hh * 0.32, INK.terracotta);
    g.rect(-hw, hh * 0.7, hw, hh * 0.78, INK.line);
  },
} satisfies Record<string, Motif>;

type MotifName = keyof typeof MOTIFS;

/** A framed print: frame, mat, and a motif in the opening. `w`/`h` in logical units. */
function wallArt(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  w: number,
  h: number,
  motif: MotifName,
): void {
  // The frame and mat are rendered art (`wall/art-N`, lane 01M5D8EJ40): only the print paints, on the mat.
  const hw = (w / 2) * 0.68; // the mat opening — a composition needs the area a lone colour block didn't
  const hh = (h / 2) * 0.68;
  const p = (a: number, b: number): Pt => wallPt(edge, tc + a / FLOOR, uc + b / WALL_H, fit);
  const g: ArtSurface = {
    rect: (a0, b0, a1, b1, fill) => quad(ctx, [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], fill),
    disc: (a, b, r, fill) => {
      const pts: Pt[] = [];
      for (let i = 0; i < 20; i++) {
        const th = (i / 20) * Math.PI * 2;
        pts.push(p(a + Math.sin(th) * r, b + Math.cos(th) * r));
      }
      quad(ctx, pts, fill);
    },
  };
  // Clip to the opening, so a motif can run a shape straight off the edge — a sun half-under a horizon,
  // a disc cornered into a quarter — instead of every motif having to solve that intersection itself.
  ctx.save();
  ctx.beginPath();
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  corners.forEach(([a, b], i) => {
    const q = p(a, b);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.closePath();
  ctx.clip();
  MOTIFS[motif](g, hw, hh);
  ctx.restore();
}

/**
 * The office wall clock, reading the office's own PST hour — the same number the lighting is computed
 * from, so the hands and the daylight can never disagree (and `?light=22` moves both).
 *
 * Right-hand wall only, and not by taste: on the back-left wall `+t` runs *screen-left*, so a clock hung
 * there would tell the time backwards.
 */
/**
 * The dial's twelve positions. `big` marks the quarters, which are the only ones set as numerals —
 * see `drawClockNumerals` for why twelve numerals cannot work on a 26px face.
 */
export const CLOCK_NUMERALS: ReadonlyArray<{ hour: number; big: boolean }> = [
  { hour: 12, big: true },
  { hour: 1, big: false },
  { hour: 2, big: false },
  { hour: 3, big: true },
  { hour: 4, big: false },
  { hour: 5, big: false },
  { hour: 6, big: true },
  { hour: 7, big: false },
  { hour: 8, big: false },
  { hour: 9, big: true },
  { hour: 10, big: false },
  { hour: 11, big: false },
];

function wallClock(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  hours: number,
): void {
  // The rim, dial and numerals are rendered art (`wall/clock`, lane 01M5D8EJ40): only the hands paint.
  const R = 25;
  // Hands: 12 o'clock is straight up the wall (+u), sweeping clockwise toward +t.
  const hand = (turns: number, len: number, w: number): void => {
    const a = turns * Math.PI * 2;
    const c = wallPt(edge, tc, uc, fit);
    const tip = wallPt(
      edge,
      tc + (Math.sin(a) * len) / FLOOR,
      uc + (Math.cos(a) * len) / WALL_H,
      fit,
    );
    ctx.strokeStyle = DRESS.hand;
    ctx.lineWidth = w * fit.scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  };
  hand((hours % 12) / 12, R * 0.5, 2.4); // the hour hand creeps with the minutes, as a real one does
  hand(hours % 1, R * 0.78, 1.5);
  wallDisc(ctx, fit, edge, tc, uc, 2, DRESS.hand);
}

/**
 * The agile board on the far-right wall — the team's real lanes as sticky notes. This deliberately
 * reverses the 2026-07-30 "set dressing only" decision: the whiteboard it replaced was a drawing of
 * work, this IS the work (nick, 2026-07-31). Same lane board the `/board` page renders, squinted at
 * from across the room — columns mirror `Board.tsx`, and on /live clicking it opens that very board,
 * so the glimpse and the close-up never disagree.
 *
 * What survives the /live downscale (~0.52) is colour and position, not words, so a lane is a
 * ~17×11-unit paper rectangle in its column's tone — above the ~10-unit resolvability floor — with a
 * seeded placement jitter so the wall reads as pinned by hands, not printed. The ONLY type is the
 * `+N` overflow badge at 9 units (the floor at which lettering survives; see the old diagram's
 * hard-won sizing notes in git history). Everything else the board says, it says with paper.
 *
 * It is a **pin board**, not a whiteboard (nick, 2026-08-02) — cork in a thin pale-oak frame, notes
 * held by washi tabs. The whiteboard reading was never only the white face: it was the face plus the
 * marker tray below it, and the tray is gone with it. What the material change buys is that the
 * notes now read as *paper someone put there*, which is what the board is actually claiming.
 *
 * `data` is null when no team is connected (previews, the connect form): the board still hangs,
 * face + caps + dividers, an empty week rather than a missing object.
 */
function wallLaneBoard(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  data: WallBoard | null,
): void {
  const { tc, uc, w: W, h: H } = WALL_BOARD;
  const p = (a: number, b: number): Pt => wallPt(edge, tc + a / FLOOR, uc + b / WALL_H, fit);
  const rect = (a0: number, b0: number, a1: number, b1: number, fill: string): void =>
    quad(ctx, [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], fill);
  const stroke = (pts: [number, number][], width: number, color: string): void => {
    ctx.save();
    ctx.beginPath();
    const s0 = p(pts[0]![0], pts[0]![1]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = p(pts[i]![0], pts[i]![1]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, width * fit.scale);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  };

  // The frame, cork and column caps are rendered art (`wall/board`, lane 01M5D8EJ40): only the notes paint.
  const FR = 3;

  // Six columns inside the frame, right of the gutter the goal tabs hang in (ADR 751). No ruled
  // dividers: cork has no lines on it, and the baked cap strips alone carry the column read.
  const rows = data?.rows?.length ? data.rows : [{ goalId: null, label: '', tone: GOAL_TABS.length - 1 }];
  const { M, a0Cols, rail: RAIL, rowsTop, rowH, cardAt } = boardGrid(rows.length);
  const noteW = BOARD_NOTE.w;
  const noteH = BOARD_NOTE.h;

  // Each goal row: a twine line under it (not under the last), and its washi tab in the gutter.
  rows.forEach((row, r) => {
    const top = rowsTop - r * rowH;
    if (r > 0)
      stroke(
        [
          [-W / 2 + M, top + 0.6],
          [W / 2 - M, top + 0.6],
        ],
        0.5,
        PINBOARD.twine,
      );
    if (!row.label) return;
    const tab = GOAL_TABS[row.tone % GOAL_TABS.length]!;
    const tl = -W / 2 + FR - 1.5; // overhangs the frame, the way an index tab does
    const tr = a0Cols - 2;
    const mid = top - rowH / 2;
    rect(tl, mid - 4.5, tr, mid + 4.5, tab.tape);
    rect(tl, mid + 3.6, tr, mid + 4.5, PINBOARD.tapeSheen);
    // The word fits its tab: a long one is set smaller rather than cut ("security" stays whole).
    const size = Math.min(6.5, (tr - tl - 3.5) / (row.label.length * 0.6));
    wallText(ctx, fit, edge, tc + (tl + 2) / FLOOR, uc + (mid - size * 0.4) / WALL_H, row.label, size, tab.ink);
  });

  for (let i = 0; i < WALLBOARD_TONES.length; i++) {
    const tone = WALLBOARD_TONES[i]!;
    // The cap strip — each column announcing its state even when it holds nothing — is in the render.
    const col = data?.[i];
    if (!col) continue;
    // Where a card at (x, y) in cell (row, this column) hangs: its tape's mid-point on the top edge.
    const at = (row: number, x: number, y: number): [number, number] => cardAt(i, row, x, y);
    // Tack holes first: where a lane hung this week before it moved on, in its own row (lane 01M50WEBTC).
    // At most three to a cell: more read as a scribble on the cork rather than as wear.
    const perCell = new Map<number, number>();
    for (const h of col.holes ?? []) {
      if (h.row >= rows.length) continue;
      const n = (perCell.get(h.row) ?? 0) + 1;
      perCell.set(h.row, n);
      if (n > 3) continue;
      const [hx, hy] = at(h.row, h.x, h.y);
      rect(hx - 0.8, hy - 1.2, hx + 0.8, hy + 0.4, PINBOARD.hole);
    }
    // Oldest first (`projectWallBoard` sorts them), so a pile reads newest on top.
    for (const sticky of col.stickies) {
      if (sticky.row >= rows.length) continue;
      const [cx, top] = at(sticky.row, sticky.x, sticky.y);
      if (sticky.taken) {
        // The tape took the paper with it, but the tack stays: one dark pin hole where the card hung.
        rect(cx - 0.9, top - 1.4, cx + 0.9, top + 0.4, PINBOARD.hole);
        continue;
      }
      // A hand's placement: a seeded tilt of up to ±3°, the same for every viewer.
      const tilt = ((((sticky.seed >>> 7) % 13) - 6) / 6) * 0.052;
      const cos = Math.cos(tilt);
      const sin = Math.sin(tilt);
      // A card that just landed swings on its tape: the bottom edge sways, the top stays put (L5).
      const sw = stickySway(sticky.age) * (noteW / 17);
      const pt = (a: number, b: number, d = 0): Pt => {
        const da = a - cx;
        const db = b - top;
        return p(cx + da * cos - db * sin + d, top + da * sin + db * cos - d);
      };
      const l = cx - noteW / 2;
      const r = cx + noteW / 2;
      const bot = top - noteH;
      quad(ctx, [pt(l, top, 0.6), pt(r, top, 0.6), pt(r + sw, bot, 0.6), pt(l + sw, bot, 0.6)], PINBOARD.noteCast);
      const faded = sticky.faded === true;
      quad(ctx, [pt(l, top), pt(r, top), pt(r + sw, bot), pt(l + sw, bot)], faded ? tone.faded : tone.note);
      if (faded) {
        // A stopped plan's card (lane 01M4V9YKMG): sun-bleached, its bottom-right corner lifting.
        quad(ctx, [pt(r + sw - 3.2, bot), pt(r + sw, bot), pt(r + sw, bot + 2.5)], PINBOARD.curlCast);
        quad(ctx, [pt(r + sw - 2.8, bot + 0.3), pt(r + sw - 0.4, bot + 2.3), pt(r + sw - 0.4, bot + 0.3)], PINBOARD.curlBack);
      }
      // The washi tab, straddling the card's top edge onto the cork — the tape does the holding.
      const tw = 5.5;
      quad(ctx, [pt(cx - tw / 2, top + 1.2), pt(cx + tw / 2, top + 1.2), pt(cx + tw / 2, top - 1.2), pt(cx - tw / 2, top - 1.2)], faded ? tone.fadedTape : tone.tape);
      quad(ctx, [pt(cx - tw / 2, top + 1.2), pt(cx + tw / 2, top + 1.2), pt(cx + tw / 2, top + 0.7), pt(cx - tw / 2, top + 0.7)], PINBOARD.tapeSheen);
    }
  }

  // The read strip (ADR 644 increment 3): an oak rail across the board, and under it one tag per dated
  // read, left to right in the Experiments section's order. Status only, and by paper and pin rather
  // than by words: an overdue tag is amber and has slipped on its pin, a read tag carries a tick, a
  // waiting one is the plainest paper on the board. The section beside the room says the rest.
  rect(-W / 2 + FR, RAIL - 1.6, W / 2 - FR, RAIL, PINBOARD.oak);
  stroke(
    [
      [-W / 2 + FR, RAIL],
      [W / 2 - FR, RAIL],
    ],
    0.7,
    PINBOARD.oakLit,
  );
  stroke(
    [
      [-W / 2 + FR, RAIL - 1.6],
      [W / 2 - FR, RAIL - 1.6],
    ],
    0.7,
    PINBOARD.inner,
  );
  const pins = readPins(data?.reads);
  const slotW = (W - M * 2) / READ_PIN_CAP;
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i]!;
    const look = READ_TAGS[pin];
    const c = -W / 2 + M + (i + 0.5) * slotW + ((i * 7) % 3) - 1; // a hand's placement, not a grid
    const top = RAIL - 3.4;
    const tw = 10;
    const th = 8;
    const slip = pin === 'overdue' ? 2.6 : 0; // hung from one pin, the tag swings out of true
    quad(
      ctx,
      [
        p(c - tw / 2 + 0.8, top - 0.8),
        p(c + tw / 2 + 0.8, top - 0.8),
        p(c + tw / 2 + 0.8 + slip, top - th - 0.8),
        p(c - tw / 2 + 0.8 + slip, top - th - 0.8),
      ],
      PINBOARD.noteCast,
    );
    quad(
      ctx,
      [
        p(c - tw / 2, top),
        p(c + tw / 2, top),
        p(c + tw / 2 + slip, top - th),
        p(c - tw / 2 + slip, top - th),
      ],
      look.tag,
    );
    const mid = c + slip / 2;
    if (pin === 'read')
      stroke(
        [
          [mid - 2.4, top - 4.2],
          [mid - 0.8, top - 5.8],
          [mid + 2.6, top - 2.4],
        ],
        1,
        look.mark!,
      );
    if (pin === 'more') {
      stroke(
        [
          [mid - 2.4, top - 4.2],
          [mid + 2.4, top - 4.2],
        ],
        1,
        look.mark!,
      );
      stroke(
        [
          [mid, top - 1.8],
          [mid, top - 6.6],
        ],
        1,
        look.mark!,
      );
    }
    rect(c - 1.2, top - 1.8, c + 1.2, top + 0.6, look.pin); // the tack's head
  }

  // Frame thickness — the outer edge of the oak, so the board reads as an object standing off the wall.
  stroke(
    [
      [-W / 2, -H / 2],
      [W / 2, -H / 2],
      [W / 2, H / 2],
      [-W / 2, H / 2],
      [-W / 2, -H / 2],
    ],
    0.9,
    PINBOARD.oakShade,
  );
}

/**
 * Column tones, one per `WALL_COLUMNS` entry in order. Canvas can't read CSS custom properties, so
 * these mirror Live.css's lane/danger/success tones as hex the way `WHITEBOARD` already does: `cap`
 * is the full-value state colour, `note` its paper-pastel wash. Board columns, left to right:
 * open · claimed · active · blocked · awaiting_acceptance · done.
 *
 * `tape` is the washi tab holding each note to the cork: the cap colour at ~75%, so the tab reads as
 * translucent paper tape over both the note and the cork behind it. Written out rather than derived
 * because canvas takes a colour string, and a per-note hex→rgba conversion would run every frame.
 *
 * `faded` / `fadedTape` are the sun-bleached pair for a stopped plan's cards (lane 01M4V9YKMG):
 * the note pulled 55% toward old-newsprint grey (#DAD5CB) and the tab at half its presence — the
 * same paper, left in the window too long. (Pulling toward white was tried first, 2026-10-13: at the
 * wall's scale a whiter cream card read as pale, not old; yellowed grey reads as old beside fresh.)
 */
const WALLBOARD_TONES: ReadonlyArray<{
  cap: string;
  note: string;
  tape: string;
  faded: string;
  fadedTape: string;
}> = [
  // open — warm unbleached paper
  {
    cap: '#B4A88F',
    note: '#EFE8D8',
    tape: 'rgba(180, 168, 143, 0.75)',
    faded: '#E4DED1',
    fadedTape: 'rgba(180, 168, 143, 0.35)',
  },
  // claimed — lane blue, lightened: picked up, not yet moving
  {
    cap: '#8FB0E6',
    note: '#E2EBF8',
    tape: 'rgba(143, 176, 230, 0.75)',
    faded: '#DEDFDF',
    fadedTape: 'rgba(143, 176, 230, 0.35)',
  },
  // active — the lane tone itself (--lc-lane)
  {
    cap: '#3F74C4',
    note: '#D6E2F4',
    tape: 'rgba(63, 116, 196, 0.75)',
    faded: '#D8DBDE',
    fadedTape: 'rgba(63, 116, 196, 0.35)',
  },
  // blocked — --lc-danger
  {
    cap: '#D1503F',
    note: '#F5DAD4',
    tape: 'rgba(209, 80, 63, 0.75)',
    faded: '#E6D7CF',
    fadedTape: 'rgba(209, 80, 63, 0.35)',
  },
  // awaiting acceptance — blue leaning patient
  {
    cap: '#6A93D4',
    note: '#DDE6F6',
    tape: 'rgba(106, 147, 212, 0.75)',
    faded: '#DBDDDE',
    fadedTape: 'rgba(106, 147, 212, 0.35)',
  },
  // done — --lc-success
  {
    cap: '#2F9E6A',
    note: '#D5ECDF',
    tape: 'rgba(47, 158, 106, 0.75)',
    faded: '#D8DFD4',
    fadedTape: 'rgba(47, 158, 106, 0.35)',
  },
];

/**
 * The read strip's tags (ADR 644 increment 3), one per `read_status` plus the "+" card. Overdue is
 * the only accent, as in the Experiments section: the wash is `--lc-accent` pulled toward paper and
 * the tack is the accent itself. The rest are neutral paper told apart by the tack: dark ink for
 * due, pale for waiting, mid for read (which also carries a tick).
 */
const READ_TAGS: Record<ReadStatus | 'more', { tag: string; pin: string; mark?: string }> = {
  overdue: { tag: '#F6DFA4', pin: '#B8860B' },
  due: { tag: '#FFFDF6', pin: '#3B3026' },
  waiting: { tag: '#EDE6D8', pin: '#D9CFBE' },
  read: { tag: '#FFFDF6', pin: '#8E8578', mark: '#5E5446' },
  more: { tag: '#FFFDF6', pin: '#8E8578', mark: '#5E5446' },
};

/**
 * The pin board's materials: pale oak, cork, and the shadows that seat one inside the other.
 *
 * The frame is deliberately *lighter* than the cork it holds. The instinct with a bulletin board is a
 * dark surround, and it is wrong here for a specific reason: this wall is warm cream, and a dark
 * frame on it reads as a hole punched through the wall. A pale one reads as a lit edge — and it
 * demotes the frame, which matters, because the loudest thing on this object has to stay the notes.
 */
const PINBOARD = {
  oak: '#DCBF8E',
  /** The top lip, where the window light lands. */
  oakLit: '#F0DCB4',
  /** Underside and outer edge — the frame's own thickness. */
  oakShade: '#B9915F',
  cork: '#C98F52',
  /** Three freckle tones: two lighter than the cork, one darker, so the surface reads as grain. */
  fleck: ['#B87C42', '#D9A468', '#AB7038'],
  /** The frame's shadow falling onto the cork, along the inside of the top lip. */
  inner: 'rgba(80, 45, 15, 0.35)',
  cast: 'rgba(58, 34, 12, 0.16)',
  /** A tack hole in the cork: dark and a little bigger than a freckle, or it vanishes at room zoom. */
  hole: 'rgba(52, 28, 8, 0.75)',
  /** Under each note — paper held off the cork by its tape, not printed onto it. */
  noteCast: 'rgba(60, 35, 10, 0.26)',
  /** The washi tab's own highlight; without it the tape is just a painted stripe. */
  tapeSheen: 'rgba(255, 251, 240, 0.5)',
  /** A faded card's lifted corner: the shadow it throws on the cork, and the paper's lighter back. */
  curlCast: 'rgba(60, 35, 10, 0.22)',
  curlBack: '#FFFDF8',
  /** The twine strung between goal rows (ADR 751): there, but quieter than any card. */
  twine: 'rgba(110, 70, 30, 0.35)',
} as const;

/** The wall board's inner layout in board units (ADR 751): the column band right of the tab gutter,
 *  and the goal rows between the caps and the read strip's rail. One home for the painter and for
 *  anything that needs to find a card on the board from outside it. */
function boardGrid(rowCount: number) {
  const { w: W, h: H } = WALL_BOARD;
  const M = 3 + 2;
  const a0Cols = -W / 2 + M + BOARD_GUTTER;
  const colW = (W - M * 2 - BOARD_GUTTER) / WALL_COLUMNS.length;
  const rail = -H / 2 + 14;
  const rowsTop = H / 2 - M - 5;
  const rowH = (rowsTop - (rail + 1.5)) / Math.max(1, rowCount);
  /** A card at (x, y) in cell (row, column): where its tape's mid-point sits on the board. */
  const cardAt = (col: number, row: number, x: number, y: number): [number, number] => [
    a0Cols + col * colW + 1 + BOARD_NOTE.w / 2 + x * (colW - 2 - BOARD_NOTE.w),
    rowsTop - row * rowH - 2 - y * Math.max(0, rowH - BOARD_NOTE.h - 3),
  ];
  return { M, a0Cols, colW, rail, rowsTop, rowH, cardAt };
}

/** A card on the wall board, in board units. */
const BOARD_NOTE = { w: 11, h: 8 } as const;

/** Where a card's spot on the wall board is on screen — for the puff when a card moves with nobody
 *  in the room to move it (ADR 751). */
export function boardSpotPoint(
  fit: Fit,
  rowCount: number,
  spot: { state: LaneState; row: number; x: number; y: number },
): Pt {
  const g = boardGrid(rowCount);
  const [a, b] = g.cardAt(Math.max(0, WALL_COLUMNS.indexOf(spot.state)), spot.row, spot.x, spot.y);
  const { tc, uc, wall } = WALL_BOARD;
  return wallPt(WALL_EDGES[wall]!, tc + a / FLOOR, uc + (b - BOARD_NOTE.h / 2) / WALL_H, fit);
}

/** Where the wastebasket's mouth is on screen: the end of a thrown ball's flight. */
export function binMouthPoint(fit: Fit): Pt {
  const p = project(BIN.lx, BIN.ly, fit);
  return { x: p.x, y: p.y - 15 * fit.scale };
}

/** How many paper balls the wastebasket shows before it reads as full. */
const BIN_BALLS = 6;
/** Where each ball sits in the bin's mouth (floor units from its centre, and how far above the rim):
 *  the first three in the mouth, the rest piled on them and peeking over the rim. */
const BALL_SPOTS: ReadonlyArray<[number, number, number]> = [
  [-2.2, 1.0, 0],
  [2.0, -1.4, 0],
  [0.4, 2.4, 0],
  [-0.6, -0.4, 2.6],
  [2.4, 1.8, 2.2],
  [-2.6, -2.0, 2.0],
];

/** A crumpled ball of a lane's card: off-white paper, a shaded side and two crease lines. */
export function drawPaperBall(c: CanvasRenderingContext2D, x: number, y: number, r: number, spin = 0): void {
  c.save();
  c.translate(x, y);
  c.rotate(spin);
  c.fillStyle = '#F4EFE3';
  c.beginPath();
  // Not a circle: seven knuckles of folded paper.
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const rr = r * (0.84 + ((k * 37) % 5) * 0.05);
    if (k === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(120, 100, 70, 0.28)';
  c.beginPath();
  c.arc(r * 0.25, r * 0.25, r * 0.7, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(110, 90, 60, 0.55)';
  c.lineWidth = Math.max(0.5, r * 0.18);
  c.beginPath();
  c.moveTo(-r * 0.5, -r * 0.2);
  c.lineTo(r * 0.1, r * 0.15);
  c.lineTo(r * 0.45, -r * 0.35);
  c.stroke();
  c.restore();
}

function paperBalls(c: CanvasRenderingContext2D, fit: Fit, n: number): void {
  const r = 3 * fit.scale;
  for (let i = 0; i < n; i++) {
    const [dx, dy, up] = BALL_SPOTS[i]!;
    const p = project(BIN.lx + dx, BIN.ly + dy, fit);
    drawPaperBall(c, p.x, p.y - (14.5 + up) * fit.scale, r, i * 1.7);
  }
}

/** The left gutter of the wall board where the goal tabs hang (ADR 751), in board units. */
const BOARD_GUTTER = 26;

/**
 * The goal rows' washi tabs (ADR 751): one tape per row, then the everything-else row's plain kraft.
 * Muted against the state colours of the cards, so a tab names a row without reading as a state.
 */
const GOAL_TABS: ReadonlyArray<{ tape: string; ink: string }> = [
  { tape: '#E9C46A', ink: '#4A3A12' },
  { tape: '#A8C5A0', ink: '#24401F' },
  { tape: '#E5A9A0', ink: '#4D211B' },
  { tape: '#B7B0D8', ink: '#2E2850' },
  { tape: '#D9CBB0', ink: '#4A3A26' },
];

/**
 * Type lying ON a wall, sheared onto its plane rather than pasted over it in screen space.
 *
 * The wall's local frame, in the units the rest of this file already uses: one step along `t` is one
 * logical FLOOR unit, which projects to (KX, KY)·scale; one step of `u` is one WALL_H px, which is
 * (0, −1)·scale. Feeding those as a matrix puts the glyphs on the wall, leaning with the isometric.
 *
 * Two things this must get right. Local y runs **down** the wall (the matrix's `d` is +scale, not
 * −scale): canvas glyphs extend in +y from the baseline, so an up-positive frame draws every letter
 * upside down. And it composes with `transform`, never `setTransform` — the context already carries the
 * device-pixel-ratio matrix, and replacing it outright would paint this text at the wrong size on
 * every retina display.
 */
function wallText(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  t: number,
  u: number,
  text: string,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'left',
): void {
  const o = wallPt(edge, t, u, fit);
  ctx.save();
  ctx.translate(o.x, o.y);
  const cam = cameraOf(fit);
  ctx.transform(cam.kx * fit.scale, cam.ky * fit.scale, 0, fit.scale, 0, 0);
  ctx.font = canvasFont(size, '--font-sans', 700);
  ctx.fillStyle = fill;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * The largest of `size` that still fits `text` inside `maxUnits` logical wall units. Measured with the
 * wall transform *off*: one text unit is one logical FLOOR unit either way, and `measureText` is the only
 * honest answer once copy is data (a schedule can say `MON · WED · FRI` as easily as `MON–FRI`).
 */
function fitTextSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  maxUnits: number,
): number {
  ctx.save();
  ctx.font = canvasFont(size, '--font-sans', 700);
  const width = ctx.measureText(text).width;
  ctx.restore();
  return width > maxUnits ? (size * maxUnits) / width : size;
}

/**
 * What paints on the rendered walls (lane 01M5D8EJ40). The faces, windows, frames, mats, the planter, the
 * clock's dial and the board's cork are in the room render and `wall/*` assets; this draws what is live or
 * printed over them: the prints on their mats, the clock's hands (it reads the office hour), the
 * working-hours sign (it reads `t`), the lane board's notes (they read the live board), and both walls'
 * bulb strands.
 *
 * The strands paint on the stage every frame, never into the background sprite: their glows composite
 * with `lighter`, which ADDS to whatever is already on the canvas. Rasterised into their own sprite they
 * added to transparency, and blitting that back source-over replaced the wall rather than brightening it
 * (the first sprite-cache cut failed the pixel gate 10/10 states at 14% of pixels on exactly this).
 */
export function drawWalls(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  teamWorkingHours: WorkingHours | null = null,
  wallBoard: WallBoard | null = null,
  t = 0,
  /** The paint-sequence hook (RenderOpts.units): each live fixture is its own unit, so the sign's
   *  animation damages the sign and not the clock and the board beside it. */
  run: (draw: () => void) => void = (draw) => draw(),
  /** The wall fixtures' assets: the prints' frames, the planter, the clock body and the board blit here. */
  art: RenderedAssets,
  /** The sky at the windows (lane 01M5XS6597): clear draws nothing, the rest paint over the panes. */
  weather: Weather = 'clear',
  /** The shelf chimes' strike times (RenderOpts.chimes). */
  chimes?: readonly number[],
): void {
  /**
   * What each wall carries. The right wall gets the clock (it is the only one whose `+t` runs screen-right,
   * so it is the only one a clock can be hung on) plus a print over the corner bookshelf and a pair by the
   * corner; the left wall gets a tall print between its windows and the hanging planter. Nothing sits below
   * u 0.36 (the bookshelves' height) or inside a window's `t` span.
   */
  const dress = (edge: (t: number) => [number, number], wallIndex: 0 | 1): void => {
    // Nothing goes high near the back corner: that is where the wall is tallest on screen and the canvas
    // crops its top edge, so anything hung up there loses the wall behind it and floats.
    ART.forEach((a, i) => {
      if (a.wall !== wallIndex) return;
      // the frame and mat blit at the print's floor point, and the print paints on the mat
      const [fx, fy] = edge(a.tc);
      if (blitIf(ctx, fit, art, `wall/art-${i}`, fx, fy))
        wallArt(ctx, fit, edge, a.tc, a.uc, a.w, a.h, a.motif);
    });
    if (wallIndex === 1) {
      const [cx, cy] = edge(0.52);
      run(() => {
        if (blitIf(ctx, fit, art, 'wall/clock', cx, cy))
          wallClock(ctx, fit, edge, 0.52, 0.62, env.hours); // dead centre, between the windows
      });
      // Painted with or without a schedule: on /live it is the door to the team's settings, so a team
      // that never set hours still needs something to reach for (nick, 2026-10-19).
      run(() => workingHoursSign(ctx, fit, edge, teamWorkingHours, t));
      // The agile board — far-right gap. Must be THIS wall: `+t` runs screen-left on the other one
      // (same constraint that fixed the clock here), and a kanban has a reading direction.
      const [bx, by] = edge(WALL_BOARD.tc);
      run(() => {
        if (blitIf(ctx, fit, art, 'wall/board', bx, by)) wallLaneBoard(ctx, fit, edge, wallBoard);
      });
      // The shelf chimes over the board (sound identity inc 4): its own unit, so a swinging bar
      // damages the chimes and not the board under them.
      run(() => shelfChimes(ctx, fit, edge, chimes, t));
      return;
    }
    const [hx, hy] = edge(0.52);
    blitIf(ctx, fit, art, 'wall/hanger', hx, hy); // between the windows — where you'd really hang one
  };
  // back-left wall (lx=0 edge): a print, the planter, and its strand. It carries no live fixture.
  dress(WALL_EDGES[0]!, 0);
  run(() => drawWeather(ctx, fit, WALL_EDGES[0]!, weather, t));
  run(() => cableStrand(ctx, fit, WALL_EDGES[0]!));
  // back-right wall (ly=0 edge): the clock, sign and board, then its strand over them.
  dress(WALL_EDGES[1]!, 1);
  run(() => drawWeather(ctx, fit, WALL_EDGES[1]!, weather, t));
  run(() => cableStrand(ctx, fit, WALL_EDGES[1]!));
}

/** A stable unit in [0, 1) per weather particle — rebakes reposition nothing. */
function weatherRnd(n: number): number {
  let h = Math.imul(n ^ 0x5bd1e995, 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Weather at the windows (lane 01M5XS6597): the sky outside, drawn over each pane on one wall and
 * nowhere else — a clip per window, so a looping overlay costs the window region alone. Clear draws
 * nothing. Cloudy and snow grey the glass; rain darkens it. Rain is a dozen thin diagonal streaks per
 * pane falling down the glass with the clock; snow is a few flakes drifting down and wobbling. Both are
 * in wall (t, u) space through `wallPt`, so they lean with the wall like the mullions do.
 */
/** How long a struck bar swings, seconds — the bar voice's decay (`strikeBar`, 1.8 s). */
export const CHIME_SWING_S = 1.8;

/** A struck bar's angle off plumb at `dt` seconds after the strike, radians: a damped swing that
 *  starts at the hit and dies with the note. Pure, so the test can hold its shape. */
export function chimeSwing(dt: number): number {
  if (!(dt >= 0) || dt >= CHIME_SWING_S) return 0;
  // 0.26 → 0.42 rad and a slower die-off (2026-10-28): at the panel's scale a bar is ~18 px long, and a
  // quarter-radian swing was 4 px of travel — real, but not a thing a viewer catches. Twice that reads.
  return 0.42 * Math.sin(2 * Math.PI * 1.5 * dt) * Math.exp(-dt / 0.75);
}

/**
 * The shelf chimes (sound identity spec §2.2, inc 4): a short oak rail on the wall over the board's
 * left half, eight wood bars with a brass sleeve hanging from it, longest (C4) on the left. A bar
 * struck within `CHIME_SWING_S` swings in the wall's plane and glows warm for the length of its note,
 * so a viewer who looks can see which one rang. Resting, it is eight quiet bars and nothing moves.
 */
function shelfChimes(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  hits: readonly number[] | undefined,
  t: number,
): void {
  const { tc, uc, w: W, len, hang, thick } = SHELF_CHIMES;
  const T = (dx: number): number => tc + dx / FLOOR;
  const U = (dy: number): number => uc + dy / WALL_H;
  const s = fit.scale;
  // the rail and its shadow line
  wallRect(ctx, fit, edge, T(-W / 2), U(-1.6), T(W / 2), U(1.4), '#5a3d26');
  wallRect(ctx, fit, edge, T(-W / 2), U(0.6), T(W / 2), U(1.4), '#8a6440');
  const n = len.length;
  const step = W / n;
  for (let i = 0; i < n; i++) {
    const a = -W / 2 + step * (i + 0.5);
    const L = len[i]!;
    const dt = hits ? t - (hits[i] ?? -Infinity) : Infinity;
    const th = chimeSwing(dt);
    const top = wallPt(edge, T(a), U(-1.6), fit);
    // the bar's hang point is the end of its string; the bar swings about that point
    const px = a + hang * Math.sin(th);
    const py = -1.6 - hang * Math.cos(th);
    const bx = px + L * Math.sin(th);
    const by = py - L * Math.cos(th);
    const p0 = wallPt(edge, T(px), U(py), fit);
    const p1 = wallPt(edge, T(bx), U(by), fit);
    ctx.save();
    ctx.lineCap = 'round';
    // string
    ctx.strokeStyle = 'rgba(40, 28, 18, 0.7)';
    ctx.lineWidth = Math.max(0.5, 0.5 * s);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(p0.x, p0.y);
    ctx.stroke();
    // the glow of a ringing bar, under it
    if (th !== 0 || (dt >= 0 && dt < CHIME_SWING_S)) {
      ctx.strokeStyle = `rgba(255, 214, 140, ${(0.55 * Math.exp(-dt / 0.7)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, thick * 2.2 * s);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    // the bar: oak, with a brass sleeve a third of the way down
    ctx.strokeStyle = '#a07a4c';
    ctx.lineWidth = Math.max(1, thick * s);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    const s0 = { x: p0.x + (p1.x - p0.x) * 0.3, y: p0.y + (p1.y - p0.y) * 0.3 };
    const s1 = { x: p0.x + (p1.x - p0.x) * 0.46, y: p0.y + (p1.y - p0.y) * 0.46 };
    ctx.strokeStyle = '#d9b36a';
    ctx.lineWidth = Math.max(1, thick * 1.1 * s);
    ctx.beginPath();
    ctx.moveTo(s0.x, s0.y);
    ctx.lineTo(s1.x, s1.y);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawWeather(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  weather: Weather,
  t: number,
): void {
  if (weather === 'clear') return;
  const tint =
    weather === 'rain'
      ? 'rgba(88, 100, 122, 0.34)'
      : weather === 'snow'
        ? 'rgba(196, 204, 216, 0.30)'
        : 'rgba(128, 138, 156, 0.24)';
  const u = fit.scale;
  WINDOWS.forEach((w, wi) => {
    const a = wallPt(edge, w.t0, w.u0, fit);
    const b = wallPt(edge, w.t1, w.u0, fit);
    const c = wallPt(edge, w.t1, w.u1, fit);
    const d = wallPt(edge, w.t0, w.u1, fit);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = tint;
    ctx.fill();
    const span = w.t1 - w.t0;
    const rise = w.u1 - w.u0;
    if (weather === 'rain') {
      ctx.strokeStyle = 'rgba(225, 236, 250, 0.42)';
      ctx.lineWidth = Math.max(1, 0.9 * u);
      ctx.beginPath();
      for (let i = 0; i < 14; i++) {
        const n = wi * 40 + i;
        const tx = w.t0 + weatherRnd(n) * span;
        // down the glass with the clock, each streak on its own phase; 1.4 pane-heights a second
        const ph = (weatherRnd(n + 1) + t * 1.4) % 1;
        const top = w.u1 - ph * (rise + 0.1);
        const p0 = wallPt(edge, tx, top, fit);
        const p1 = wallPt(edge, tx + 0.004, top - 0.07, fit);
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.stroke();
    } else if (weather === 'snow') {
      ctx.fillStyle = 'rgba(250, 252, 255, 0.85)';
      for (let i = 0; i < 10; i++) {
        const n = wi * 40 + i;
        const ph = (weatherRnd(n + 1) + t * 0.16) % 1; // a flake takes ~6 s to cross the pane
        const wob = Math.sin(t * 1.3 + weatherRnd(n + 2) * 6.28) * 0.012;
        const tx = w.t0 + 0.05 * span + weatherRnd(n) * 0.9 * span + wob;
        const p = wallPt(edge, tx, w.u1 - ph * (rise + 0.05), fit);
        ctx.beginPath();
        ctx.arc(p.x, p.y, (1 + weatherRnd(n + 3)) * 1.1 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  });
}

/**
 * A low, slightly sagging strand of warm bulbs — it turns the architectural shell into a place
 * people chose to inhabit. The bulbs stay on in daylight too, but read as tiny pearl pins rather
 * than glare. Its own function because it paints on the stage, over the blitted wall (see `drawWalls`).
 */
function cableStrand(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
): void {
  const cable = cablePts(edge, fit);
  ctx.save();
  ctx.strokeStyle = 'rgba(91, 61, 38, 0.46)';
  ctx.lineWidth = Math.max(0.7, 1.25 * fit.scale);
  ctx.beginPath();
  cable.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 1; i < cable.length - 1; i += 2) {
    const p = cable[i]!;
    const r = 8 * fit.scale;
    const glow = ctx.createRadialGradient(p.x, p.y + 2 * fit.scale, 0, p.x, p.y + 2 * fit.scale, r);
    glow.addColorStop(0, 'rgba(255, 236, 166, 0.76)');
    glow.addColorStop(0.25, 'rgba(255, 190, 82, 0.35)');
    glow.addColorStop(1, 'rgba(255, 190, 82, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y + 2 * fit.scale, r, 0, Math.PI * 2);
    ctx.fill();
    ellipse(ctx, { x: p.x, y: p.y + 2 * fit.scale }, 2.4 * fit.scale, 2.9 * fit.scale, '#fff0b0');
  }
  ctx.restore();
}

/** Monday-first, the order the week strip reads in. */
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** The wall calendar that turns the Team's recurring schedule into a warm office ritual. */
function workingHoursSign(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  schedule: WorkingHours | null,
  t: number,
): void {
  // No schedule is a schedule too: the sheet says so plainly, and the week strip stays unlit.
  const copy = formatWorkingHours(schedule) ?? { days: 'ANY DAY', hours: 'no set hours' };
  const { tc, uc, w: W, h: H } = WORKING_HOURS_CALENDAR;
  // Everything below is laid out in logical wall units off the card's centre, because that is the space
  // the copy is measured in too — mixing the two is what let the schedule line run off the paper.
  const T = (dx: number): number => tc + dx / FLOOR;
  const U = (dy: number): number => uc + dy / WALL_H;
  const halfW = W / 2;
  const halfH = H / 2;
  const INNER = W - 18; // the paper's printable width: card less frame, trim and a breathing margin either side

  const BAND = halfH - 16; // the mustard header's lower edge — the paper proper starts here

  // No hanging cord: the clock's dial comes within a few units of the frame, and a cord tall enough to
  // read would cross it. The card sits flush, like the art on the same wall.
  ctx.save();
  ctx.globalAlpha = 0.22;
  wallRect(ctx, fit, edge, T(-halfW + 6), U(-halfH - 6), T(halfW + 6), U(halfH - 6), '#503522');
  ctx.globalAlpha = 1;
  wallRect(ctx, fit, edge, T(-halfW), U(-halfH), T(halfW), U(halfH), '#6a4a30'); // oak frame
  wallRect(ctx, fit, edge, T(-halfW), U(halfH - 2), T(halfW), U(halfH), '#8a6440'); // its sunlit top edge
  wallRect(ctx, fit, edge, T(-halfW + 2), U(-halfH + 2), T(halfW - 2), U(halfH - 2), '#c39a41'); // brass trim
  wallRect(ctx, fit, edge, T(-halfW + 4), U(-halfH + 4), T(halfW - 4), U(halfH - 4), '#fbf1d8'); // paper

  // The header: mustard, with a hairline of shadow under it so the band sits *on* the sheet.
  wallRect(ctx, fit, edge, T(-halfW + 4), U(BAND), T(halfW - 4), U(halfH - 4), '#e1ad01');
  wallRect(
    ctx,
    fit,
    edge,
    T(-halfW + 4),
    U(BAND - 1.5),
    T(halfW - 4),
    U(BAND),
    'rgba(120,84,20,0.28)',
  );
  // Two punched holes in the band, the way a wall calendar's top sheet is punched.
  for (const dx of [-halfW + 12, halfW - 12])
    wallDisc(ctx, fit, edge, T(dx), U(halfH - 9), 2.2, '#b8862a');

  // The days on the band, the hours across the sheet. Both shrink to the paper rather than overrun it:
  // days can be a list ("MON · WED · FRI"), not just a run.
  const line = (dy: number, text: string, size: number, fill: string): void =>
    wallText(ctx, fit, edge, tc, U(dy), text, fitTextSize(ctx, text, size, INNER), fill, 'center');
  line(halfH - 13, copy.days, 11.5, '#4e331f');
  line(-7, copy.hours, 16, '#33261c');

  // A hairline rule, then a week strip: seven marks, the working ones filled. The strip says what the
  // days line says in the one language that survives being eight pixels tall, and gives the sheet a
  // foot to stand on rather than trailing off into blank paper.
  wallRect(ctx, fit, edge, T(-halfW + 13), U(-12), T(halfW - 13), U(-11.3), 'rgba(120,96,60,0.18)');
  const on = new Set(schedule?.days ?? []);
  WEEK.forEach((day, i) => {
    const dx = (i - 3) * 11;
    const lit = on.has(day);
    wallDisc(ctx, fit, edge, T(dx), U(-17.5), 3.4, lit ? '#e1ad01' : 'rgba(120,96,60,0.2)');
    if (lit) wallDisc(ctx, fit, edge, T(dx), U(-17.5), 1.5, '#7a5a1c');
  });

  // A brass tack in the header gives the card a restrained life. t=0 is its complete, static
  // reduced-motion posture.
  ctx.globalAlpha = 0.72 + Math.sin(t * 1.2) * 0.08;
  wallDisc(ctx, fit, edge, T(-halfW + 12), U(halfH - 9), 1.1, '#f4dc9a');
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Deterministic 0..1 hash — the ambient-magic anchors must not shuffle on every rebake. */
function magicRnd(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The FURNISHED room, as a fit box (iso.ts `FitBox`): what /live and /broadcast fit to instead of the
 * whole scene. The whole-scene box spends the panel on things nobody watches — the back-wall tops at the
 * corner, the string-light headroom, the slab and its contact shadow — so fitting it left the people and
 * plates smaller than they need be (nick, 2026-10-01, from mocked framings 1.00–1.25).
 *
 * Every edge is read from what is drawn there, not chosen:
 *   left   the entrance door's outer post — arrivals walk in through it, so it is never cropped;
 *   right  the agile board's outer edge (`boardAnchor`) — a click target on /live;
 *   top    the walls, minus `TOP_TRIM` at the back corner where they stand tallest and carry nothing;
 *   bottom the floor's front tip and its slab edge, minus the contact shadow pooled under it.
 * Horizontally the door and the board sit within ~30 units of the room's corners, so the gain is almost
 * all vertical: a height-bound panel grows ~10%, a width-bound one barely moves but never loses the door.
 */
const FURNISHED_PAD = 6;
const TOP_TRIM = 24;
export function furnishedBox(cam: Camera = CORNER_CAMERA): FitBox {
  const unit: Fit = { ox: 0, oy: 0, scale: 1, cam };
  const doorPlane = ENTRANCE.lx - 42; // drawEntrance's `wx`
  const doorOuter = project(doorPlane, ENTRANCE.ly + 44 + 5, unit); // the outer post, half its 10 out
  const board = boardAnchor(unit);
  return {
    left: doorOuter.x - FURNISHED_PAD,
    right: board.x + board.w + FURNISHED_PAD,
    top: -WALL_H + TOP_TRIM,
    bottom: FLOOR * cam.ky * 2 + THICK,
  };
}

/**
 * The agile board's screen-space bounding box — the DOM hotspot on /live is positioned from this
 * (the `magicAnchors` pattern: pure geometry out, index.ts places the element). The wall shears the
 * board, so the box brackets all four projected corners rather than trusting any two.
 */
/**
 * The working-hours calendar's screen box, for the settings hotspot laid over it on /live — the same
 * corner projection `boardAnchor` uses, on the same wall. Axis-aligned bounds of the four corners: the
 * wall is slanted, so the box is a little taller than the card, which only makes it easier to hit.
 */
export function hoursAnchor(fit: Fit): {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the settings tab attaches, relative to the box: the left end of the middle 60% of the
   *  frame's bottom edge, and that span's width across the screen. /live fixes the tab flush under it — the wall clock sits directly above the
   *  calendar, and its header band carries the days. `unit` is one wall unit in screen px. */
  foot: { x: number; y: number; w: number; unit: number };
  /** The slope of the calendar's edges in screen degrees, as `boardAnchor.tiltDeg`. */
  tiltDeg: number;
} {
  const { tc, uc, w: W, h: H, wall } = WORKING_HOURS_CALENDAR;
  const edge = WALL_EDGES[wall]!;
  const corners = [
    wallPt(edge, tc - W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
    wallPt(edge, tc - W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // The frame's bottom edge: the screen-left and screen-right of its two lower corners.
  const [l, r] =
    corners[0]!.x <= corners[1]!.x ? [corners[0]!, corners[1]!] : [corners[1]!, corners[0]!];
  const tiltDeg = (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    // The tab spans the middle 60% of the edge; its left end sits ON the slanted edge, not level
    // with the frame's corner, or the skew leaves it hanging off (nick, 2026-10-20).
    foot: {
      x: l.x + (r.x - l.x) * 0.2 - x,
      y: l.y + (r.y - l.y) * 0.2 - y,
      w: (r.x - l.x) * 0.6,
      unit: fit.scale,
    },
    tiltDeg,
  };
}

export function boardAnchor(fit: Fit): {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Screen y of the middle of the board's top edge — where its sign hangs. On a slanted wall the
   *  box's top is the high corner, so this sits lower than `y`. */
  topMidY: number;
  /** The slope of the board's top edge in screen degrees — the wall's iso angle, which the sign
   *  is skewed by so it lies in the wall's plane rather than flat on the screen. */
  tiltDeg: number;
} {
  const { tc, uc, w: W, h: H } = WALL_BOARD;
  const edge = WALL_EDGES[WALL_BOARD.wall]!;
  const corners = [
    wallPt(edge, tc - W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
    wallPt(edge, tc - W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const lo = wallPt(edge, tc, uc - H / 2 / WALL_H, fit).y;
  const hi = wallPt(edge, tc, uc + H / 2 / WALL_H, fit).y;
  const topMidY = Math.min(lo, hi);
  // The top edge's two corners: the pair at whichever height `topMidY` came from.
  const [l, r] = lo <= hi ? [corners[0]!, corners[1]!] : [corners[3]!, corners[2]!];
  const tiltDeg = (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, topMidY, tiltDeg };
}

/**
 * The wiki shelf's screen box (ADR 747), for the hotspot /live lays over it — the shelf's footprint
 * and its top, projected, as `boardAnchor` does the board. `topMidY` is the middle of the shelf's
 * back top edge, where it meets the wall: the sign hangs on the wall above it. `tiltDeg` is that
 * edge's slope, so the sign skews into the wall's plane like the board's.
 */
export function shelfAnchor(fit: Fit): {
  x: number;
  y: number;
  w: number;
  h: number;
  topMidY: number;
  tiltDeg: number;
} {
  const s = BOOKSHELVES[WIKI_SHELF]!;
  const alongY = s.dir === 'E' || s.dir === 'W';
  const [hx, hy] = alongY ? [s.deep / 2, s.long / 2] : [s.long / 2, s.deep / 2];
  const rise = s.high * fit.scale;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const dx of [-hx, hx]) {
    for (const dy of [-hy, hy]) {
      const p = project(s.lx + dx, s.ly + dy, fit);
      xs.push(p.x);
      ys.push(p.y, p.y - rise);
    }
  }
  // The back edge sits on the wall: lx 0 for a shelf facing E, ly 0 for one facing S.
  const back = (t: number) =>
    alongY ? project(s.lx - hx, s.ly + t * hy, fit) : project(s.lx + t * hx, s.ly - hy, fit);
  const l = back(-1);
  const r = back(1);
  const [a, b] = l.x <= r.x ? [l, r] : [r, l];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    topMidY: back(0).y - rise,
    tiltDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/**
 * Screen anchors for the ambient-magic CSS overlay (index.ts): golden dust motes floating inside each
 * window's daylight shaft, and a twinkle halo on each string-light bulb. Both mirror the geometry the
 * canvas draws — the beams (`drawWindowBeams`) and the cable (`cablePts`) — so the overlay sits exactly
 * on the painted light. Positions are hash-deterministic: rebakes reposition, never reshuffle.
 */
export function magicAnchors(fit: Fit, hours = 12.75): { motes: Pt[]; bulbs: Pt[] } {
  const sun = sunBeam(hours);
  const motes: Pt[] = [];
  const bulbs: Pt[] = [];
  WALL_EDGES.forEach((edge, wi) => {
    // Bulbs: the same odd cable indices drawWalls glows (dropped the same 2px the canvas drops them).
    const cable = cablePts(edge, fit);
    for (let i = 1; i < cable.length - 1; i += 2) {
      bulbs.push({ x: cable[i]!.x, y: cable[i]!.y + 2 * fit.scale });
    }
    // Motes: a handful of points per window, scattered through the beam's floor throw and lifted off the
    // floor — they drift in the *shaft* of light, which is what sells the light as volume, not paint.
    WINDOWS.forEach((w, ci) => {
      for (let k = 0; k < 6; k++) {
        const n = wi * 100 + ci * 10 + k;
        const t = w.t0 + (0.15 + 0.7 * magicRnd(n)) * (w.t1 - w.t0);
        const d = 14 + magicRnd(n + 1) * sun.len * 0.72;
        const shear = (d / sun.len) * sun.shear;
        const [ex, ey] = edge(t);
        const p = wi === 0 ? project(d, ey + shear, fit) : project(ex + shear, d, fit);
        motes.push({ x: p.x, y: p.y - (6 + magicRnd(n + 2) * 40) * fit.scale });
      }
    });
  });
  return { motes, bulbs };
}

/** Reception: a waiting couch turned toward the door, a low table, and a plant — the nook's vocabulary. */

/**
 * The receptionist, at her desk — a FULL member-sized character through the same `drawCharacter`
 * path as everybody else, not a bespoke pile of ellipses.
 *
 * The first cut hand-drew her at roughly half scale, which read exactly as what it was: "a mini
 * version of the other characters" (nick, 2026-07-30). She now sits in a chair at a desk-height
 * counter like any member, at `size: 1`, and gets the real skeleton — so she types with the same
 * `typing` solve and takes a call with `GESTURE.call`, the beat the skeleton already had.
 *
 * What still makes her STAFF rather than roster is everything around the drawing: she is not in the
 * node map, gets no nameplate, is in no headcount, and never walks. She is drawn as a `human` so she
 * has a face rather than an agent's visor — a receptionist behind a visor reads as another agent,
 * which is precisely the confusion to avoid.
 *
 * Her look is WRITTEN DOWN, not hashed. Hashing is right for members — a name is all the identity
 * the floor has — but she is one designed character, and leaving her to the hash meant nobody had
 * ever looked at what it produced: gold skin under dark red long hair, which closed around her face
 * into a single oval and read as a seal. A fixed character gets fixed art.
 */
const RECEPTIONIST_LOOK: Appearance = {
  skin: '#e8b07d',
  style: 'smart',
  grooming: 'polished',
  // A ponytail rather than the full fall: she is seen from the chest up behind a counter, and a long
  // mass in that framing has nothing to hang against, so it silhouettes into the head.
  hair: 'ponytail',
  // Auburn, not near-black. Dark brown hair over a low hairline put a dark band across her brow that
  // ran straight into the dark glasses frame below it — two dark bands with a sliver of skin between
  // them, which is why her eyes read as a smudge rather than as eyes. The glasses are gone for the
  // same reason: at this size she can have a hairline OR eyewear across the face, not both.
  hairColor: '#a06c38',
  facialHair: 'none',
  hat: 'none',
  hatColor: '#2a2118',
  // Long sleeves — bare forearms in gold-on-gold were half of why she had no readable arms.
  cut: 'long',
  bareArms: false,
  bottom: '#3f5570',
  shoes: '#22262b',
  eyes: 'none',
  ears: 'none',
  neck: 'none',
  accessory: 'none',
  accessoryColor: '#2f7f6a',
  smile: 'soft',
  build: 1,
};
const RECEPTIONIST_NODE: OfficeNode = {
  name: 'receptionist',
  kind: 'human',
  service: false,
  // The house's own staff — nobody wakes the receptionist.
  woken: false,
  presence: 'online',
  activity: 'working',
  posture: 'working',
  state: null,
  color: 'hsl(172, 32%, 46%)',
  role: '',
  surface: null,
  model: null,
  workTitle: null,
  workSource: null,
  laneState: null,
  moreLanes: 0,
  dnd: false,
  offline_reason: null,
  last_seen_at: null,
  created_at: null,
  sponsored_by: null,
};

/**
 * What her body is doing, per mode — pure, so the mapping is a test rather than a thing to eyeball.
 * The Welcome Wagon's cues (lane 01M3F81DD9) reuse her vocabulary: the ringing phone is the call pose
 * with the receiver up, the label maker is a typing burst, and the lanyard toss is the raised-hand
 * wave — thrown, then held up a beat as it lands. `gestureT` null → the caller's wake-driven value.
 */
export function receptionistPose(r: ReceptionistState): {
  gesture: number;
  gestureT: number | null;
  carry: CarryKind | null;
  typing: boolean;
} {
  const asleep = r.mode === 'asleep';
  if (r.mode === 'call')
    return {
      gesture: GESTURE.call,
      gestureT: Math.min(0.98, r.modeT / Math.max(r.beatLen, 0.01)),
      carry: 'phone',
      typing: false,
    };
  if (r.mode === 'ringing')
    return {
      gesture: GESTURE.call,
      gestureT: Math.min(0.98, r.modeT / RECEPTION_CUE_S.ringing),
      carry: 'phone',
      typing: false,
    };
  if (r.mode === 'toss')
    return {
      gesture: GESTURE.wave,
      gestureT: Math.min(0.98, r.modeT / RECEPTION_CUE_S.toss),
      carry: null,
      typing: false,
    };
  if (asleep || r.mode === 'waking')
    // chin-on-hand reads as dozing at a desk; asleep holds the plateau — a still slump, no animation
    return { gesture: GESTURE.chin, gestureT: asleep ? 0.5 : null, carry: null, typing: false };
  return {
    gesture: 0,
    gestureT: null,
    carry: null,
    typing: r.mode === 'typing' || r.mode === 'label',
  };
}

function drawReceptionist(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  r: ReceptionistState,
  t: number,
  /** The figure's sheets (plan Task 13): she is a sprite like everyone else. */
  figure: { assets: FigureAssets; tint: string },
): void {
  const asleep = r.mode === 'asleep';
  const wake = asleep ? 0 : r.mode === 'waking' ? Math.min(1, r.modeT / RECEPTIONIST_WAKE_S) : 1;
  // Asleep is a slump, not a separate drawing: the same seated figure folded forward over the desk.
  // `sit` stays 1 throughout — she never stands up, which is most of what "never leaves the desk"
  // means to the painter.
  const { gesture, gestureT: poseT, carry, typing } = receptionistPose(r);
  const gestureT = poseT ?? 1 - wake;
  const onPhone = carry === 'phone';
  const pose: Pose = {
    lx: RECEPTIONIST.lx,
    ly: RECEPTIONIST.ly,
    dir: RECEPTIONIST.dir,
    sit: 1,
    phase: 0,
    stride: 0,
    run: false,
    small: false,
    alpha: 1,
    carry: onPhone ? 'phone' : null,
    bubble: null,
    gesture,
    gestureT,
    moving: false,
  };
  const seed = RECEPTIONIST_SEED / 0xffffffff;
  const { anim, startT, frame } = animFor(
    pose,
    typing && !asleep ? 1 : 0,
    t,
    seed,
    figure.assets.spec.anims,
  );
  drawCharacter(ctx, fit, {
    lx: pose.lx,
    ly: pose.ly,
    dir: pose.dir,
    node: RECEPTIONIST_NODE,
    rendered: figure.assets,
    anim,
    animStart: startT,
    ...(frame !== undefined ? { animFrame: frame } : {}),
    tint: figure.tint,
    size: 1,
    alpha: 1,
    carry: pose.carry,
    gesture,
    gestureT,
    t,
    seed,
    look: RECEPTIONIST_LOOK,
  });
}

/** Her own stable seed — sharing a desk's seed would put her typing in lockstep with a member's. */
const RECEPTIONIST_SEED = 0x9e3779b9;

/** What the scene draws when nobody has stepped her yet: an empty office, which is the honest default. */
const SLEEPING_RECEPTIONIST: ReceptionistState = {
  mode: 'asleep',
  modeT: 0,
  aloneT: 0,
  lastSlot: -1,
  beatLen: 0,
};

function receptionItems(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  recep: ReceptionistState | null,
  t: number,
  /** The static-sprite key suffix (`renderScene`'s `statKey`): fit, dpr, palette. */
  statKey: string,
  rendered: RenderedAssets,
  figure: { assets: FigureAssets; tint: string } | undefined,
): DepthItem[] {
  const R = RECEPTION;
  /* The front desk is one asset (plan Task 6); its screen is still — the typing flicker the painter had
     is not rendered yet. */
  const deskDraw = blitDraw(fit, rendered, 'reception/desk', FRONT_DESK.lx, FRONT_DESK.ly);
  const still = (
    d: number,
    key: string,
    draw: (c: CanvasRenderingContext2D) => void,
  ): DepthItem => ({
    d,
    fn: () => draw(ctx),
    parts: [{ kind: 'sprite', key: `${key}·${statKey}`, draw }],
  });
  return [
    // She sorts at her own feet, north of the counter, so the counter paints over her lower body.
    ...(figure
      ? [
          {
            d: depth(RECEPTIONIST.lx, RECEPTIONIST.ly),
            fn: () => drawReceptionist(ctx, fit, recep ?? SLEEPING_RECEPTIONIST, t, figure),
          },
        ]
      : []),
    { d: depth(FRONT_DESK.lx, FRONT_DESK.ly), fn: () => deskDraw(ctx) },
    still(
      depth(R.endTable.lx, R.endTable.ly),
      'recep·endtable',
      blitDraw(fit, rendered, 'reception/endtable', R.endTable.lx, R.endTable.ly),
    ),
    still(
      depth(R.chair.lx, R.chair.ly),
      'recep·armchair',
      blitDraw(fit, rendered, 'reception/armchair', R.chair.lx, R.chair.ly),
    ),
    still(
      depth(R.plant.lx, R.plant.ly),
      'recep·plant',
      blitDraw(fit, rendered, 'plant/fiddle', R.plant.lx, R.plant.ly),
    ),
  ];
}

/**
 * One piece of an item's cached form (sprite cache, spec 2026-09-17). A `sprite` part is rasterized
 * once per `key` by `SpriteCache` and blitted; its `draw` receives the OFFSCREEN context. A `live`
 * part paints on the stage every frame and closes over the stage context. Parts run in order, in the
 * item's one depth slot — so a working desk is sprite (slab, legs, props up to the monitor casing) →
 * live (the screen face, which reads `t` and blooms additively) → sprite (the props after it).
 */
export type SpritePart =
  | { kind: 'sprite'; key: string; draw: (ctx: CanvasRenderingContext2D) => void }
  | { kind: 'live'; draw: () => void };

/** One depth-sortable draw call. The nook/huddle used to paint as single blobs anchored at their
 * centre, which over-painted any member standing on the north half of their rugs — each solid piece is
 * now its own item at its own footprint depth, and flat rugs paint with the floor (see renderScene). */
export interface DepthItem {
  d: number;
  /** The direct draw — the whole item, unchanged. */
  fn: () => void;
  /** The same pixels as `fn`, as sprite/live parts in order. Used only when `renderScene` is given a
   * `SpriteCache`; absent on items that stay live (actors, the pet, anything that reads `t` all over). */
  parts?: SpritePart[];
}

/** Per-call rendering options — everything here is opt-in and absent on the baked path. */
export interface RenderOpts {
  /** The visiting dog, while one is in the room (lane 01M5XS6DP2). Drawn from its own sheet. */
  visitor?: PetState | null | undefined;
  /** The per-item sprite cache. Absent → every item paints direct, exactly as before. */
  sprites?: SpriteCache | undefined;
  /** Device pixel ratio of `ctx`'s transform — sprite boxes are in device px. Default 1. */
  dpr?: number | undefined;
  /**
   * Cache ONLY the sprites whose key CONTAINS this string; everything else paints live. The
   * pixel gate uses it to bisect a difference down to one item class instead of reasoning about
   * which of thirty items moved a pixel — which is how the additive-pass fault was found.
   */
  spriteOnly?: string | undefined;
  /** The Welcome Wagon's paint (lane 01M3F81DD9) — lanyards, label strips, the wall's new-arrivals
   *  corner and flip counter, hello screens, boot blinks. Absent → nothing of it is drawn. */
  welcome?: WelcomePaint | undefined;
  /**
   * Dirty-rect repaint (./damage.ts): every unit of the paint sequence — each depth item, each layer
   * around the loop — goes through `units.run`, in order, so a caller can measure the units or skip
   * the ones a partial frame cannot touch. Absent → every unit runs, exactly as before.
   */
  units?: UnitHook | undefined;
  /** The sky at the windows (weather.ts, lane 01M5XS6597). Absent → clear, which draws nothing. */
  weather?: Weather | undefined;
  /** When each shelf-chime bar was last struck, in scene-clock seconds (sound identity inc 4): a bar
   *  struck within `CHIME_SWING_S` of `t` swings. Absent or all −Infinity → the chimes hang still. */
  chimes?: readonly number[] | undefined;
  /**
   * The pre-rendered art (office realism, plan Task 2 onward): every static item, the room's light
   * states, the figure sheets and the dog. An asset that failed to load is simply not drawn.
   */
  rendered: RenderedAssets;
}

/**
 * Blit the rendered asset `id` at `(lx, ly)` when `rendered` carries it; answer false when it does
 * not (the asset failed to load, or the manifest predates it) — nothing is drawn in its place, so a
 * missing asset is a missing item, never a hole in the room (Review Focus 1).
 */
function blitIf(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  rendered: RenderedAssets,
  id: string,
  lx: number,
  ly: number,
  alpha = 1,
): boolean {
  const img = rendered.images.get(id);
  const a = rendered.manifest.assets.find((x) => x.id === id);
  if (!img || !a) return false;
  blitAsset(ctx, fit, a, img, lx, ly, alpha);
  return true;
}

/**
 * A static item's draw: blits the asset `id` at `(lx, ly)`. It is the `draw` of a sprite part, so the
 * sprite cache rasterises the blit like any other item — the depth item, its key and its order are the
 * painters' (lane 01M5D8EJ40: the painters went; the items stayed).
 */
function blitDraw(
  fit: Fit,
  rendered: RenderedAssets,
  id: string,
  lx: number,
  ly: number,
): (c: CanvasRenderingContext2D) => void {
  return (c) => {
    blitIf(c, fit, rendered, id, lx, ly);
  };
}

/** Convex hull (monotone chain) of a point set — the silhouette an extruded box clips to. */
function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The break nook's pieces (plan Task 6): each is one asset at its own floor point and a sprite in the
 * cache; the rug belongs to the background layer. The open fridge is the one painter left in the nook —
 * a live state the render has no door for yet — so while an errand browses it the fridge paints.
 */
function nookItems(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  fridgeOpen: boolean,
  /** The static-sprite key suffix (`renderScene`'s `statKey`): fit, dpr, palette. */
  statKey: string,
  rendered: RenderedAssets,
): { items: DepthItem[] } {
  const { lx, ly } = NOOK;
  const L = LOUNGE;
  const r = (id: string, dx: number, dy: number) => blitDraw(fit, rendered, id, lx + dx, ly + dy);
  const at = (
    dx: number,
    dy: number,
    key: string,
    draw: (c: CanvasRenderingContext2D) => void,
  ): DepthItem => ({
    d: depth(lx + dx, ly + dy),
    fn: () => draw(ctx),
    parts: [{ kind: 'sprite', key: `nook·${key}·${statKey}`, draw }],
  });
  return {
    items: [
      at(
        L.fridge.dx,
        L.fridge.dy,
        `fridge·${fridgeOpen ? 'open' : 'shut'}`,
        fridgeOpen
          ? (c) => fridge(c, fit, lx + L.fridge.dx, ly + L.fridge.dy)
          : r('nook/fridge', L.fridge.dx, L.fridge.dy),
      ),
      at(L.counter.dx, L.counter.dy, 'counter', r('nook/counter', L.counter.dx, L.counter.dy)),
      at(L.cooler.dx, L.cooler.dy, 'cooler', r('nook/cooler', L.cooler.dx, L.cooler.dy)),
      at(L.island.dx, L.island.dy, 'island', r('nook/island', L.island.dx, L.island.dy)),
      ...L.stools.map((st, i) => at(st.dx, st.dy, `stool-${i}`, r('nook/stool', st.dx, st.dy))),
      at(L.couch.dx, L.couch.dy, 'couch', r('nook/couch', L.couch.dx, L.couch.dy)),
      ...L.armchairs.map((a, i) => at(a.dx, a.dy, `armchair-${i}`, r('nook/armchair', a.dx, a.dy))),
      at(L.table.dx, L.table.dy, 'table', r('nook/table', L.table.dx, L.table.dy)),
    ],
  };
}

/**
 * The painted fridge's appliance white — warm (#e8e2d6), not the blue-grey a real office fridge is: this
 * room is lit amber from the windows down, and a genuinely cold white in it reads as a hole in the wall.
 */
const APPLIANCE = '#e8e2d6';

/** Body height of the espresso machine. `coffeeAnchor` reads it too — the ambient steam has to leave the
 * warmer plate, so the plate's height is shared data rather than a constant repeated in two places. */
export const MACHINE_H = 15;

/**
 * The OPEN fridge — the one furniture painter still standing (lane 01M5D8EJ40): while an errand browses
 * it the lower door swings out and the opening shows dark with a lit shelf, and the render has no door
 * for that yet. Shut, the fridge is `nook/fridge`. Boxes stood proud of the room-facing (+y) face, which
 * is the only face detail can live on and still read at this projection.
 */
function fridge(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const f = LOUNGE.fridge;
  const front = ly + f.d / 2; // the room-facing face — everything below is proud of it by ~1 unit
  box(ctx, fit, lx, ly, f.w, f.d, f.h, APPLIANCE);
  box(ctx, fit, lx, front, f.w - 4, 1.5, 1.5, '#c3b9a8', 34); // the freezer/fridge seam
  // The lower compartment stands open: a dark inset with one lit shelf line, and the door swung out as
  // a slab perpendicular to the face, hinge at the west edge (box() can't rotate — at this scale a
  // proud perpendicular slab *is* an open door).
  box(ctx, fit, lx, front, f.w - 6, 1.2, 30, '#2e2a26', 3); // the dark opening
  box(ctx, fit, lx, front, f.w - 10, 1.4, 1.6, '#f6ead2', 17); // a shelf catching the fridge light
  box(ctx, fit, lx - f.w / 2 + 1, front + 8, 3, 16, 32, dim(APPLIANCE, 0.9), 2); // the swung door
  box(ctx, fit, lx + 11, front, 2.5, 2.5, 12, '#6e6558', 38); // upper handle stays
  box(ctx, fit, lx - 5, ly - 2, 15, 13, 9, '#c9744a', f.h); // a crate someone left on top
}

/** A faint floor pad marking one spot in the entrance waiting queue (drawn under an overflow member). */
function drawQueuePad(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const p = project(lx, ly, fit);
  ctx.globalAlpha = 0.45;
  ellipse(ctx, { x: p.x, y: p.y + 3 * fit.scale }, 21 * fit.scale, 7 * fit.scale, '#7a4e2d');
  ctx.globalAlpha = 1;
}

/** A small screen-space "+N …" pill — collapses the members past the queue/nook cap into one count. */
function drawCountPill(ctx: CanvasRenderingContext2D, at: Pt, text: string, scale: number): void {
  ctx.font = canvasFont(Math.round(12 * scale));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 18 * scale;
  const h = 20 * scale;
  roundRect(ctx, at.x - w / 2, at.y - h / 2, w, h, h / 2, 'rgba(20, 24, 31, 0.82)');
  ctx.fillStyle = '#cfe7ee';
  ctx.fillText(text, at.x, at.y);
}

// ── the office dog (behaviour in pet.ts; the sheet is `rendered/assets/dog.json`) ──────────────────────

/**
 * Draw the office dog at its current pose: the clip and frame `dogFrame` picks for its mode, in the
 * sheet's nearest of eight headings (`dogDir`, with hysteresis so a diagonal does not flutter), mirrored
 * for the leftward ones. Small on purpose — dog-sized next to the figures — so judge it at 4× on
 * /character-sheet, not here. No sheet (`dog.json` missing or unusable) draws no dog.
 */
export function drawDog(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  pet: PetState,
  t: number,
  rendered: RenderedAssets,
): void {
  if (rendered.dog) drawRenderedDog(ctx, fit, pet, t, rendered.dog);
}

/** A speech/thought bubble over an actor's head (raised-hand `?`, urgent `!`). Screen-space. */
function bubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  glyph: '?' | '!',
  s: number,
): void {
  const w = 22 * s;
  const h = 18 * s;
  roundRect(ctx, x - w / 2, y - h, w, h, 6 * s, '#20242b');
  ctx.fillStyle = '#20242b';
  ctx.beginPath();
  ctx.moveTo(x - 4 * s, y - 2 * s);
  ctx.lineTo(x + 4 * s, y - 2 * s);
  ctx.lineTo(x, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = glyph === '!' ? '#f3776a' : '#f4cf52';
  ctx.font = canvasFont(Math.round(13 * s));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x, y - h / 2);
}

/**
 * Draw a member as a free actor at a pose. Position drives the depth-sort in `renderScene`, so a walker
 * overlaps desks correctly; the body itself is whatever `skeleton.ts` solved for this frame.
 *
 * `armsOnly` is the seated overlay pass — see `renderScene`.
 */
export function drawActor(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  pose: Pose,
  node: OfficeNode,
  t: number,
  armsOnly: boolean,
  /** Mug colour while a sip beat is playing — in the raised hand through the middle of the beat. */
  mug: string | undefined,
  /** A first arrival's lanyard colour (lane 01M3F81DD9). */
  lanyard: string | undefined,
  /** The figure's sheets (plan Task 13) under the room's light tint (`figureTintFor`). */
  figure: { assets: FigureAssets; tint: string },
): void {
  const seed = seedOf(node.name);
  // Typing is gated on posture (`sit > 0.9`, no beat playing) and its amplitude is the seat's PULSE —
  // distinct harness tool calls in the last minute (ADR 660) — so a `working` seat with no live pulse
  // sits still at its lit screen.
  const typing =
    pose.sit > 0.9 && pose.gesture === 0
      ? typingFromPulse(pulseIntensity(node.pulse, Date.now()), seed, t)
      : 0;
  const { anim, startT, frame } = animFor(pose, typing, t, seed, figure.assets.spec.anims);
  drawCharacter(
    ctx,
    fit,
    {
      lx: pose.lx,
      ly: pose.ly,
      dir: pose.dir,
      ...(pose.heading !== undefined ? { heading: pose.heading } : {}),
      node,
      rendered: figure.assets,
      anim,
      animStart: startT,
      ...(frame !== undefined ? { animFrame: frame } : {}),
      tint: figure.tint,
      size: pose.small ? 0.72 : 1,
      alpha: pose.alpha,
      carry: pose.carry,
      gesture: pose.gesture,
      gestureT: pose.gestureT,
      sit: pose.sit,
      ...(mug !== undefined ? { mug } : {}),
      ...(lanyard !== undefined ? { lanyard } : {}),
      t,
      seed,
    },
    armsOnly,
  );
  if (!armsOnly && pose.bubble) {
    const p = project(pose.lx, pose.ly, fit);
    // Over the crown, which the sheet's spec gives (96 was the painted member's).
    const crown = figure.assets.spec.height ?? 96;
    bubble(
      ctx,
      p.x,
      p.y - (pose.small ? (crown + 2) * 0.76 : crown + 2) * fit.scale,
      pose.bubble,
      fit.scale,
    );
  }
}

// ── a workstation: legged desk + task chair + oriented glowing monitor ──
/**
 * A task chair, in **two pieces**, because a seated member is *inside* it — and painter's order can only
 * put a whole object in front of or behind them.
 *
 * The cushion is under the sitter and the backrest is behind their back, so drawing the chair as one box
 * meant whichever side of the member it sorted on, it was wrong: it swallowed them from the waist down.
 * Split, each piece sorts at its own footprint and the right thing happens at every facing on its own — the
 * sitter paints over the cushion they are sitting on, and the backrest paints over their back only when the
 * chair is actually between them and the viewer.
 */
const CHAIR_BACK_OFF = 14; // how far behind the seat centre the backrest stands

// ── task-chair variety ──────────────────────────────────────────────────────────────────────────────
// Not every desk gets the same chair. The *kind* is a stable per-desk hash (like the surface props), so a
// desk always shows the same chair frame to frame but the pod reads as a real office — a plain task stool
// here, a wheeled office chair there, an armed exec seat, the odd high-backed gamer chair. Every kind is
// rendered in neutral greys per seat axis (`chair/<kind>/<sn|ew>/<base|back>`) and tinted at draw time; the
// cushion top stays at SEAT_TOP and the backrest keeps its footprint, so a sitter still sorts between the two.
type ChairKind = 'task' | 'wheeled' | 'exec' | 'gamer';
const CHAIR_ARM_SALT = 22;
/* Every chair in this office rolls (nick, 2026-09-14): the star base has arms AND wheels, which is what
   makes it read as a chair rather than as dots under a cushion. */

// Keyed by desk slot id (`DESK_SLOTS`, 22 of them), wrapping every 12. A probability hash over so few ids
// doesn't guarantee coverage — it can (and did) bucket every desk into one variant, so the variety never
// shows. Instead the list is a curated spread: each block of four ids (0–3, 4–7, 8–11) shows every
// kind. Still fully deterministic + stable per frame. The pod notes below date from
// the 12-desk office and no longer name pods.
const CHAIR_KINDS_BY_ID: readonly ChairKind[] = [
  'gamer',
  'wheeled',
  'exec',
  'task', // pod 0 (top — two desks face the camera)
  'exec',
  'gamer',
  'task',
  'wheeled', // pod 1 (centre)
  'wheeled',
  'exec',
  'gamer',
  'task', // pod 2 (left)
];

/** The ambient scheduler used to import this so it could skip the one kind with no casters. Every kind
 *  has them now, so its question collapsed to "is there a desk chair" and this went back to private. */
function chairKindFor(id: number): ChairKind {
  return CHAIR_KINDS_BY_ID[id % CHAIR_KINDS_BY_ID.length]!;
}
/** The rendered chair sprite for a desk: its kind, and for a wheeled chair whether it has arms (a stable
 *  per-desk coin; the exec and gamer chairs always do, the task stool never). */
function chairVariantFor(id: number): string {
  const kind = chairKindFor(id);
  return kind === 'wheeled' && deskRnd(id, CHAIR_ARM_SALT) < 0.5 ? 'wheeled-arms' : kind;
}

/** Tinted copies of rendered assets, by `<asset id>·<colour>`: a chair per member colour is a small image. */
const tintedArt = new WeakMap<RenderedAssets, Map<string, HTMLCanvasElement>>();

/**
 * Blit the rendered asset `id` multiplied by `color` — the chairs are rendered in neutral greys at the
 * painter's own shade ratios, so one image serves every member colour. Answers false when the asset
 * is not in (nothing is drawn).
 */
function blitTinted(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  rendered: RenderedAssets,
  id: string,
  lx: number,
  ly: number,
  color: string,
): boolean {
  const img = rendered.images.get(id);
  const a = img && rendered.manifest.assets.find((x) => x.id === id);
  if (!img || !a || typeof document === 'undefined') return false;
  let cache = tintedArt.get(rendered);
  if (!cache) tintedArt.set(rendered, (cache = new Map()));
  const key = `${id}·${color}`;
  let tinted = cache.get(key);
  if (!tinted) {
    tinted = document.createElement('canvas');
    // sized to the image: `tintFrame` only grows a canvas, and a fresh one is 300 × 150, which squeezed
    // every chair into a third of its width (nick: backs "at an angle", "paper thin")
    tinted.width = a.w;
    tinted.height = a.h;
    if (!tintFrame(tinted, img, 0, 0, a.w, a.h, color)) return false;
    cache.set(key, tinted);
  }
  blitAsset(ctx, fit, a, tinted, lx, ly);
  return true;
}

// ── monitor variety ─────────────────────────────────────────────────────────────────────────────────
// Desks differ in what's on them: a lone monitor, two panels on a dual-arm stand, or one ultrawide curved
// screen. Curated per desk slot id, wrapping every 12 (same reasoning as the chairs — a probability hash
// doesn't guarantee coverage, and did collapse to all-single), so neighbouring slots get a mix. The pod
// notes in the list date from the 12-desk office. Every panel still lights teal
// when its member is `working` and stays dim otherwise — the load-bearing work cue is intact.
type MonitorSetup = 'single' | 'dual' | 'ultrawide';
// The two decorative laptop rigs (`laptopRiser`, `laptopDock`) were removed on 2026-09-04. They were
// furniture variety and belonged to nobody — which stopped being harmless the moment a laptop started
// meaning *this person is in the building*: four desks were telling that lie every frame, on desks whose
// owner might be away or offline. Every desk now carries the same dock instead (see `deskDock`), empty
// until its owner is working. Monitor variety is monitors.
const MONITOR_SETUPS_BY_ID: readonly MonitorSetup[] = [
  'single',
  'dual',
  'single',
  'ultrawide', // pod 0 (top — 2,3 face the camera)
  'single',
  'dual',
  'ultrawide',
  'single', // pod 1 (centre — 6,7 face the camera)
  'single',
  'dual',
  'ultrawide',
  'dual', // pod 2 (left — 10,11 face the camera)
];
function monitorSetupFor(id: number): MonitorSetup {
  return MONITOR_SETUPS_BY_ID[id % MONITOR_SETUPS_BY_ID.length]!;
}

// ── screen life: the animated desktop on a working member's monitor ─────────────────────────────────
// A lit screen isn't a flat teal slab any more — it's a tiny living desktop: editor windows with
// traffic-light dots, pastel code lines that type themselves in and scroll away, a blinking caret, and
// the occasional sparkle drifting up off the glass. Everything is deterministic in (seed, t) — the seed
// keeps each desk's windows in their own places frame to frame, and `t` (the scene clock) drives typing,
// blink and sparkle phase, so two desks never twinkle in sync.

/** Stable 0..1 from two ints — same shape as `deskRnd`, usable before its declaration point. */
function scrRnd(seed: number, salt: number): number {
  let h = (2166136261 ^ (seed + 1)) >>> 0;
  h = Math.imul(h, 16777619) ^ (salt * 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** The code-line syntax palette — warm mustard first (it's musterd's office), then mint/coral/lavender. */
const CODE_HUES = ['#ffd166', '#7fe0ce', '#f4989c', '#c8b6f2', '#9ad1ff'] as const;
// Lit wallpaper brighter than the idle slab, so "glowing = working" still reads from across the room;
// the editor panes are the dark thing, floating on it like real windows.
const SCREEN_BG = '#2f9a8a';

/** Map from screen-face UV (u across 0..1, v up 0..1) to canvas px. The face is a parallelogram: its
 * bottom edge runs BL→BR in projected space and its vertical is a straight screen-space lift of `vh`. */
type FaceMap = (u: number, v: number) => Pt;

function faceQuad(
  ctx: CanvasRenderingContext2D,
  map: FaceMap,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  fill: string,
): void {
  quad(ctx, [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)], fill);
}

/** Paint the living desktop inside an already-computed screen face. `wPx` is the face's on-canvas width
 * (decides how much detail fits); `windows` is how many editor panes to draw (1 for a laptop lid). */
function drawScreenLife(
  ctx: CanvasRenderingContext2D,
  map: FaceMap,
  wPx: number,
  scale: number,
  seed: number,
  t: number,
  windows: number,
): void {
  ctx.save();
  const path = [map(0, 0), map(1, 0), map(1, 1), map(0, 1)];
  ctx.beginPath();
  ctx.moveTo(path[0]!.x, path[0]!.y);
  for (let i = 1; i < 4; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
  ctx.closePath();
  ctx.fillStyle = SCREEN_BG;
  ctx.fill();
  ctx.clip();

  // A slow aurora wash behind the windows — two soft drifting bands, so even the "wallpaper" is alive.
  for (let a = 0; a < 2; a++) {
    const cu = 0.5 + 0.42 * Math.sin(t * 0.21 + a * 2.4 + seed);
    faceQuad(
      ctx,
      map,
      cu - 0.26,
      0,
      cu + 0.26,
      1,
      a === 0 ? 'rgba(213, 255, 244, 0.16)' : 'rgba(255, 224, 130, 0.13)',
    );
  }

  const tiny = wPx < 26 * scale; // laptop lids and far-off panels: fewer, chunkier details
  for (let k = 0; k < windows; k++) {
    const r = (s: number): number => scrRnd(seed, k * 97 + s);
    // Window k's stable geometry, in face UV. The second window offsets right/down so panes overlap.
    const wu = 0.05 + r(1) * 0.18 + k * 0.34;
    const wv = 0.08 + r(2) * 0.14 + k * 0.1;
    const ww = Math.min(0.56 + r(3) * 0.14, 0.97 - wu);
    const wh = Math.min(0.62 + r(4) * 0.2, 0.9 - wv);
    // Pane + title bar (the near-black chrome makes the pastel lines pop) + traffic-light dots.
    faceQuad(ctx, map, wu, wv, wu + ww, wv + wh, '#123b40');
    const barH = 0.14;
    faceQuad(ctx, map, wu, wv + wh - barH, wu + ww, wv + wh, '#0a2b30');
    if (!tiny) {
      const dots = ['#ff6b6b', '#ffc24b', '#59d68f'];
      for (let d = 0; d < 3; d++) {
        const c = map(wu + 0.035 + d * 0.055, wv + wh - barH / 2);
        ellipse(ctx, c, 1.1 * scale, 0.8 * scale, dots[d]!);
      }
    }
    // Code lines typing in: a rolling cycle — each pane types its rows top to bottom, holds, then a new
    // "file" (gen) reshuffles the line widths. The caret blinks at the end of the line being typed.
    const rows = tiny ? 3 : 5;
    const cycle = t * 1.5 + r(5) * 40;
    const gen = Math.floor(cycle / (rows + 3));
    const prog = cycle - gen * (rows + 3); // 0..rows+3: type rows, then hold
    const lineH = (wh - barH) / (rows + 1);
    for (let row = 0; row < rows; row++) {
      if (prog < row) break;
      const full = 0.2 + scrRnd(seed, k * 97 + gen * 13 + row * 31) * (ww - 0.3);
      const frac = Math.max(0, Math.min(1, prog - row)); // this row's typed-in fraction
      const lv = wv + wh - barH - (row + 1) * lineH;
      const hue = CODE_HUES[(seed + gen + row * 2 + k) % CODE_HUES.length]!;
      const indent = scrRnd(seed, k * 97 + gen * 13 + row * 31 + 7) < 0.35 ? 0.08 : 0;
      faceQuad(
        ctx,
        map,
        wu + 0.05 + indent,
        lv,
        wu + 0.05 + indent + full * frac,
        lv + lineH * 0.45,
        hue,
      );
      if (frac < 1 && Math.floor(t * 2.6) % 2 === 0) {
        // the blinking caret, riding the end of the active line
        faceQuad(
          ctx,
          map,
          wu + 0.05 + indent + full * frac,
          lv - lineH * 0.1,
          wu + 0.07 + indent + full * frac,
          lv + lineH * 0.6,
          '#fff6da',
        );
      }
    }
  }
  ctx.restore();

  // Sparkles: two motes per screen, each on its own loop — born near the glass, drifting up past the top
  // edge and fading. Drawn unclipped so the magic visibly leaves the screen. Four-point star = two slivers.
  for (let s = 0; s < 2; s++) {
    const period = 3.2 + scrRnd(seed, 300 + s) * 2.5;
    const ph = (t / period + scrRnd(seed, 310 + s)) % 1;
    const a = Math.sin(ph * Math.PI);
    if (a < 0.05) continue;
    const p = map(
      0.15 + scrRnd(seed, 320 + s) * 0.7 + 0.08 * Math.sin(t * 1.7 + s * 3),
      0.55 + ph * 0.9,
    );
    const r = (1.6 + 1.1 * a) * scale;
    ctx.save();
    ctx.globalAlpha = a * 0.9;
    quad(
      ctx,
      [
        { x: p.x - r, y: p.y },
        { x: p.x, y: p.y - r * 0.32 },
        { x: p.x + r, y: p.y },
        { x: p.x, y: p.y + r * 0.32 },
      ],
      '#ffe9a8',
    );
    quad(
      ctx,
      [
        { x: p.x, y: p.y - r },
        { x: p.x + r * 0.32, y: p.y },
        { x: p.x, y: p.y + r },
        { x: p.x - r * 0.32, y: p.y },
      ],
      '#fff6da',
    );
    ctx.restore();
  }
}

/** One monitor panel: the stand box + the screen face (shown on the camera-facing N/W faces) + a soft
 * glow. A working member's screen runs the animated desktop (see `drawScreenLife`); an idle one stays a
 * flat dim slab, so "lit + alive = working" remains the load-bearing cue. `wAcross` is the panel width
 * along the shoulders; `h` its height; `curved` shades the outer thirds so an ultrawide reads as bowed. */
function screenPanel(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  up: number,
  wAcross: number,
  h: number,
  curved: boolean,
  t = 0,
  /** ADR 660: whether the screen is ALIVE (animated desktop + bloom — only while the owner's pulse is
   * live) and how hard a `run` lights it. Absent: alive follows `working` (the receptionist's desk). */
  life?: ScreenLife,
): void {
  const sn = dir === 'S' || dir === 'N';
  // The body is rendered art (`monitor/<setup>/<dir>`): this draws only the screen face over it, and no
  // idle glass (the render has its own). The face is 3 deep — the panel's own thickness in the render.
  const pw = sn ? wAcross : 3;
  const pd = sn ? 3 : wAcross;
  const lo = (up + PANEL_UP) * fit.scale;
  const hi = (up + PANEL_UP + h) * fit.scale;
  const dn = (p: Pt, u: number): Pt => ({ x: p.x, y: p.y - u });
  // The camera-facing face's bottom corners (BL→BR left-to-right on canvas); vertical is a straight lift.
  let BL: Pt | null = null;
  let BR: Pt | null = null;
  if (dir === 'N') {
    BL = project(mx - pw / 2, my + pd / 2, fit);
    BR = project(mx + pw / 2, my + pd / 2, fit);
  } else if (dir === 'W') {
    BL = project(mx + pw / 2, my + pd / 2, fit);
    BR = project(mx + pw / 2, my - pd / 2, fit);
  }
  if (BL && BR) {
    const bl = BL;
    const br = BR;
    const alive = life ? life.alive : working;
    const glow = life?.glow ?? 0;
    if (working) {
      const map: FaceMap = (u, v) => ({
        x: bl.x + u * (br.x - bl.x),
        y: bl.y + u * (br.y - bl.y) - lo - v * (hi - lo),
      });
      const wPx = Math.abs(br.x - bl.x);
      // A lit screen is a fact of sitting at the desk; a MOVING one is a fact of working (ADR 660 §3):
      // with no live pulse the desktop is drawn once, still (`t` pinned), and nothing blooms.
      drawScreenLife(
        ctx,
        map,
        wPx,
        fit.scale,
        Math.abs(Math.round(mx * 7 + my * 13)),
        alive ? t : 0,
        wAcross >= 30 ? 2 : 1,
      );
    }
    if (curved) {
      // Bow shading over whatever's on screen — translucent, so the animated desktop stays visible.
      const L2 = { x: bl.x + (br.x - bl.x) / 3, y: bl.y + (br.y - bl.y) / 3 };
      const R2 = { x: bl.x + ((br.x - bl.x) * 2) / 3, y: bl.y + ((br.y - bl.y) * 2) / 3 };
      quad(ctx, [dn(bl, lo), dn(L2, lo), dn(L2, hi), dn(bl, hi)], 'rgba(6, 20, 22, 0.22)');
      quad(ctx, [dn(R2, lo), dn(br, lo), dn(br, hi), dn(R2, hi)], 'rgba(6, 20, 22, 0.22)');
    }
    if (working && alive) {
      // Light *emitted* from the lit screen: an additive bloom over the face plus a softer spill onto the
      // desk in front of it. Drawn here, inside the workstation's own depth item, so a monitor standing in
      // front occludes it — unlike the old DOM overlay, which always painted above the canvas and let a
      // back-row screen's glow bleed over a nearer monitor as a floating disc. Only the camera-facing lit
      // face (N/W) reaches this branch, so the glow only ever appears on a screen you can actually see.
      const cw = Math.abs(br.x - bl.x); // screen face width, px
      const chh = hi - lo; // screen face height, px
      const cx = (bl.x + br.x) / 2;
      const cyBottom = (bl.y + br.y) / 2 - lo; // screen's bottom edge (meets the desk)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bloom = ctx.createRadialGradient(
        cx,
        cyBottom - chh * 0.5,
        0,
        cx,
        cyBottom - chh * 0.5,
        cw * 0.66,
      );
      // A `run` pushes the bloom up to ~2.5× for three seconds, easing out (`runGlow`).
      bloom.addColorStop(
        0,
        `rgba(154, 228, 240, ${Math.min(1, 0.38 * (1 + 1.5 * glow)).toFixed(3)})`,
      );
      bloom.addColorStop(1, 'rgba(154, 228, 240, 0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.ellipse(cx, cyBottom - chh * 0.5, cw * 0.66, chh * 0.74, 0, 0, Math.PI * 2);
      ctx.fill();
      const spill = ctx.createRadialGradient(
        cx,
        cyBottom + chh * 0.34,
        0,
        cx,
        cyBottom + chh * 0.34,
        cw * 0.9,
      );
      spill.addColorStop(
        0,
        `rgba(122, 210, 226, ${Math.min(1, 0.2 * (1 + 1.5 * glow)).toFixed(3)})`,
      );
      spill.addColorStop(1, 'rgba(122, 210, 226, 0)');
      ctx.fillStyle = spill;
      ctx.beginPath();
      ctx.ellipse(cx, cyBottom + chh * 0.34, cw * 0.9, chh * 0.52, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/** What a desk's screen does this frame (ADR 660): alive while the owner's pulse is live; `glow` is the run bloom, 0..1. */
export interface ScreenLife {
  alive: boolean;
  glow: number;
}

/** The screen life for a desk's owner, read against the wall clock — the only clock a pulse's `ts` shares. */
export function screenLifeFor(node: OfficeNode | null | undefined, now = Date.now()): ScreenLife {
  return { alive: pulseLive(node?.pulse, now), glow: runGlow(node?.pulse, now) };
}

/** How far above the desk the panel's bottom edge floats — the height of the stand's neck. */
const PANEL_UP = 8;

/**
 * Which slice of a workstation to paint (sprite cache, spec 2026-09-17).
 *
 * The MONITOR is the one part of a desk that cannot be rasterized: a working desktop scrolls on `t`,
 * and a lit screen's bloom composites with `lighter` over whatever is under it at that moment, which
 * a transparent sprite cannot reproduce. So a desk paints as sprite(`pre`) → live(`monitor`) →
 * sprite(`post`), three parts in ONE depth slot.
 *
 * The whole monitor is live, not just its screen face: a dual setup paints casing-then-face per
 * panel, and the nearer panel paints over the farther one, so lifting only the faces out would group
 * the two casings ahead of the two faces and change what covers what. The casing and stand are a few
 * flat quads; the gradients and the bloom were always the cost.
 *
 * `pre` ++ `monitor` ++ `post` emits exactly the ops `all` does, in the same order — render.test.ts
 * holds that as an invariant across every desk state.
 */
export type WorkstationPhase = 'all' | 'pre' | 'monitor' | 'post';

/**
 * The rendered art the monitors read (lane 01M5D8EJ40), set by `renderScene` and `drawWorkstation` for
 * the draw in progress — four callers reach `monitor`, and the bench seats carry no assets of their own.
 * Unset (a draw before any scene set it): no monitor draws.
 */
let monitorArt: RenderedAssets | undefined;

function monitor(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  surfaceUp: number,
  id: number | null,
  t = 0,
  life?: ScreenLife,
): void {
  const setup = id == null ? 'single' : monitorSetupFor(id);
  const p: [number, number] = [-FWD[dir][1], FWD[dir][0]]; // across-desk unit
  // The rendered body (stand, panel, bezel, back), lifted to this desk's surface; over it only the live
  // screen face — the desktop and the bloom. No asset, no monitor.
  if (!monitorArt) return;
  ctx.save();
  ctx.translate(0, -surfaceUp * fit.scale);
  const drawn = blitIf(ctx, fit, monitorArt, `monitor/${setup}/${dir}`, mx, my);
  ctx.restore();
  if (!drawn) return;
  const panels: [number, number, number, boolean][] =
    setup === 'dual'
      ? [
          [-18, 34, 22, false],
          [18, 34, 22, false],
        ]
      : setup === 'ultrawide'
        ? [[0, 54, 20, true]]
        : [[0, 34, 22, false]];
  for (const [off, w, h, curved] of panels) {
    screenPanel(
      ctx,
      fit,
      mx + p[0] * off,
      my + p[1] * off,
      dir,
      working,
      surfaceUp,
      w,
      h,
      curved,
      t,
      life,
    );
  }
}

/** The closed laptop's aluminium and its logo dot — shared by the desk dock and the slab under an
 * arm (`character.ts` `drawCarry`), which must be the same object to the eye. */
const LAPTOP_SILVER = '#c7ccd2';
const LAPTOP_LOGO = '#a3a9b1';

/** Every desk's dock — the one piece of furniture this floor added when a laptop started meaning
 * *this member is in the building*. A small walnut cradle with a slot, always drawn; and, when its
 * owner is working, the closed laptop standing in it: a thin silver slab, broad face to the room,
 * hinge down. It is deliberately the same silver, seam and logo dot as the slab `drawCarry` tucks
 * under an arm, so the object you watched walk through the door is the object that lands here.
 *
 * `docked` is `workingAtDesk(owner, sit)` — the same boolean, on the same frame, that lights the
 * monitor two props away. That is the whole model (design §0): the dock is a second reading of the
 * work cue, not a new fact plumbed through the scene, so an empty dock and a dark screen cannot
 * disagree — and the member sitting down is the single event that turns both on. */
function deskDock(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  up: number,
  docked: boolean,
): void {
  const sn = dir === 'S' || dir === 'N';
  // Cradle and slot are sized to the slab they hold — a dock visibly narrower than its laptop reads
  // as the wrong furniture, so these three numbers move together or not at all.
  box(ctx, fit, mx, my, sn ? 21 : DOCK_CRADLE_ALONG, sn ? DOCK_CRADLE_ALONG : 21, 4, '#7c5230', up); // walnut cradle
  box(ctx, fit, mx, my, sn ? 17 : 3, sn ? 3 : 17, 1.5, '#54371f', up + 4); // the slot, dark down its length
  if (!docked) return; // nobody has sat down here to work — the slot is empty, and that is the point
  /*
   * The docked slab, standing on its long edge with the broad face to the room.
   *
   * It was 20 long × 22 tall, i.e. TALLER than wide — which is not a laptop on its long edge, it is a
   * tablet. A closed 16-inch MacBook Pro is ~35.6cm × ~24.8cm, so stood on the long edge the face to
   * the room is 1.44 times as wide as it is tall. 24 × 17 is 1.41, and it grew by the same ~1.2 the
   * carried slab did (character.ts `drawCarry`, nick 2026-09-14) — because these two must stay one
   * object to the eye: the thing you watched walk through the door is the thing that lands here, and
   * that promise breaks the moment one of them is resized alone.
   */
  const w = sn ? DOCK_LAPTOP_W : 5;
  const d = sn ? 5 : DOCK_LAPTOP_W;
  const hL = 17;
  box(ctx, fit, mx, my, w, d, hL, LAPTOP_SILVER, up + 3);
  const g = project(mx, my, fit);
  // The logo rides the centre of the standing face — derived from the slab's own height rather than a
  // hand-tuned constant, so it cannot drift off-centre the next time the lid changes size.
  ellipse(
    ctx,
    { x: g.x, y: g.y - (up + 3 + hL / 2) * fit.scale },
    3 * fit.scale,
    2.4 * fit.scale,
    LAPTOP_LOGO,
  );
}

// ── desk-surface props: a keyboard + mouse on every desk, plus a deterministic personal mix ──────────
// Each optional prop (coffee / water / photo / plant / fan / lamp) is present or not per desk from a
// stable hash of the slot id, so a desk always shows the same combination frame to frame (no jitter) but
// desks differ from each other — one desk might carry a lone coffee mug, another a lamp + plant + photo.

const KEYBOARD = '#2b2f36';
const MOUSE = '#454b54';
/** Mouse shells, so the peripheral isn't identical desk to desk (paired with keyboard-width variety). */
const MOUSE_COLORS = ['#454b54', '#5a6069', '#6a5568', '#4a5f57', '#6b5a48'];
/** Keyboard widths along the shoulders: compact / standard / full — chosen per desk by a stable hash. */
const KEYBOARD_WIDTHS = [26, 34, 40] as const;
const KB_SALT = 32;
/** Distinct "photos" for standing frames — each desk with a frame gets one of these by hash. */
const PHOTOS = [
  '#6fa3c9',
  '#e0a05a',
  '#8db36a',
  '#c97f9c',
  '#9a8fce',
  '#d9b24a',
  '#e08585',
  '#5ab0a4',
];
/** Mug colours, so coffee cups aren't all identical. */
/** Notebook covers — the same spread of muted colours the rest of the desk gear draws from. */
const NOTEBOOK_COVERS = ['#8a5a4a', '#46607d', '#5f7a55', '#7a5a78', '#9a7b3f'];
const MUGS = ['#d6d0c6', '#c95c4a', '#3d6b8f', '#e0a72b', '#5f8a5a'];

/** A closed notebook: a pad with a slightly proud cover and a colour band down its spine. */
function deskNotebook(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  cover: string,
): void {
  const { w, d } = PROP_SPEC.notebook;
  box(ctx, fit, ix, iy, sn ? w : d, sn ? d : w, 2, '#e8e2d4', up); // the pages
  box(ctx, fit, ix, iy, sn ? w - 1 : d - 1, sn ? d - 1 : w - 1, 3, cover, up + 1); // the cover, a touch proud
  // The spine band: a thin stripe down the long edge, so the pad reads as a book and not as paper.
  box(
    ctx,
    fit,
    ix - (sn ? w / 2 - 1.5 : 0),
    iy - (sn ? 0 : w / 2 - 1.5),
    sn ? 3 : d - 1,
    sn ? d - 1 : 3,
    3.4,
    dim(cover, 0.72),
    up + 1,
  );
}

/** The desk's back corner opposite the dock — where a review tray stands (deskWaiting.ts). */
const TRAY_ALONG = 24;

/** A sticky note on the monitor's top corner: the owner is blocked. Paper-yellow, slightly askew. */
function deskStickyNote(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number): void {
  const b = project(ix, iy, fit);
  const s = fit.scale;
  ctx.save();
  ctx.translate(b.x + 11 * s, b.y - (up + 22) * s);
  ctx.rotate(0.12);
  ctx.fillStyle = 'rgba(40, 30, 10, 0.25)';
  ctx.fillRect(-3.4 * s, -3.2 * s, 7.6 * s, 7.6 * s); // its shadow on the panel
  ctx.fillStyle = '#f4d35e';
  ctx.fillRect(-3.8 * s, -3.8 * s, 7.6 * s, 7.6 * s);
  ctx.fillStyle = '#e0bb3c';
  ctx.fillRect(-3.8 * s, -3.8 * s, 7.6 * s, 1.6 * s); // the glued strip
  ctx.strokeStyle = 'rgba(120, 60, 30, 0.7)';
  ctx.lineWidth = Math.max(0.6, 0.7 * s);
  ctx.beginPath(); // two scribbled lines: something is written on it
  ctx.moveTo(-2.4 * s, 0);
  ctx.lineTo(2.2 * s, -0.3 * s);
  ctx.moveTo(-2.4 * s, 1.9 * s);
  ctx.lineTo(1 * s, 1.8 * s);
  ctx.stroke();
  ctx.restore();
}

/** A manila folder lying on the desk's front lip: a handoff waits for this member to pick it up. */
function deskFolder(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
): void {
  const w = 22;
  const d = 15;
  // The papers inside, a shade offset so their edge peeks out past the cover on the room side.
  box(ctx, fit, ix + 1, iy + 1, sn ? w - 2 : d - 2, sn ? d - 2 : w - 2, 1.2, '#fbf8f1', up);
  box(ctx, fit, ix, iy, sn ? w : d, sn ? d : w, 1, '#e6b862', up + 1.2); // the cover, flat and manila
  // The tab along the back edge — the silhouette that says folder rather than pad.
  box(ctx, fit, ix - (sn ? 5 : 0), iy - (sn ? 0 : 5), sn ? 9 : 2, sn ? 2 : 9, 1, '#d4a04c', up + 2.2);
}

/** A desk tray with a card in it (two when more than one wait): reviews routed to this member. */
function deskTray(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  count: number,
): void {
  const w = 17;
  const d = 13;
  box(ctx, fit, ix, iy, sn ? w : d, sn ? d : w, 4, '#3f4652', up); // the tray, a low dark rim
  // The cards lie IN it, their tops just over the rim: flat white, never a block.
  box(ctx, fit, ix, iy, sn ? w - 4 : d - 4, sn ? d - 4 : w - 4, 0.8, '#fbf6ea', up + 3.6);
  if (count > 1) box(ctx, fit, ix - 1, iy + 1, sn ? w - 4 : d - 4, sn ? d - 4 : w - 4, 0.8, '#efe6d2', up + 4.4);
}

/** A pen cup: a short tumbler with two or three stems leaning out of it. */
function deskPens(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  up: number,
  id: number,
): void {
  const { w } = PROP_SPEC.pens;
  box(ctx, fit, ix, iy, w, w, 9, '#6b7480', up); // the cup
  const g = project(ix, iy, fit);
  const top = g.y - (up + 9) * fit.scale;
  // Stems: deterministic per desk, so a pen cup never flickers between frames.
  const inks = ['#c9584a', '#3d6b8f', '#e0a72b', '#5f8a5a'];
  const n = 2 + Math.floor(deskRnd(id, 44) * 2);
  for (let i = 0; i < n; i++) {
    const lean = (i - (n - 1) / 2) * 2.2 * fit.scale;
    const ink = inks[Math.floor(deskRnd(id, 45 + i) * inks.length)]!;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, 1.6 * fit.scale);
    ctx.beginPath();
    ctx.moveTo(g.x + lean * 0.3, top + 2 * fit.scale);
    ctx.lineTo(g.x + lean, top - 7 * fit.scale);
    ctx.stroke();
  }
}

/** Two or three books, stacked and slightly out of true — a low mass, readable by silhouette. */
function deskBooks(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  id: number,
): void {
  const { w, d } = PROP_SPEC.books;
  const spines = ['#7b5ea7', '#c0705a', '#4e7f6e', '#c9a227', '#5a6d9a'];
  const n = 2 + Math.floor(deskRnd(id, 46) * 2);
  let h = up;
  for (let i = 0; i < n; i++) {
    // Each volume a little narrower and nudged off the one below, so the stack is not a solid block.
    const shrink = i * 1.6;
    const skew = (deskRnd(id, 47 + i) - 0.5) * 3;
    const color = spines[Math.floor(deskRnd(id, 50 + i) * spines.length)]!;
    box(
      ctx,
      fit,
      ix + (sn ? skew : 0),
      iy + (sn ? 0 : skew),
      sn ? w - shrink : d - shrink,
      sn ? d - shrink : w - shrink,
      4,
      color,
      h,
    );
    h += 4;
  }
}

/** FNV-ish hash of (desk id, salt) → a stable 0..1. Deterministic, so props never flicker per frame. */
function deskRnd(id: number, salt: number): number {
  let h = (2166136261 ^ (id + 1)) >>> 0;
  h = Math.imul(h, 16777619) ^ (salt * 0x9e3779b1);
  h = Math.imul(h, 16777619);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The optional personal props and where each sits on the desk, in desk-relative (along-facing, across)
 * coords: `along` +toward the monitor / −toward the seat, `across` +right / −left. `salt`+`prob` decide
 * per-desk presence from a stable hash. Shared by the canvas draw AND the animated-overlay anchors
 * (`animatedDeskAnchors`) so the spinning fan / coffee steam land exactly on the drawn prop. */
const PROP_KINDS = [
  'coffee',
  'water',
  'plant',
  'photo',
  'fan',
  'notebook',
  'pens',
  'books',
] as const;
type PropKind = (typeof PROP_KINDS)[number];
/**
 * Each personal prop: how likely it is on a given desk, where it stands, and the footprint it stands
 * ON — `w` across the shoulders, `d` along the facing, both in logical units.
 *
 * `w`/`d` are here rather than buried in each draw function because "a prop is on the desk it is
 * standing on" is only an invariant if something can ask. It was not one: the bench dock stood 17
 * units past its counter's back edge, and widening the laptop 20 → 24 in #1394 pushed the pod dock
 * off its slab, both caught by eye on the broadcast rather than by CI. `render.test.ts` reads these.
 * They describe the BASE — the pot, not the foliage; a plant's leaves may overhang, a pot may not.
 *
 * The last three were added 2026-09-15 (nick: "some of the desks in the clusters have unused
 * space"). Five kinds over two flanks left a third of desks carrying one prop or none, and only
 * photo and fan on the `+across` side, so one flank was sparse by construction. These fill the front
 * lip and that flank, and are chosen to read by SILHOUETTE at ~40px: a flat pad, a short cup with
 * stems, a low stack. Deliberately not a fourth small cylinder — that reads as another mug.
 */
export const PROP_SPEC: Record<
  PropKind,
  { salt: number; prob: number; along: number; across: number; w: number; d: number }
> = {
  coffee: { salt: 1, prob: 0.4, along: -4, across: -34, w: 11, d: 11 },
  water: { salt: 2, prob: 0.42, along: 7, across: -36, w: 9, d: 9 },
  /*
   * FRONT-left corner, not the back-left one. It stood at `along: 20`, which is the DOCK's patch on
   * an N or E desk (`dockAcross` puts the cradle at −38 there) — so on 3 of 13 desks a plant pot and
   * a laptop cradle occupied the same square of desk, interpenetrating. Nobody could have caught it
   * from the desk's own frame, because the dock changes sides with the facing and the plant does not.
   * Moved forward rather than outward: the back-left corner belongs to the dock on half the floor,
   * and the front lip was empty on every facing anyway (2026-09-15).
   */
  plant: { salt: 3, prob: 0.46, along: -22, across: -40, w: 12, d: 12 },
  /* Front-right, for the same reason the plant moved off the back-left: `along: 20` on the +across
     flank is the dock's patch on an S or W desk. Latent rather than live — today's hashes happen to
     put every photo on an N/E desk — but a re-hash or a re-faced desk would have framed a photo
     inside a laptop cradle, and nothing would have said so. */
  photo: { salt: 4, prob: 0.42, along: -27, across: 24, w: 20, d: 6 },
  // prob 0.38 → 0.12 → 0.22 (2026-10-27): 0.12 with the bare-desk fallback put a fan on ten of 23 desks
  // (nick: "too many desk fans"); without the fallback 0.12 rolled none, 0.22 rolls three. A fan is a
  // quirk a few desks have, and a mug (0.4 → nine of 22) is the other.
  fan: { salt: 6, prob: 0.22, along: -10, across: 38, w: 9, d: 9 },
  /** A closed pad on the front lip — the one part of every desk that was empty on every facing. */
  notebook: { salt: 7, prob: 0.42, along: -27, across: -22, w: 18, d: 12 },
  /** Pen cup: short, with a few coloured stems. The near end of the sparse `+across` flank. */
  pens: { salt: 8, prob: 0.4, along: -25, across: 42, w: 9, d: 9 },
  /** A low stack of books, outboard of the photo — mass at small scale, not another upright. */
  books: { salt: 9, prob: 0.38, along: 6, across: -20, w: 16, d: 12 },
};
/** Whether a given desk carries a given prop — a stable per-desk hash, independent of who's seated.
 * Exported for the ambient scheduler: a sip beat needs a mug on that member's desk to sip from. */
const rolledProp = (id: number, kind: PropKind): boolean =>
  deskRnd(id, PROP_SPEC[kind].salt) < PROP_SPEC[kind].prob;
export function deskHasProp(id: number, kind: PropKind): boolean {
  // Decided here, so the baked prop, the sip mug and the Tier-A overlay all agree. Lane 01M50X1WRW
  // once filled every bare desk with a mug or a fan so no desk sat still; nick reversed that on
  // 2026-10-27 ("fewer mugs"): on the stream each mug's three steam wisps are three CSS animations
  // repainted in software every frame, 57 of the page's 117. A mug is the hash's call, like every prop.
  return rolledProp(id, kind);
}
/** The mug colour a desk's coffee cup uses — one hash shared by the desk prop and the in-hand sip mug. */
function deskMugColor(id: number): string {
  return MUGS[Math.floor(deskRnd(id, 11) * MUGS.length)]!;
}
/** Desk-relative (along,across) → absolute logical point, given the desk's facing. */
function deskPoint(
  slot: { lx: number; ly: number; dir: Dir },
  along: number,
  across: number,
): [number, number] {
  const f = FWD[slot.dir];
  return [slot.lx + f[0] * along - f[1] * across, slot.ly + f[1] * along + f[0] * across];
}

/** A flat keyboard: a base tray + a slightly raised key deck, oriented across the desk (facing-relative).
 * `shoulder` is its width along the shoulders (compact/standard/full) — per-desk, so keyboards vary. */
function deskKeyboard(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  shoulder = 34,
): void {
  box(ctx, fit, ix, iy, sn ? shoulder : 13, sn ? 13 : shoulder, 3, KEYBOARD, up);
  box(ctx, fit, ix, iy, sn ? shoulder - 4 : 9, sn ? 9 : shoulder - 4, 4, '#3b414a', up); // key deck, a touch proud of the tray
}

/** A little mouse beside the keyboard — long axis pointing front-to-back, rounded top. Shell colour varies
 * per desk (`color`) so no two stations are quite identical. */
function deskMouse(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  color = MOUSE,
): void {
  box(ctx, fit, ix, iy, sn ? 7 : 11, sn ? 11 : 7, 4, color, up);
  const g = project(ix, iy, fit);
  ellipse(
    ctx,
    { x: g.x, y: g.y - (up + 4) * fit.scale },
    5 * fit.scale,
    3 * fit.scale,
    mul(color, 1.2),
  );
}

function deskCoffee(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  up: number,
  mug: string,
  filled: boolean,
): void {
  box(ctx, fit, ix, iy, 11, 11, 12, mug, up); // mug body
  const g = project(ix, iy, fit);
  const rim = { x: g.x, y: g.y - (up + 12) * fit.scale };
  // A full mug (a member's at the desk) shows a dark coffee surface and steams; an unattended mug is
  // drawn empty — just its bare inner shadow, no coffee, no steam.
  ellipse(ctx, rim, 5.2 * fit.scale, 2.5 * fit.scale, filled ? '#3a2416' : dim(mug, 0.68));
}

function deskWater(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  up: number,
): void {
  box(ctx, fit, ix, iy, 9, 9, 24, '#bfe3f2', up); // translucent-looking body
  box(ctx, fit, ix, iy, 6, 6, 4, '#5aa0c9', up + 24); // cap
}

/** A standing photo frame: a thin upright frame with an inset "photo" panel on its room-facing faces. */
function deskPhoto(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  sn: boolean,
  up: number,
  photo: string,
): void {
  box(ctx, fit, ix, iy, sn ? 20 : 6, sn ? 6 : 20, 18, '#cfc8b8', up); // frame
  box(ctx, fit, ix, iy, sn ? 15 : 3, sn ? 3 : 15, 13, photo, up + 3); // inset photo (shows on the visible faces)
}

/** A small potted desk plant — terracotta pot + a low leafy cluster. */
function deskPlant(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  up: number,
): void {
  box(ctx, fit, ix, iy, 12, 12, 9, '#b9603a', up);
  const g = project(ix, iy, fit);
  const ty = g.y - (up + 9) * fit.scale;
  ellipse(ctx, { x: g.x, y: ty - 4 * fit.scale }, 9 * fit.scale, 7 * fit.scale, '#5f9350');
  ellipse(
    ctx,
    { x: g.x - 4 * fit.scale, y: ty - 1 * fit.scale },
    5 * fit.scale,
    4 * fit.scale,
    '#74a860',
  );
  ellipse(
    ctx,
    { x: g.x + 4 * fit.scale, y: ty - 6 * fit.scale },
    4.5 * fit.scale,
    4 * fit.scale,
    '#6fa35a',
  );
}

/** Where a desk lamp's shade sits on screen, for the emissive pass — the same anchor `deskLamp` draws
 * its shade at (`up + 26`), so the light and the fixture can never drift apart. */
function lampHeadPoint(slot: { lx: number; ly: number; dir: Dir }, fit: Fit): Pt {
  const [ix, iy] = deskPoint(slot, LAMP_ALONG, LAMP_ACROSS);
  const g = project(ix, iy, fit);
  return { x: g.x, y: g.y - (DESK_UP + 26) * fit.scale };
}

/** Where the lamp stands on an occupied desk (desk-relative along/across — the old #222 prop spot). */
const LAMP_ALONG = 8;
const LAMP_ACROSS = 42;

/**
 * Where the dock stands, and why it is the one prop whose across is computed rather than written.
 *
 * **A docked laptop must never cover the front of a screen** (nick, 2026-09-04), and on this floor
 * that is two conditions, not one — outboard of the widest panel, AND behind it in the painter's
 * order, so an overlap that survives the first still cannot paint over the glass.
 *
 * Outboard is the easy half: `DOCK_ACROSS` sits past 35, which is as far as any setup reaches (a
 * dual's two 34-wide panels centred at ±18).
 *
 * Behind is the half that cannot be a constant. `at()` sorts by `(f[0]+f[1])·along + (p[0]+p[1])·across`,
 * and the sign of the ACROSS term flips between the two camera-facing rows — +1 on an N desk, −1 on a
 * W one. So one fixed across puts the dock behind the monitor on one row and in front of it on the
 * other, which is exactly how a prop ends up covering a screen on half the floor and looking fine on
 * the half you happened to check. Sending it to `-j · DOCK_ACROSS` makes the across term subtract at
 * every facing, so "behind the monitor" is a property of the geometry rather than of the desk id.
 *
 * `dockAcross` and `deskPropSort` are exported so that property can be a TEST rather than a claim —
 * see render.test.ts, which walks every facing against the widest setup on the floor.
 */
const DOCK_ALONG = 26;

/** The cradle's footprint along the facing — the piece that must be standing on furniture. Named
 *  because the bench has to reason about it: `deskDock` drew it as a bare 12 and nothing could ask. */
export const DOCK_CRADLE_ALONG = 12;
/* 40 → 38. The dock sits outboard, and `|dockAcross| + DOCK_HALF_ACROSS` must stay within the slab's
   half-width (DESK_W / 2 = 50) or the cradle hangs off the desk edge. When the docked laptop grew from
   20 to 24 across (#1394) that sum went to 52 and the stands started reading as though they were in
   front of the monitors, out over nothing (nick, on the broadcast, 2026-09-14). 38 + 12 = 50 exactly. */
const DOCK_ACROSS = 38;

/** The docked slab's width across the shoulders — the ONE place it is written.
 *
 *  `DOCK_HALF_ACROSS` below is derived from it rather than restated, because the pair already drifted
 *  once: the constant said "20 across" in a comment while `deskDock` drew 24, so every test that
 *  reasoned about clearance was reasoning about a laptop that is not on the floor. A number used by
 *  both the painter and the invariant has to have a single home. */
const DOCK_LAPTOP_W = 24;

/** Where the monitor sits along the desk — the back of the slab, `at(Df / 2 - 12, 0)`. */
export const MONITOR_ALONG = DESK_D / 2 - 12;

/** How far a panel reaches from the desk's centreline, across the shoulders: a dual's outer edge —
 *  two 34-wide panels centred at ±18 — which is wider than an ultrawide's 54. */
export const WIDEST_PANEL_HALF = 35;

/** Half the dock's footprint across the shoulders. The LAPTOP is the widest piece, not the cradle
 *  under it — `DOCK_LAPTOP_W` against the cradle's 21, because the slab stands with its broad face to
 *  the room. Getting this wrong understates the overlap by the exact amount that matters, which is
 *  precisely what happened when the slab was widened and this stayed at 10. */
export const DOCK_HALF_ACROSS = DOCK_LAPTOP_W / 2;

/** The dock's across for a given facing: outboard, and on the side whose sort term SUBTRACTS. */
export function dockAcross(dir: Dir): number {
  const f = FWD[dir];
  return -(-f[1] + f[0]) * DOCK_ACROSS; // p = [-f[1], f[0]], so j = p[0] + p[1] = -f[1] + f[0]
}

/** The painter's key `drawWorkstation`'s `at()` gives a desk-relative prop — larger paints later,
 *  i.e. nearer the viewer. Exported so the dock's "behind the monitor" claim can be falsified. */
export function deskPropSort(dir: Dir, along: number, across: number): number {
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]];
  return f[0] * along + p[0] * across + (f[1] * along + p[1] * across);
}

/**
 * Where a bench seat's monitor and dock stand — DERIVED FROM THE COUNTER, because the bench is not a
 * pod desk and the pod desk's constants do not fit on it.
 *
 * `DOCK_ALONG` (26) and `DOCK_ACROSS` (38) are tuned to DESK_D 68 / DESK_W 100, and the comment on
 * DOCK_ACROSS is explicit that 38 + DOCK_HALF_ACROSS lands on the pod slab's edge "exactly". The
 * bench counter is BENCH.deep (30) deep and each seat owns BENCH.long / BENCH.seats (75) of the top.
 * Handed the pod numbers, the dock stood 17 units past the counter's back edge — in the air — and
 * leaned 12.5 units into the next seat. nick saw it on /live as laptops floating in front of the
 * monitors, 2026-09-15.
 *
 * The monitor already did this right (`BENCH.deep / 2 - 12`); these two put the dock on the same
 * footing, so both props are functions of the furniture rather than one of each.
 */
export function benchMonitorAt(slot: { lx: number; ly: number; dir: Dir }): {
  lx: number;
  ly: number;
} {
  return benchAt(slot, BENCH.deep / 2 - 12, 0);
}

export function benchDockAt(slot: { lx: number; ly: number; dir: Dir; id: number }): {
  lx: number;
  ly: number;
} {
  // As far back as the cradle can stand with its whole footprint on the counter…
  const along = BENCH.deep / 2 - DOCK_CRADLE_ALONG / 2;
  // …and outboard to the edge of THIS seat's share, on the side whose sort term subtracts — the same
  // rule `dockAcross` applies on a pod desk, measured against the width this seat actually has.
  const room = BENCH.long / BENCH.seats / 2 - DOCK_HALF_ACROSS;
  const across = Math.sign(dockAcross(slot.dir)) * room;
  return benchAt(slot, along, across);
}

/** Desk-relative (along-facing, across-shoulders) → floor, for a bench seat. */
function benchAt(
  slot: { lx: number; ly: number; dir: Dir },
  along: number,
  across: number,
): { lx: number; ly: number } {
  const f = FWD[slot.dir];
  const p: [number, number] = [-f[1], f[0]];
  return { lx: slot.lx + f[0] * along + p[0] * across, ly: slot.ly + f[1] * along + p[1] * across };
}

/** A bench prop's paint key, in floor coords — `deskPropSort` reached through the seat's own frame,
 *  so the bench and the pod desks order their props by one rule rather than two. */
export function benchPropSort(
  slot: { lx: number; ly: number; dir: Dir },
  at: { lx: number; ly: number },
): number {
  const f = FWD[slot.dir];
  const p: [number, number] = [-f[1], f[0]];
  const dx = at.lx - slot.lx;
  const dy = at.ly - slot.ly;
  // Project the offset back onto (along, across) — the basis is orthonormal, so a dot product each.
  return deskPropSort(slot.dir, f[0] * dx + f[1] * dy, p[0] * dx + p[1] * dy);
}

/**
 * The desk's ROOM-SIDE HALF, redrawn as its own depth item so a member standing in front of a desk
 * is not painted behind it.
 *
 * The problem this solves, and the two failed attempts before it (#1394, #1400). `depth(lx,ly) =
 * lx + ly` gives one scalar per item, and a desk anchored at its centre sits (w + d) / 2 behind the
 * edge the viewer sees — 84 units on a 100x68 desk. A member plainly in FRONT of that edge still
 * keys lower than the desk and paints behind it. Moving the whole desk's key forward fixes that and
 * breaks the opposite case: a desk facing N or W puts its CHAIR on the near side, so its own sitter
 * keys higher than the desk centre, and a forward slab buries their head and torso. One key cannot
 * answer both questions, because the passer-by and the sitter are asking opposite ones.
 *
 * So the desk keeps its centre key and everything that depends on it — the whole workstation, every
 * prop, the seated arms overlay — is untouched, which is what makes this safe. What is ADDED is the
 * front half of the slab and its two front legs, drawn again at the FRONT EDGE's depth. Same pixels,
 * same colours: on an empty stretch of floor the second pass is invisible, because it repaints
 * exactly what the first pass already put there. It only changes anything where a body has landed in
 * between, and there it is the correct answer — the near lip of the desk is in front of you.
 *
 * `render.test.ts` pins the ordering at all four facings, which is the check #1394 did not have.
 */
/** The rendered base for a desk: `desk/base` (S/N) or `desk/base-ew`, with a `-c` compact pair. */
export function deskBaseId(slot: { dir: Dir; size?: 'compact' }): string {
  const sn = slot.dir === 'S' || slot.dir === 'N';
  return `desk/base${slot.size === 'compact' ? '-c' : ''}${sn ? '' : '-ew'}`;
}

/** Clip `ctx` to the near half's silhouette — the extruded box from the floor to the worktop over the
 * +ly half of the desk. The caller saves and restores. */
function clipToNearHalf(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: { lx: number; ly: number; dir: Dir; size?: 'compact' },
): void {
  const { lx, ly, dir } = slot;
  const sn = dir === 'S' || dir === 'N';
  const { w, d } = deskDims(slot);
  const wx = sn ? w : d;
  const dy = sn ? d : w;
  const corners: Pt[] = [];
  for (const [cx, cy] of [
    [lx - wx / 2, ly],
    [lx + wx / 2, ly],
    [lx + wx / 2, ly + dy / 2],
    [lx - wx / 2, ly + dy / 2],
  ] as const) {
    const q = project(cx, cy, fit);
    corners.push(q, { x: q.x, y: q.y - DESK_UP * fit.scale });
  }
  const h = hull(corners);
  ctx.beginPath();
  h.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
  ctx.closePath();
  ctx.clip();
}

/** The props standing on the near half, painted again over `deskNearHalf` and inside the same clip.
 * The second pass repaints the worktop, so without this every prop on the room-side half lost its
 * foot to its own desk — a fan sunk into the slab, a monitor's stand gone (nick, 2026-10-21). The
 * clip keeps it additive: inside it the worktop was just repainted opaque, so the props land on the
 * same pixels as the first pass; outside it nothing is touched, so a soft shadow is not doubled. */
function nearHalfProps(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: { lx: number; ly: number; dir: Dir },
  draw: () => void,
): void {
  ctx.save();
  clipToNearHalf(ctx, fit, slot);
  draw();
  ctx.restore();
}

function deskNearHalf(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: DeskSlot,
  rendered: RenderedAssets,
): void {
  const { lx, ly } = slot;
  // The same base image again, clipped to the near half's silhouette (the extruded box from the floor
  // to the worktop) — the same pixels, so additive by construction. The half NEAREST THE CAMERA is
  // +lx / +ly — a property of the projection, not of the facing (`clipToNearHalf`).
  ctx.save();
  clipToNearHalf(ctx, fit, slot);
  blitIf(ctx, fit, rendered, deskBaseId(slot), lx, ly);
  ctx.restore();
}

/**
 * The depth key for that near half — and why it is not a constant.
 *
 * The near half wants to key at the desk's NEAR CORNER, so it beats a member standing in front of the
 * desk. But on an N or W desk the CHAIR is on the near side too, so that desk's own sitter also keys
 * past the desk centre — and a near-corner key would paint the desk over them, which is exactly the
 * regression #1394 shipped and #1400 reverted.
 *
 * Both cases are satisfiable, just not by one number: key at the near corner, EXCEPT never past the
 * member seated at this desk. An empty desk has no such constraint and takes the corner.
 *
 * That is the piece the first attempt was missing. It went looking for a better ANCHOR, when what the
 * geometry needs is for the anchor to depend on who is sitting there — which the render loop knows
 * and `nearDepth` never could.
 */
export function deskNearDepth(
  slot: { lx: number; ly: number; dir: Dir; size?: 'compact' },
  seatedAt: { lx: number; ly: number } | null,
): number {
  const sn = slot.dir === 'S' || slot.dir === 'N';
  const { w, d } = deskDims(slot);
  const wx = sn ? w : d;
  const dy = sn ? d : w;
  const corner = depth(slot.lx + wx / 2, slot.ly + dy / 2);
  if (!seatedAt) return corner;
  return Math.min(corner, depth(seatedAt.lx, seatedAt.ly) - 0.2);
}

/** The desk of a workstation: legs + slab + oriented monitor (glowing if its owner works), plus a
 * keyboard + mouse and a deterministic mix of personal props. The task chair and the seated member are
 * NOT drawn here — the chair is its own depth item at its own footprint (see renderScene) and members are
 * free actors (see `drawActor`), so chair < sitter < desk (or the mirror of it, by facing) paint in true
 * painter's order instead of the desk blob swallowing both. Surface props self-sort back-to-front within
 * the desk by their own footprint depth, so a tall lamp/photo behind a mug never paints through it. */
export function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: { lx: number; ly: number; dir: Dir; id: number },
  node: OfficeNode | null,
  teamName: string,
  /** This desk is a kept, bodiless desk — an offline owner's or a stepped-away member's (§4). */
  owned: boolean,
  t: number,
  /** Props to skip this frame — a prop currently "in the owner's hand" (sip mug) isn't on the desk. */
  hide: Set<PropKind> | undefined,
  /** Is it dark enough out for desk lamps to be on? (`LightEnv.lampsOn`, threaded from the scene.) */
  lampsLit: boolean,
  /**
   * `workingAtDesk(owner, pose.sit)` — the owner is working AND has sat down here.
   *
   * ONE boolean for the screen and the dock, because they are one event: the member sits, the laptop
   * goes in the dock, and the monitor wakes (nick, 2026-09-04). It is not `audiblyWorking` alone —
   * that is true from the instant a posture flips, so a seat that came online already `working` lit
   * its screen and filled its dock while its body was still crossing the floor. The room's typing
   * sound and the loop's park check read the same predicate, so the E2 §2 contract holds: eyes, ears
   * and loop cannot disagree.
   */
  atWork: boolean,
  phase: WorkstationPhase,
  /** The pre-rendered art: the desk base, lamp and fan (plan Tasks 3 and 7). */
  rendered: RenderedAssets,
  /** Only the props on the near (+ly) half, and no base — the `nearHalfProps` pass. */
  nearOnly = false,
): void {
  monitorArt = rendered;
  const { lx, ly, dir, id } = slot;
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]]; // desk-left/right unit (perpendicular to facing)
  const sn = dir === 'S' || dir === 'N';
  const up = DESK_UP; // desk-surface height — where every prop sits (legs + slab)
  // A lit screen full of scrolling code is the strongest "this seat is working" signal in the room, so
  // it follows `workingAtDesk` — posture (never `activity`, which lags) AND a body in this chair. An
  // idle member who spilled onto a desk, a stale member still carrying `activity: working`, and a
  // working member still walking in from the door all get a dark screen, like any empty desk.
  const working = atWork;
  const mood = node ? deskMoodStyle(deskMoodFor(teamName, node.name)) : null;
  // Owned empty desk (presence-honesty §4): the offline owner keeps the desk — chair in, monitor
  // dark, their name baked on a small plate. The lamp is off (nobody switched it on), a warm screen
  // glow fades over the first hour since they left, and a disconnected seat gets an amber glint.
  // A stepped-away owner is present-but-absent (declared): same bodiless desk, different words —
  // `ownedDeskWarmAlpha` owns that distinction now, because the sprite key and the paint must agree.
  const ownedEmpty = node != null && owned;

  if (phase === 'monitor') {
    if (nearOnly && f[1] * MONITOR_ALONG < 0) return;
    monitor(
      ctx,
      fit,
      lx + f[0] * MONITOR_ALONG,
      ly + f[1] * MONITOR_ALONG,
      dir,
      working,
      up,
      id,
      t,
      screenLifeFor(node),
    );
    return;
  }

  // The base — legs, slab and its bevelled lip — is one rendered image: `desk/base` for a S/N desk,
  // `desk/base-ew` for an E/W one (plan Task 3).
  if (phase !== 'post' && !nearOnly) blitIf(ctx, fit, rendered, deskBaseId(slot), lx, ly);

  // Surface props, placed in desk-relative (along-facing, across) coords and self-sorted back-to-front so
  // overlaps paint correctly regardless of the desk's facing. `along` +toward the monitor, −toward the seat.
  interface Prop {
    sum: number;
    fn: () => void;
    /** The monitor — the sprite cache's split point (see `WorkstationPhase`). */
    monitor?: true;
  }
  const props: Prop[] = [];
  const at = (
    along: number,
    across: number,
    fn: (ix: number, iy: number) => void,
    monitor?: true,
  ): void => {
    const ix = lx + f[0] * along + p[0] * across;
    const iy = ly + f[1] * along + p[1] * across;
    if (nearOnly && iy < ly) return;
    props.push({
      sum: deskPropSort(dir, along, across),
      fn: () => fn(ix, iy),
      ...(monitor ? { monitor } : {}),
    });
  };

  // The monitor at the back, then the keyboard + mouse pulled in to where a seated member's hands actually
  // land (`KEYBOARD_ALONG`; `skeleton.ts` reaches for exactly this spot).
  const kbShoulder = KEYBOARD_WIDTHS[Math.floor(deskRnd(id, KB_SALT) * KEYBOARD_WIDTHS.length)]!;
  const mouseColor = MOUSE_COLORS[Math.floor(deskRnd(id, KB_SALT + 1) * MOUSE_COLORS.length)]!;
  // Felt desk mat under the keyboard + mouse (Delight D) — a deep-green pad that gives the work
  // gear a home and breaks up the bare slab. Flat paint sorted a hair before the keyboard so it
  // never covers what sits on it.
  if (node)
    at(KEYBOARD_ALONG - 1, 6, (ix, iy) => {
      const quad = (a: number, cr: number): Pt =>
        project(ix + f[0] * a + p[0] * cr, iy + f[1] * a + p[1] * cr, fit);
      const yUp = up * fit.scale;
      const c1 = quad(-11, -30);
      const c2 = quad(11, -30);
      const c3 = quad(11, 30);
      const c4 = quad(-11, 30);
      ctx.fillStyle = 'rgba(38, 66, 54, 0.85)';
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y - yUp);
      ctx.lineTo(c2.x, c2.y - yUp);
      ctx.lineTo(c3.x, c3.y - yUp);
      ctx.lineTo(c4.x, c4.y - yUp);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 238, 205, 0.14)';
      ctx.lineWidth = Math.max(1, fit.scale);
      ctx.stroke();
    });
  at(
    MONITOR_ALONG,
    0,
    (ix, iy) => monitor(ctx, fit, ix, iy, dir, working, up, id, t, screenLifeFor(node)),
    true,
  );
  // The dock, beside and behind the monitor on every desk — not a hashed personality prop and not
  // owner-dependent: the cradle is always there, and the laptop in it is there exactly when its owner
  // is working AND sitting at it. An empty dock on a desk with a body at it is honest, not a gap —
  // that member is not working, and the room says so in three places at once (dark screen, empty
  // dock, laptop in their lap).
  at(DOCK_ALONG, dockAcross(dir), (ix, iy) => deskDock(ctx, fit, ix, iy, dir, up, atWork));
  at(KEYBOARD_ALONG, 0, (ix, iy) => deskKeyboard(ctx, fit, ix, iy, sn, up, kbShoulder));
  at(KEYBOARD_ALONG + 2, 27, (ix, iy) => deskMouse(ctx, fit, ix, iy, sn, up, mouseColor));
  // The desk lamp is work gear, not a hashed personality prop: every OCCUPIED desk has one (the
  // sitter brought it), no empty desk ever does — see deskLamp for the #304 story. Lit only after dark.
  // Rendered (plan Task 7): the lamp is `desk/lamp-off` or `desk/lamp-on` (the lit one carries its
  // own pool on the slab). `lampHead`'s additive core still paints after the veil, so a lit lamp reads
  // as lit at night.
  if (node)
    at(LAMP_ALONG, LAMP_ACROSS, (ix, iy) => {
      blitIf(
        ctx,
        fit,
        rendered,
        lampsLit && !ownedEmpty ? 'desk/lamp-on' : 'desk/lamp-off',
        ix,
        iy,
      );
    });

  // optional personal props — each present-or-not per desk by a stable hash, at its own station
  const waiting = node?.waiting ?? null;
  for (const kind of PROP_KINDS) {
    if (hide?.has(kind)) continue;
    if (kind === 'notebook' && waiting?.kind === 'handoff') continue; // the folder lies where the pad was
    if (!deskHasProp(id, kind) && !mood?.props.includes(kind)) continue;
    const sp = PROP_SPEC[kind];
    at(sp.along, sp.across, (ix, iy) => {
      switch (kind) {
        case 'coffee':
          return deskCoffee(ctx, fit, ix, iy, up, deskMugColor(id), node != null);
        case 'water':
          return deskWater(ctx, fit, ix, iy, up);
        case 'plant':
          return deskPlant(ctx, fit, ix, iy, up);
        case 'photo':
          return deskPhoto(
            ctx,
            fit,
            ix,
            iy,
            sn,
            up,
            PHOTOS[Math.floor(deskRnd(id, 41) * PHOTOS.length)]!,
          );
        case 'fan': {
          // Rendered: four blade positions; the blades turn only while someone is at the desk
          // (spec §3.1 item 5 — a prop moves only with a sitter), 8 steps a second.
          const frame = node ? Math.floor(t * 8) % 4 : 0;
          blitIf(ctx, fit, rendered, `desk/fan-${frame}`, ix, iy);
          return;
        }
        case 'notebook':
          return deskNotebook(
            ctx,
            fit,
            ix,
            iy,
            sn,
            up,
            NOTEBOOK_COVERS[Math.floor(deskRnd(id, 43) * NOTEBOOK_COVERS.length)]!,
          );
        case 'pens':
          return deskPens(ctx, fit, ix, iy, up, id);
        case 'books':
          return deskBooks(ctx, fit, ix, iy, sn, up, id);
      }
    });
  }

  // What is waiting at this desk right now (deskWaiting.ts): one prop, baked into the desk sprite
  // like every other — it changes the sprite key, so it costs a re-bake when it starts and ends,
  // and nothing per frame.
  if (waiting?.kind === 'blocked')
    // Pushed after the monitor at the monitor's own key: a tie sorts after it, so the note sits on the panel.
    at(MONITOR_ALONG, 0, (ix, iy) => deskStickyNote(ctx, fit, ix, iy, up));
  else if (waiting?.kind === 'handoff') {
    const sp = PROP_SPEC.notebook;
    at(sp.along, sp.across, (ix, iy) => deskFolder(ctx, fit, ix, iy, sn, up));
  } else if (waiting?.kind === 'review')
    at(TRAY_ALONG, -dockAcross(dir), (ix, iy) => deskTray(ctx, fit, ix, iy, sn, up, waiting.count));

  // The owned-desk plate + texture (presence-honesty §4) ride the same prop pipeline so they
  // depth-sort with the desk. All static paint keyed to data refreshes — no new rAF.
  if (ownedEmpty && node) {
    // warm desk: screen afterglow fades over ~1h; a stepped-away desk keeps it (they just left)
    const warmAlpha = ownedDeskWarmAlpha(node, owned);
    if (warmAlpha)
      at(MONITOR_ALONG, 0, (ix, iy) => {
        const b = project(ix, iy, fit);
        ctx.fillStyle = `rgba(122, 148, 156, ${warmAlpha})`;
        ctx.fillRect(
          b.x - 15 * fit.scale,
          b.y - (up + 23) * fit.scale,
          30 * fit.scale,
          18 * fit.scale,
        );
      });
  }

  props.sort((a, b) => a.sum - b.sum);
  // Split by the monitor's INDEX in the sorted order, not by its sort key: the owned-desk afterglow
  // and the dock can TIE with it, and a tie that sorts after the monitor must still paint after the
  // screen face. An index cannot be ambiguous where a key can.
  const mi = props.findIndex((pr) => pr.monitor);
  props.forEach((pr, i) => {
    if (phase === 'pre' && mi >= 0 && i >= mi) return;
    if (phase === 'post' && (mi < 0 || i <= mi)) return;
    pr.fn();
  });
}

/**
 * The owned-desk afterglow alpha, formatted EXACTLY as `drawWorkstation` paints it — '' when it does
 * not paint. One formula for the paint and for the sprite key: the fade over an hour is the one
 * `Date.now()`-derived input in the room, and it enters the key only as the string it paints with.
 */
export function ownedDeskWarmAlpha(
  node: OfficeNode | null,
  owned: boolean,
  now = Date.now(),
): string {
  if (!node || !owned) return '';
  const steppedAway = node.presence !== 'offline';
  const age = node.last_seen_at != null ? now - node.last_seen_at : Infinity;
  const warmth = steppedAway ? 0.6 : Math.max(0, 1 - age / 3_600_000);
  return warmth > 0 ? (0.18 * warmth).toFixed(3) : '';
}

/** The fit's contribution to every sprite key — `ox`/`oy` move the pixel grid, not just `scale`. */
export function fitKey(fit: Fit): string {
  return `${fit.ox}:${fit.oy}:${fit.scale}`;
}

/** The resolved scene palette, as a key fragment — a theme flip is one cold re-rasterization. */
export function paletteKey(): string {
  return `${PAL.floor}|${PAL.floor2}|${PAL.wood}|${PAL.couch}|${PAL.wall}`;
}

/** A workstation sprite's key: exactly the inputs that change its pixels, and never `t`. */
export function workstationKey(k: {
  slot: { id: number; dir: Dir };
  node: OfficeNode | null;
  teamName: string;
  owned: boolean;
  working: boolean;
  lampLit: boolean;
  hidden: ReadonlySet<PropKind> | undefined;
  fit: Fit;
  dpr: number;
  warmAlpha: string;
}): string {
  const steppedAway = k.node != null && k.owned && k.node.presence !== 'offline';
  return [
    'ws',
    k.slot.id,
    k.slot.dir,
    k.node?.name ?? '',
    k.teamName,
    k.owned ? 1 : 0,
    steppedAway ? 1 : 0,
    k.working ? 1 : 0,
    k.lampLit ? 1 : 0,
    k.hidden ? [...k.hidden].sort().join('+') : '',
    k.warmAlpha,
    deskWaitingKey(k.node?.waiting),
    fitKey(k.fit),
    k.dpr,
    paletteKey(),
  ].join('·');
}

/** One bench seat's gear: monitor + keyboard on the shared counter. The screen faces the sitter —
 * which is also toward the camera, so a working bench member still shows a lit screen to the room. */
function benchStation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: DeskSlot,
  node: OfficeNode | null,
  t: number,
  /** Owner working AND sitting here — see the note on `drawWorkstation`'s parameter of the same name. */
  atWork = false,
): void {
  const kbShoulder =
    KEYBOARD_WIDTHS[Math.floor(deskRnd(slot.id, KB_SALT) * KEYBOARD_WIDTHS.length)]!;
  /*
   * Sorted back-to-front, exactly as `drawWorkstation` sorts its own props — it used to be three
   * sequential calls, so the dock painted over the monitor by CALL ORDER at every facing no matter
   * where it stood. Geometry decides this now, which is the only way it can stay right when a prop
   * moves (nick, on /live: "the laptop stands look like they are floating in front of the monitors").
   */
  const kbAt = benchAt(slot, KEYBOARD_ALONG, 0); // same frame drawWorkstation uses: `at(KEYBOARD_ALONG, 0)`
  const props: { sum: number; fn: () => void }[] = [
    {
      sum: benchPropSort(slot, benchMonitorAt(slot)),
      fn: () => {
        const m = benchMonitorAt(slot);
        monitor(ctx, fit, m.lx, m.ly, slot.dir, atWork, DESK_UP, slot.id, t, screenLifeFor(node));
      },
    },
    {
      sum: benchPropSort(slot, benchDockAt(slot)),
      fn: () => {
        const d = benchDockAt(slot);
        deskDock(ctx, fit, d.lx, d.ly, slot.dir, DESK_UP, atWork);
      },
    },
    {
      sum: benchPropSort(slot, kbAt),
      fn: () => deskKeyboard(ctx, fit, kbAt.lx, kbAt.ly, true, DESK_UP, kbShoulder),
    },
  ];
  for (const prop of props.sort((a, b) => a.sum - b.sum)) prop.fn();
}

export interface SceneAnchors {
  heads: Map<string, Pt>;
  bases: Map<string, Pt>;
}

/** A soft additive warm pool: an ellipse of warm light that *adds* back over the night veil. */
function warmPool(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  r: number,
  flatten: number,
  color: string,
  peak: number,
): void {
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
  g.addColorStop(0, `rgba(${color}, ${peak})`);
  g.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r, r * flatten, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Interior lighting pass, painted after all furniture/actors: a cool night veil at `env.veilAlpha` (an
 * empty office after dark goes properly dark), then — gated on it being dark enough to want the lights on
 * (`env.lampsOn`) — the warm sources that punch back through the veil, all additive and all scaled by how
 * deep the night is (`night`), so the room stays cosy-dark but never pitch black:
 *
 *  - **The string lights emit** — each bulb (same anchors the canvas paints, see `magicAnchors`) casts a
 *    faint warm pool down the wall and onto the floor beneath it. Previously the bulbs glowed but lit nothing.
 *  - **A personal glow per present member** — a soft warm pool that travels with each online member, so
 *    the character work (faces, cheeks, the round body) never dissolves into the veil.
 *
 * Kept deliberately gentle: the office is meant to read *dim and cosy* after dark (the overhead fill the
 * lighting model already bakes into an occupied room is the only ceiling light — these just add warmth and
 * legibility, they don't try to light the room up). During the day `veilAlpha` is ~0 and `lampsOn` is
 * false, so everything below no-ops.
 */
function drawInteriorLight(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  poses: Map<string, Pose>,
  byName: Map<string, OfficeNode>,
  /** Desk-slot ids whose lamp is actually switched on — a real sitter's desk, after dark. Built at the
   * same place the workstation decides to draw the lit fixture, so the light and the object agree. */
  litLamps: ReadonlySet<number>,
  /** The subset of `litLamps` at a dreaming seat's desk. The lamp is turned down low, the way you'd
   *  leave one on for someone asleep. */
  dreamLamps: ReadonlySet<number> = new Set(),
  /** The paint-sequence hook (RenderOpts.units). The veil, the fixed lamps and each member's glow are
   *  separate units, so a member walking at night damages their own pool, not the whole veiled room.
   *  Each additive unit sets its own `lighter`, so the split paints what one pass painted. */
  run: (draw: () => void) => void = (draw) => draw(),
): void {
  if (env.veilAlpha > 0.01) {
    run(() => {
      ctx.save();
      ctx.globalAlpha = env.veilAlpha;
      ctx.fillStyle = env.veilColor;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); // whole canvas (overshoots under DPR — harmless)
      ctx.restore();
    });
  }
  if (!env.lampsOn) return;
  // How deep the night is, 0..1 — the warm sources scale by it, so they fade in as dusk falls rather than
  // snapping on at the lamp threshold.
  const night = Math.min(1, env.veilAlpha / 0.55);

  run(() => {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter'; // additive: each pool *adds* light back over the veil

    // The string lights emit: a warm pool cast down from each bulb onto the wall + floor beneath it. Tuned
    // to actually read against the veil (a first pass was too faint to see) while staying a warm accent.
    for (const b of magicAnchors(fit).bulbs) {
      warmPool(
        ctx,
        { x: b.x, y: b.y + 24 * fit.scale },
        52 * fit.scale,
        0.95,
        '255, 200, 120',
        0.2 * night,
      );
    }

    // Desk lamps emit, in two parts, and the order of them is the whole point. `litLamps` is the set of
    // desks with a real sitter (never a bench seat, which has no lamp fixture, and never an offline
    // owner's kept desk — nobody is there to have switched it on), which is exactly the set
    // `drawWorkstation` drew a lit shade for.
    for (const slot of DESK_SLOTS) {
      if (!litLamps.has(slot.id)) continue;
      const head = lampHeadPoint(slot, fit);
      const low = dreamLamps.has(slot.id) ? DREAM_LAMP : 1;
      // (a) The floor pool: light landing on the desk corner and the floor beside it, cast from under the
      // shade rather than from the shade itself, so it reads as spill and not as a second bulb.
      warmPool(
        ctx,
        { x: head.x, y: head.y + (DESK_UP + 20) * fit.scale },
        74 * fit.scale * low,
        0.6,
        '255, 194, 112',
        0.3 * night * low,
      );
      // (b) The bulb: a small, bright, unmistakably warm core right at the shade, painted additively over
      // the veil so the fixture reads as ON. Two stops — a tight near-white filament inside a warm halo —
      // because a single soft blob at this size reads as a smudge, and what has to survive the veil is the
      // sense that there is a *source* here. This is the half that was missing: the room had lamplight
      // with no visible lamps in it.
      // A dreaming lamp keeps its filament at full strength and loses its halo, so it still reads as ON.
      warmPool(ctx, head, 26 * fit.scale, 0.85, '255, 186, 96', 0.5 * night * low);
      warmPool(ctx, head, 10 * fit.scale, 0.8, '255, 238, 198', 0.72 * night);
    }
    ctx.restore();
  });

  // A personal glow travelling with each present (online) member. Still two layers — the glow stays, it
  // is how a member reads as *present* after dark (nick, 2026-09-03: "I don't want to get rid of the
  // member's glow at night, I just want to tone it down so it doesn't wash out the members").
  //
  // What washed them out was the second layer: a 52px core at 0.25 centred 30px UP the body, i.e. on the
  // face. It is painted additively over the finished character, so at full night it did not light the
  // member, it bleached them — the cheeks, the visor, the hue that says who this is, all flattened
  // toward white. Two changes, and only one of them is the opacity: the core drops 0.25 → 0.09, and it
  // drops DOWN the body (30 → 16) so its bright centre sits at the torso and the face catches only the
  // falloff. Light on someone is fine; a light source centred on their face is not.
  for (const [name, pose] of poses) {
    const node = byName.get(name);
    if (!node || node.presence !== 'online') continue;
    const b = project(pose.lx, pose.ly, fit);
    const scale = pose.small ? 0.7 : 1;
    run(() => {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // the halo: wide, flat, on the floor — it separates a body from the floor behind it.
      warmPool(
        ctx,
        { x: b.x, y: b.y - 8 * fit.scale * scale },
        88 * fit.scale * scale,
        0.6,
        '255, 206, 140',
        0.1 * night,
      );
      // the core: the member's own presence, at a tenth of the alpha it used to bleach them with.
      warmPool(
        ctx,
        { x: b.x, y: b.y - 16 * fit.scale * scale },
        50 * fit.scale * scale,
        0.8,
        '255, 214, 158',
        0.09 * night,
      );
      ctx.restore();
    });
  }
}

/**
 * How far from a desk's centre still counts as being *in* its chair. The chair sits `CHAIR_OFF` back
 * from the desk, and an occupant a little forward of that; beyond this radius a member is somewhere
 * else in the room, whatever their seating placement says.
 */
const AT_DESK_R = CHAIR_OFF + 28;

/**
 * Where a member's avatar sorts in the painter's order this frame — the floor point whose depth keys
 * them against the furniture.
 *
 * Three cases, in order:
 *
 * 1. **Sitting at their own desk** → the chair, not their feet. Their feet land a couple of units off
 *    the chair centre, and at north/west-facing desks that offset was enough to sort the cushion in
 *    *front* of them, so the chair painted over their legs. Keying off the chair puts them between its
 *    base and its backrest at every facing, which is where a person in a chair belongs. The chair's
 *    *current* spot, so a roll-back beat slides chair and sitter together.
 * 2. **Sitting on something that sorts as one big box** → that box's centre, via `depthAt`. The pose
 *    carries it for an errand's sit leg (actors.ts lifts it off the leg); a leisure *placement* carries
 *    it for a member whose home is that seat. The couch needs it either way — one long box sorted at
 *    its centre paints over a sitter on a cushion west of that centre.
 * 3. **Anything else** → their own feet.
 *
 * Case 1 is why this is a function rather than two lines inline. `sit > 0.5 && placement.kind ===
 * 'desk'` looks like "sitting at their desk" and is not: an errand sits a walker down on the lounge
 * couch while their placement is still their desk, so a member eating on the couch was sorted at a
 * desk on the far side of the room and the room painted over them — they simply vanished until they
 * stood up. The same test has a second face, because the sit blend eases *down* rather than switching:
 * for a moment after standing, a member walking away from the couch still read as seated and still
 * sorted at that distant desk, which is a body sliding through the lounge furniture.
 *
 * So "seated at my desk" has to mean actually being at that desk, which is what `atOwnDesk` measures.
 */
export function actorSortAnchor(
  pose: Pose,
  slot: { lx: number; ly: number; dir: Dir } | undefined,
  spot: { depthAt?: { lx: number; ly: number } } | undefined,
): { lx: number; ly: number; seatedAtDesk: boolean } {
  const atOwnDesk = !!slot && Math.hypot(pose.lx - slot.lx, pose.ly - slot.ly) < AT_DESK_R;
  if (pose.sit > 0.5 && atOwnDesk && slot) {
    const f = FWD[slot.dir];
    const shift = chairShift(pose.gesture, pose.gestureT);
    return {
      lx: slot.lx - f[0] * (CHAIR_OFF + shift),
      ly: slot.ly - f[1] * (CHAIR_OFF + shift),
      seatedAtDesk: true,
    };
  }
  const sitAt = pose.depthAt ?? spot?.depthAt;
  if (pose.sit > 0.5 && sitAt) return { lx: sitAt.lx, ly: sitAt.ly, seatedAtDesk: false };
  return { lx: pose.lx, ly: pose.ly, seatedAtDesk: false };
}

/**
 * Every depth item one desk station contributes: the slab, the room-side half again at the front
 * edge, and the chair in two pieces (plus a stepped-away owner's jacket). `renderScene` spreads these
 * into the floor's single sort, exactly as it does `nookItems` and `receptionItems`.
 *
 * It is a FUNCTION rather than inline pushes because /character-sheet needs the same station, and a
 * fixture that draws its own approximation of a desk is worse than no fixture: it drifts from the room
 * and then shows the wrong picture confidently. Three defects in two days came from one rule written
 * down in two places (#1397 slab key vs seated forearms, #1404 dock width vs DOCK_HALF_ACROSS, #1430
 * deskNeighbourPairs vs deskNeighbours). The sheet's paint order is the room's paint order here by
 * construction, not by someone having re-read this correctly.
 *
 * The body itself is NOT here — it sorts in the pose loop, at `actorDepth`, with its forearms coming
 * back a second time at `seatedArmsDepth`. Those two keys are exported beside this for the same reason.

 */
export function deskStationItems(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: DeskSlot,
  node: OfficeNode | null,
  opts: {
    /** The owner's pose, if they are at this desk — decides seated-ness and carries the chair beats. */
    ownerPose?: Pose | null | undefined;
    teamName: string;
    /** A kept, bodiless desk: an offline owner's, or a stepped-away member's (§4). */
    deskOwned?: boolean | undefined;
    t?: number | undefined;
    /** Props currently "in the owner's hand" (the sip mug, the errand's bottle) — skipped this frame. */
    hide?: Set<PropKind> | undefined;
    lampsOn?: boolean | undefined;
    /** Device pixel ratio, for the sprite keys. Default 1. */
    dpr?: number | undefined;
    /** The pre-rendered art (`RenderOpts.rendered`), threaded to the desk draws. */
    rendered: RenderedAssets;
  },
): { items: DepthItem[]; lampLit: boolean } {
  const out: DepthItem[] = [];
  const ownerPose = opts.ownerPose ?? undefined;
  const deskOwned = opts.deskOwned ?? false;
  const teamName = opts.teamName;
  const hide = opts.hide;
  const t = opts.t ?? 0;
  const env = { lampsOn: opts.lampsOn ?? false };
  /* The static-sprite key suffix, as `renderScene` spells it: where the pixel grid is, how dense it
     is, and what the theme resolved to. */
  const statKey = `${fitKey(fit)}·${opts.dpr ?? 1}·${paletteKey()}`;
  const litLamps = new Set<number>();
  // The desk comes to life only once its owner has actually walked over and sat down — screen,
  // dock and the room's typing all off this one fact (`workingAtDesk`). Same `sit > 0.9` the chair
  // pieces use two blocks below, so it lands on the frame the body settles into the chair, not the
  // frame the roster changed.
  const seatedWorking = workingAtDesk(node ?? undefined, ownerPose?.sit);
  /* Where this desk's own sitter sorts, or null for an empty desk — the one input `deskNearDepth`
     cannot get from geometry. Same `actorSortAnchor` the member's own item uses, so the desk and
     the body cannot disagree about where the body is. */
  const seatedHere = (() => {
    if (!ownerPose) return null;
    const a = actorSortAnchor(ownerPose, slot, undefined);
    return a.seatedAtDesk ? { lx: a.lx, ly: a.ly } : null;
  })();
  if (slot.kind === 'bench') {
    // No per-seat slab — the shared counter is already an item. +0.1 sorts the gear after the
    // counter's long box (same centre-sorted-box problem the couch solves with depthAt).
    out.push({
      d: depth(BENCH.lx, BENCH.ly) + 0.1,
      fn: () => benchStation(ctx, fit, slot, node, t, seatedWorking),
    });
  } else {
    if (node && !deskOwned && env.lampsOn) litLamps.add(slot.id);
    const wsKey = workstationKey({
      slot,
      node,
      teamName,
      owned: deskOwned,
      working: seatedWorking,
      lampLit: !!node && !deskOwned && env.lampsOn,
      hidden: hide,
      fit,
      dpr: opts.dpr ?? 1,
      warmAlpha: ownedDeskWarmAlpha(node, deskOwned),
    });
    const ws = (c: CanvasRenderingContext2D, phase: WorkstationPhase, nearOnly = false): void =>
      drawWorkstation(
        c,
        fit,
        slot,
        node,
        teamName,
        deskOwned,
        t,
        hide,
        env.lampsOn,
        seatedWorking,
        phase,
        opts.rendered,
        nearOnly,
      );
    // The near half's own props, again over its repaint (`nearHalfProps`) — the same pre / live
    // monitor / post split as the desk, since an S desk's monitor stands on this half.
    const nearProps = (c: CanvasRenderingContext2D, phase: WorkstationPhase): void =>
      nearHalfProps(c, fit, slot, () => ws(c, phase, true));
    out.push({
      /* CENTRE, not the near corner. #1394 moved this to `nearDepth` to stop a member standing in
         front of a desk painting behind it. That reasoning was incomplete: a desk facing N or W puts
         its CHAIR on the near side, so its own seated member legitimately keys HIGHER than the desk
         centre and paints in front of it. Pushing the slab 84 units forward beat them, and a sitter
         at such a desk lost their head and torso into it — not merely their legs, which is the only
         part a desk is supposed to take (nick, on the broadcast, 2026-09-14).

         A single scalar key per item cannot say both "in front of this desk's front edge" and
         "behind its back edge" — the passer-by and the sitter want opposite answers out of the same
         comparison. The fix is to split the desk into front and back items, the way the chair
         already splits into base and back, not to pick a different constant. Reverted here; the
         split is not a hotfix and was not attempted here.

       THE SPLIT LANDED (#1410, 129e45e8): it is the `deskNearHalf` item pushed directly below, which
       redraws the room-side half at the FRONT EDGE's key while never keying past this desk's own
       sitter. This desk key stays at the CENTRE and that is now the settled answer, not a pending
       revert — the paragraph above is kept because it is the reasoning, not because anything is owed. */
      d: depth(slot.lx, slot.ly),
      fn: () =>
        drawWorkstation(
          ctx,
          fit,
          slot,
          node,
          teamName,
          deskOwned,
          t,
          hide,
          env.lampsOn,
          seatedWorking,
          'all',
          opts.rendered,
        ),
      // Cached form: two sprites around a live screen (see `WorkstationPhase`). The sprite draws
      // take the OFFSCREEN context; the screen paints on the stage.
      parts: (() => {
        return [
          { kind: 'sprite', key: `${wsKey}·pre`, draw: (c) => ws(c, 'pre') },
          { kind: 'live', draw: () => ws(ctx, 'monitor') },
          { kind: 'sprite', key: `${wsKey}·post`, draw: (c) => ws(c, 'post') },
        ] satisfies SpritePart[];
      })(),
    });
    // The room-side half again, at the FRONT EDGE's depth — so a member standing in front of this
    // desk paints in front of it. Additive by construction: the same pixels in the same colours, so
    // on empty floor the second pass is invisible. It changes the picture only where a body has
    // landed between the two keys, and there it is the right answer. See `deskNearHalf` for why
    // the desk's own key cannot simply move (#1394, #1400).
    out.push({
      d: deskNearDepth(slot, seatedHere),
      fn: () => {
        deskNearHalf(ctx, fit, slot, opts.rendered);
        for (const phase of ['pre', 'monitor', 'post'] as const) nearProps(ctx, phase);
      },
      parts: [
        {
          kind: 'sprite',
          key: `near·${wsKey}`,
          draw: (c) => {
            deskNearHalf(c, fit, slot, opts.rendered);
            nearProps(c, 'pre');
          },
        },
        { kind: 'live', draw: () => nearProps(ctx, 'monitor') },
        { kind: 'sprite', key: `near·${wsKey}·post`, draw: (c) => nearProps(c, 'post') },
      ],
    });
  }
  // The task chair, in two depth items (see `chairBase`/`chairBack`): the cushion the member sits *on*
  // paints before them, the backrest at its own footprint — so at every facing the sitter lands between
  // the two instead of being swallowed by a single chair box.
  //
  // Chair beats move the chair with its sitter: roll-back slides both pieces straight back from the
  // desk; swivel swings the backrest around the seat centre — the same pure curves the actor system
  // applies to the body, so chair and member can never drift apart.
  const f = FWD[slot.dir];
  const seated = !!ownerPose && ownerPose.sit > 0.9;
  const shift = seated ? chairShift(ownerPose.gesture, ownerPose.gestureT) : 0;
  const yaw = seated ? chairYaw(ownerPose.gesture, ownerPose.gestureT) : 0;
  // A vacant chair at a desk that faces the viewer is parked BEHIND the slab in this projection —
  // fully hidden, so the desk reads as chairless (nick, 2026-08-31: the kimi desk). Roll it back
  // far enough to emerge past the desk's far edge, the way a real chair sits pushed out when its
  // owner is away. Facing is measured on screen, not guessed from the dir name.
  const fScreen =
    project(slot.lx + f[0] * 10, slot.ly + f[1] * 10, fit).y - project(slot.lx, slot.ly, fit).y;
  const vacantPeek = !seated && fScreen > 0 ? 16 : 0;
  const cx = slot.lx - f[0] * (CHAIR_OFF + shift + vacantPeek);
  const cy = slot.ly - f[1] * (CHAIR_OFF + shift + vacantPeek);
  const bdx = -f[0] * CHAIR_BACK_OFF;
  const bdy = -f[1] * CHAIR_BACK_OFF;
  const bx = cx + bdx * Math.cos(yaw) - bdy * Math.sin(yaw);
  const by = cy + bdx * Math.sin(yaw) + bdy * Math.cos(yaw);
  const chairColor = node ? hslL(node.color, 0.5) : '#4a5560';
  /* A chair at rest is furniture, so it is a sprite keyed on where it rests (seated or vacant) and its
     colour. Mid-beat (a roll-back, a swivel) it moves every frame, and a sprite per position would
     only churn the cache, so it paints live until the beat ends. */
  const resting = shift === 0 && yaw === 0;
  const chairKey = `chair·${slot.id}·${vacantPeek}·${chairColor}·${statKey}`;
  // The rendered chair (lane 01M5D8EJ40): the kind's sprite, tinted with the chair colour. The base
  // (a star) is the same from every side, so one image per seat axis; the back curves round the sitter
  // and reclines (office v3-4), so it has one image per facing.
  const axis = FWD[slot.dir][1] !== 0 ? 'sn' : 'ew';
  const chairArt = `chair/${chairVariantFor(slot.id)}`;
  const drawBase = (c: CanvasRenderingContext2D) => {
    // the shadow untinted under the tinted chair (a multiply would show the tint in its soft edge)
    if (opts.rendered.images.has(`${chairArt}/${axis}/base`))
      blitIf(c, fit, opts.rendered, 'chair/shadow', cx, cy);
    blitTinted(c, fit, opts.rendered, `${chairArt}/${axis}/base`, cx, cy, chairColor);
  };
  const drawBack = (c: CanvasRenderingContext2D) => {
    blitTinted(c, fit, opts.rendered, `${chairArt}/${slot.dir}/back`, bx, by, chairColor);
  };
  out.push({
    d: depth(cx, cy) - 0.2,
    fn: () => drawBase(ctx),
    ...(resting && {
      parts: [{ kind: 'sprite', key: `${chairKey}·base`, draw: drawBase }],
    }),
  });
  out.push({
    d: depth(bx, by),
    fn: () => drawBack(ctx),
    ...(resting && {
      parts: [{ kind: 'sprite', key: `${chairKey}·back`, draw: drawBack }],
    }),
  });
  // Stepped-away texture (§4 lane 4): a jacket in the owner's colour draped over the chair back —
  // the visual half of the plate's "stepped away"; offline owners get no jacket (they went home).
  if (deskOwned && node && node.presence !== 'offline') {
    const jx = bx;
    const jy = by;
    const jc = hslL(node.color, 0.42);
    out.push({
      d: depth(jx, jy) + 0.01,
      fn: () => {
        const b = project(jx, jy, fit);
        const wJ = 16 * fit.scale;
        const hJ = 13 * fit.scale;
        const top = b.y - 30 * fit.scale;
        ctx.fillStyle = jc;
        ctx.beginPath();
        ctx.moveTo(b.x - wJ / 2, top);
        ctx.lineTo(b.x + wJ / 2, top);
        ctx.lineTo(b.x + wJ / 2 - 2 * fit.scale, top + hJ);
        ctx.lineTo(b.x - wJ / 2 + 2 * fit.scale, top + hJ);
        ctx.closePath();
        ctx.fill();
      },
    });
  }
  return { items: out, lampLit: litLamps.has(slot.id) };
}

/**
 * Where this desk seats somebody: the chair, one `CHAIR_OFF` back from the desk centre along its
 * facing. Exported because WHERE A SITTER GOES AT A DESK is the room's knowledge, not its caller's —
 * /character-sheet deriving it from `CHAIR_OFF` and `FWD` itself would be a second spelling of the
 * chair's position, which is the drift `deskStationItems` exists to prevent, one value along.
 *
 * `actorSortAnchor` reads the same offset to decide a pose is "at their own desk", so a body placed
 * here is recognised as seated rather than as a walker who happens to be standing nearby.
 */
export function deskSeat(slot: { lx: number; ly: number; dir: Dir }): { lx: number; ly: number } {
  const f = FWD[slot.dir];
  return { lx: slot.lx - f[0] * CHAIR_OFF, ly: slot.ly - f[1] * CHAIR_OFF };
}

/**
 * Where a member's body sorts: their own floor anchor, a hair in front of it. The `+ 0.1` breaks the
 * tie with anything keyed at the identical point (a queue pad, a rug edge) in the body's favour.
 */
export function actorDepth(lx: number, ly: number): number {
  return depth(lx, ly) + 0.1;
}

/**
 * Where a seated member's FOREARMS come back, on top of the desk they rest on. Tracks the slab's own
 * key one constant away on purpose: when the slab moved and this did not, the desk painted over the
 * arms resting on it (#1397). Read by the room and by /character-sheet — never spelled out twice.
 */
export function seatedArmsDepth(slot: { lx: number; ly: number }): number {
  return depth(slot.lx, slot.ly) + 0.05;
}

/**
 * Rasterize `draw` once for `key` (its box measured once too, by the cache) and blit it at integer
 * device coordinates under the identity transform — a straight copy, no resampling. Shared by the
 * background layer and the depth-sorted loop.
 */
function blitSprite(
  ctx: CanvasRenderingContext2D,
  cache: SpriteCache,
  key: string,
  draw: (c: CanvasRenderingContext2D) => void,
  only?: string | undefined,
): void {
  if (only !== undefined && !key.includes(only)) {
    draw(ctx); // excluded from this pass — paint it live, exactly as an uncached scene would
    return;
  }
  const box = cache.box(key, draw);
  if (!box) return; // drew nothing — nothing to blit
  const sprite = cache.get(key, box, draw);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(sprite, box.x, box.y);
  ctx.restore();
}

/**
 * The sun pools on the planks (lane 01M5ZW21JH): each window throws a pool of daylight across the
 * floor, long and leaning when the sun is low, short and straight at noon, the lean flipping sides
 * across the day (`lighting.ts` `sunBeam`, shared with the dust motes and the dog's nap spots).
 * Painted additively into the cached shell — the Blender shell is rendered WITHOUT its window spots
 * (`scene.py` `lights(window_spots=False)`), because a pool baked at one sun angle under a painted
 * one read as two suns. Additive paint cannot be its own sprite (canvas-sprite-caching.md), so this
 * runs inside the shell's draw and the shell's key carries the quarter hour (`backgroundKey`).
 */
export function drawSunPools(ctx: CanvasRenderingContext2D, fit: Fit, env: LightEnv): void {
  if (env.skyStrength < 0.02) return;
  const { len, shear } = sunBeam(env.hours);
  // Sunlight on wood is warm even under a pale noon sky: the pool is the sky tint pulled most of the
  // way toward sun-yellow, and strong enough to read on a bright floor (0.5×sky was invisible on the
  // rendered planks — the painted floor it was tuned for was darker; measured 2026-10-27).
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(env.skyTint);
  const sky = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 210, 150];
  const sun = [255, 236, 190];
  const [r, g, b] = sky.map((c, i) => Math.round(c * 0.35 + sun[i]! * 0.65));
  const peak = 0.85 * env.skyStrength;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pool = (
    base: (t: number) => [number, number],
    into: (l: [number, number], d: number) => [number, number],
  ): void => {
    for (const w of WINDOWS) {
      const a = base(w.t0);
      const bb = base(w.t1);
      const pa = project(a[0], a[1], fit);
      const pb = project(bb[0], bb[1], fit);
      const f0 = into(a, len);
      const f1 = into(bb, len);
      const pf0 = project(f0[0], f0[1], fit);
      const pf1 = project(f1[0], f1[1], fit);
      // bright at the sill, gone at the far end; a window nearer the sun is brighter (`bright`)
      const grad = ctx.createLinearGradient(
        (pa.x + pb.x) / 2,
        (pa.y + pb.y) / 2,
        (pf0.x + pf1.x) / 2,
        (pf0.y + pf1.y) / 2,
      );
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(peak * w.bright).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pf1.x, pf1.y);
      ctx.lineTo(pf0.x, pf0.y);
      ctx.closePath();
      ctx.fill();
    }
  };
  // back-left wall (lx = 0): the pool throws into +lx, sheared along +ly
  pool((t) => [0, t * FLOOR], (l, d) => [d, l[1] + (d / len) * shear]);
  // back-right wall (ly = 0): the pool throws into +ly, sheared along +lx
  pool((t) => [t * FLOOR, 0], (l, d) => [l[0] + (d / len) * shear, d]);
  ctx.restore();
}

/** The quarter hour the sun pools are baked at — 0 while there is no sun to pool. */
function sunBucket(env: LightEnv): number {
  return env.skyStrength < 0.02 ? 0 : Math.floor(env.hours * 4);
}

/**
 * The room shell's sprite key. It carries what the shell actually READS off the lighting envelope —
 * the room's light state and its fade (`roomMixFor`), and the daylight the ceiling overlay fades with —
 * and not `veilAlpha` or `lampsOn`, which only `drawInteriorLight` reads and which is never cached.
 * The quarter hour rides in it for the sun pools (`drawSunPools`, lane 01M5ZW21JH); the clock face
 * itself is a live fixture. The state follows the clock quantised, so a 45-minute fade re-bakes in
 * 32 steps and the sun in 15-minute steps, not every frame (plan Task 8).
 */
export function backgroundKey(fit: Fit, env: LightEnv, dpr: number): string {
  const m = roomMixFor(env);
  return [
    'bg',
    `${m.from}→${m.to}@${Math.round(m.mix * 32)}`,
    env.daylight.toFixed(3),
    `sun${sunBucket(env)}`,
    fitKey(fit),
    dpr,
    paletteKey(),
  ].join('·');
}

/**
 * Draw the whole office in painter's order, returning per-member screen anchors. Desks are drawn empty;
 * each present member is drawn as a free actor at its current `poses` entry (home seat when idle, or
 * interpolated mid-walk), so seated and walking members depth-sort against desks the same way.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  placements: Map<string, Placement>,
  byName: Map<string, OfficeNode>,
  poses: Map<string, Pose>,
  /** The scene clock, in seconds — everything that animates on its own (breathing, typing) reads it. */
  t = 0,
  teamName = 'revive',
  env: LightEnv = DAY_ENV,
  pet: PetState | null = null,
  /** Errand scene effects, derived per-frame by the actor system (`actors.sceneFx()`): an open fridge
   * door, desks whose water bottle is currently in its owner's hand. Absent → everything at rest. */
  fx: { fridgeOpen: boolean; bottleCarriers: Set<string> } | undefined,
  /** The receptionist's state (receptionist.ts). Absent → asleep, which is the empty-office truth. */
  recep: ReceptionistState | null = null,
  /** The real lane board squinted down for the wall (wallboard.ts). Null → the empty board hangs. */
  wallBoard: WallBoard | null = null,
  /** Optional Team schedule for the wall sign. */
  teamWorkingHours: WorkingHours | null = null,
  opts: RenderOpts,
): SceneAnchors {
  const cache = opts.sprites;
  const dpr = opts.dpr ?? 1;
  /* Every unit of the paint sequence goes through here (RenderOpts.units). */
  const run = opts.units
    ? (draw: () => void) => opts.units!.run(draw)
    : (draw: () => void) => draw();

  // Desk-slot index → seat owner (for the monitor's working glow). Placement stores an index into
  // `DESK_SLOTS`; IDs are deliberately stable but sparse after pod sizes change, so they are not
  // interchangeable.
  const slotMember = new Map<number, string>();
  for (const [name, pl] of placements) if (pl.kind === 'desk') slotMember.set(pl.slot, name);

  const heads = new Map<string, Pt>();
  const bases = new Map<string, Pt>();

  const items: DepthItem[] = [];
  /* Every static item's key ends with the same three facts: where the pixel grid is, how dense it
     is, and what the theme resolved to. A resize or a theme flip is one cold frame, then cached. */
  const rendered = opts.rendered;
  monitorArt = rendered;
  const statKey = `${fitKey(fit)}·${opts.dpr ?? 1}·${paletteKey()}`;
  /* A static item blits its asset (plan Task 6) through the depth item and sprite key its painter had,
     so nothing about order or caching changed when the painters went (lane 01M5D8EJ40). */
  const ro = (id: string, lx: number, ly: number) => blitDraw(fit, rendered, id, lx, ly);

  PLANTS.forEach((plant, pi) => {
    const draw = ro(`plant/${plant.species}`, plant.lx, plant.ly);
    items.push({
      d: depth(plant.lx, plant.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `plant·${pi}·${plant.species}·${statKey}`, draw }],
    });
  });
  BOOKSHELVES.forEach((s, si) => {
    // The index is the book seed — it is what makes shelf 0 and shelf 2 hold different books
    // despite being the same size.
    const draw = ro(`shelf/${si}`, s.lx, s.ly);
    items.push({
      d: depth(s.lx, s.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `shelf·${si}·${statKey}`, draw }],
    });
  });
  {
    // The wall board's wastebasket (ADR 751): one crumpled ball per lane abandoned today, up to six,
    // piled in its mouth — the count is in the sprite key, so the cached bin changes only when it does.
    const balls = Math.min(BIN_BALLS, wallBoard?.binned?.length ?? 0);
    const bin = ro('bin', BIN.lx, BIN.ly);
    const draw = (c: CanvasRenderingContext2D) => {
      bin(c);
      paperBalls(c, fit, balls);
    };
    items.push({
      d: depth(BIN.lx, BIN.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `bin·${balls}·${statKey}`, draw }],
    });
  }
  const nook = nookItems(ctx, fit, fx?.fridgeOpen ?? false, statKey, rendered);
  items.push(...nook.items);

  /* THE ROOM SHELL, before the depth-sorted loop: the ground shadow the diorama sits on, then the floor
     and the two back walls as one image per day state (`room/light-<day|evening|night>`, plan Tasks 6
     and 8), crossfaded by `roomMixFor` — `from` at alpha 1, `to` at `mix` — with the ceiling bank as an
     additive overlay (`room/ceiling-<on|spill>`), and the flat rugs (drawn with the floor so a member
     standing on one is never over-painted by it). Static per lighting step — so with a cache it is two
     sprites around the live wall fixtures, and with none it paints in the same order. The window beams
     and the walls' dressing are in the renders. */
  const mix = roomMixFor(env);
  /* The figure (plan Task 13): every member is a sprite frame under the room's light tint. No sheets
     (figure.json missing or its skin sheet failed) draws nobody — the loader said so once. */
  const figure = rendered.figure
    ? { assets: rendered.figure, tint: figureTintFor(env) }
    : undefined;
  const shell = (c: CanvasRenderingContext2D): void => {
    drawGroundShadow(c, fit);
    blitIf(c, fit, rendered, `room/light-${dayOf(mix.from)}`, 0, 0);
    if (mix.mix > 0) blitIf(c, fit, rendered, `room/light-${dayOf(mix.to)}`, 0, 0, mix.mix);
    drawSunPools(c, fit, env); // the window pools, at this quarter hour's sun (lane 01M5ZW21JH)
    const ceiling = ceilingOf(mix.from);
    if (ceiling !== 'off') {
      // The overlay was measured at night (night-on minus night-off). By day the same light adds
      // far less to an already-lit room, so it fades with the daylight — continuous, like the veil.
      c.save();
      c.globalCompositeOperation = 'lighter';
      blitIf(c, fit, rendered, `room/ceiling-${ceiling}`, 0, 0, 1 - 0.8 * env.daylight);
      c.restore();
    }
    if (!cache) drawWalls(c, fit, env, teamWorkingHours, wallBoard, t, undefined, rendered, opts.weather, opts.chimes);
    if (!cache) rugs(c);
  };
  /* Flat floor paint, drawn with the floor (before every solid and every actor) so a member standing
     anywhere on a rug is never over-painted by it. Solid pieces self-sort at their footprints. */
  function rugs(c: CanvasRenderingContext2D): void {
    for (const pod of PODS) ro(`rug/pod-${pod.id}`, pod.cx, pod.cy)(c);
    ro('rug/meeting', MEETING.lx, MEETING.ly)(c);
    ro('rug/reception', RECEPTION.rug.lx, RECEPTION.rug.ly)(c);
    // No nook rug (office v3-2): the café's tile, painted in the shell, is the zone.
  }
  if (cache) {
    const bg = backgroundKey(fit, env, dpr);
    run(() => blitSprite(ctx, cache, bg, shell, opts.spriteOnly));
    // On the stage, in their existing order: the live fixtures over the blitted walls, then the
    // additive bulb strands (see `drawWalls`).
    drawWalls(ctx, fit, env, teamWorkingHours, wallBoard, t, run, rendered, opts.weather, opts.chimes);
    // Source-over floor paint, so it caches cleanly on top of the shell.
    run(() => blitSprite(ctx, cache, `${bg}·rugs`, rugs, opts.spriteOnly));
  } else {
    run(() => shell(ctx));
  }
  {
    const draw = ro('meeting/table', MEETING.lx, MEETING.ly);
    items.push({
      d: depth(MEETING.lx, MEETING.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `meeting·table·${statKey}`, draw }],
    });
  }
  MEETING.chairs.forEach((c, ci) => {
    const cx = MEETING.lx + c.dx;
    const cy = MEETING.ly + c.dy;
    const draw = ro(`meeting/chair-${ci}`, cx, cy);
    items.push({
      d: depth(cx, cy),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `meeting·chair·${ci}·${statKey}`, draw }],
    });
  });
  items.push(...receptionItems(ctx, fit, recep, t, statKey, rendered, figure));
  {
    const draw = ro('printer', PRINTER.lx, PRINTER.ly);
    items.push({
      d: depth(PRINTER.lx, PRINTER.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `printer·${statKey}`, draw }],
    });
  }
  {
    const draw = ro('entrance', ENTRANCE.lx, ENTRANCE.ly);
    items.push({
      d: depth(ENTRANCE.lx, ENTRANCE.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `entrance·${statKey}`, draw }],
    });
  }

  // The office dog sorts with everything else at its own floor position (behaviour lives in pet.ts).
  if (pet)
    items.push({ d: depth(pet.lx, pet.ly) + 0.08, fn: () => drawDog(ctx, fit, pet, t, rendered) });
  // The visiting dog sorts the same way, from its own sheet (lane 01M5XS6DP2).
  const visitor = opts.visitor;
  const visitorSheet = rendered.visitorDog;
  if (visitor && visitorSheet)
    items.push({
      d: depth(visitor.lx, visitor.ly) + 0.08,
      fn: () => drawRenderedDog(ctx, fit, visitor, t, visitorSheet),
    });
  // The welcome wagon (lane 01M3F81DD9) trails the dog on the floor and sorts at its own position.
  if (pet?.cargo === 'wagon') {
    const w = wagonTrail(pet);
    items.push({
      d: depth(w.lx, w.ly) + 0.08,
      fn: () => blitIf(ctx, fit, rendered, 'welcome/wagon', w.lx, w.ly),
    });
  }
  // The label maker's strips, curling up off the front desk's arrivals end.
  for (const label of opts.welcome?.labels ?? []) {
    const age = t - label.t0;
    if (age < 0 || age >= LABEL_S) continue;
    items.push({
      d: depth(FRONT_DESK.lx + 30, FRONT_DESK.ly + 10) + 0.05,
      fn: () => drawLabelStrip(ctx, fit, label.color, age),
    });
  }

  // The bench's shared counter, once — its seats' gear rides per-slot below.
  // 300 long: the widest footprint on the floor, so the centre-vs-edge error is largest here.
  {
    const draw = ro('bench/base', BENCH.lx, BENCH.ly);
    items.push({
      d: depth(BENCH.lx, BENCH.ly),
      fn: () => draw(ctx),
      parts: [{ kind: 'sprite', key: `bench·${statKey}`, draw }],
    });
  }

  // Desks whose lamp is switched on: a real sitter's desk, after dark. Filled from the same three facts
  // `drawWorkstation` uses to draw the lit shade (a node, not a bench seat, not an offline owner's kept
  // desk) so the emissive pass in `drawInteriorLight` can never light a lamp the room did not draw.
  const litLamps = new Set<number>();
  const dreamLamps = new Set<number>();

  for (const [slotIndex, slot] of DESK_SLOTS.entries()) {
    const name = slotMember.get(slotIndex) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    const deskPl = name ? placements.get(name) : undefined;
    const deskOwned = deskPl?.kind === 'desk' && deskPl.owned === true;
    const ownerPose = name ? poses.get(name) : undefined;
    // Sip beat: while the owner's mug is in their hand, the desk copy vanishes — one mug, not two.
    const sipping =
      !!ownerPose &&
      ownerPose.sit > 0.9 &&
      ownerPose.gesture === GESTURE.sip &&
      ownerPose.gestureT > 0.12 &&
      ownerPose.gestureT < 0.95;
    // A prop leaves the desk while it's "in the owner's hand": the sip mug, or the errand's bottle.
    const hidden: PropKind[] = [];
    if (sipping) hidden.push('coffee');
    if (name && fx?.bottleCarriers.has(name)) hidden.push('water');
    const hide = hidden.length ? new Set<PropKind>(hidden) : undefined;
    const station = deskStationItems(ctx, fit, slot, node, {
      ownerPose,
      teamName,
      deskOwned,
      t,
      hide,
      lampsOn: env.lampsOn && deskLampOn(env, slot.id),
      dpr: opts.dpr,
      rendered: opts.rendered,
    });
    if (station.lampLit) litLamps.add(slot.id);
    if (station.lampLit && node?.dreaming) dreamLamps.add(slot.id);
    items.push(...station.items);
  }

  // Queue lane: a faint pad under each overflow (strip) member so the entrance line reads as a designated
  // waiting area. Positions come from the live poses, so drawing never re-derives the seating maths.
  for (const [name, pl] of placements) {
    if (pl.kind !== 'strip') continue;
    const pose = poses.get(name);
    if (!pose) continue;
    items.push({
      d: depth(pose.lx, pose.ly) - 0.2,
      fn: () => drawQueuePad(ctx, fit, pose.lx, pose.ly),
    });
  }

  for (const [name, pose] of poses) {
    const node = byName.get(name);
    if (!node) continue;
    const b = project(pose.lx, pose.ly, fit);
    const pl = placements.get(name);
    const slot = pl?.kind === 'desk' ? DESK_SLOTS[pl.slot] : undefined;
    const spot = pl?.kind === 'leisure' ? LEISURE_SPOTS[pl.spot] : undefined;
    const anchor = actorSortAnchor(pose, slot, spot);
    const seated = anchor.seatedAtDesk && slot;
    const d = actorDepth(anchor.lx, anchor.ly);
    // The desk mug travels with a sipping owner — passed down so the hand mug matches the desk mug.
    const mug = seated && pose.gesture === GESTURE.sip ? deskMugColor(slot.id) : undefined;
    // A lanyard still in the air is not on them yet — it lands at the end of its flight.
    const inFlight =
      opts.welcome?.tosses.some((x) => x.name === name && t - x.t0 < TOSS_S) ?? false;
    const lanyard = inFlight ? undefined : opts.welcome?.lanyards.get(name);
    if (figure)
      items.push({ d, fn: () => drawActor(ctx, fit, pose, node, t, false, mug, lanyard, figure) });

    // Seated overlay: the desk paints over a member sitting behind it (correct — that is what a desk does
    // to your legs), but their forearms *rest on the surface*, above it, so they must paint on top of the
    // slab. One character, two depth slots: the body at the chair, the arms on the desk. Without this the
    // hands disappear into the desk and the typing is invisible. Skipped while a beat has dropped the
    // hands into the lap — lap arms painted over the slab would float on the desk. The rendered figure
    // does the same with the arm cells its seated clips store (plan Task 16).
    if (figure && seated && !handsInLap(pose.gesture, pose.gestureT)) {
      items.push({
        d: seatedArmsDepth(slot),
        fn: () => drawActor(ctx, fit, pose, node, t, true, mug, undefined, figure),
      });
    }

    bases.set(name, b);
    // The label rides above the crown — higher for a standing member than a seated one, so it tracks the
    // head through a sit rather than floating where the head used to be. Lifted clear of the firefly wisp
    // that now hovers over the head (see `drawHead`), so the name reads as a plate floating above the mote.
    // The label rides 20 above the crown the sheet's spec gives (96 was the painted member's) —
    // otherwise a smaller figure's name floats in the air above it.
    const crown = figure?.assets.spec.height ?? 96;
    heads.set(name, {
      x: b.x,
      y:
        b.y -
        (pose.small ? (crown + 20) * 0.78 : crown + 20 - pose.sit * 22 * (crown / 96)) * fit.scale,
    });
  }

  items.sort((a, b) => a.d - b.d);
  for (const it of items) {
    if (!cache || !it.parts) {
      run(it.fn);
      continue;
    }
    // One unit per part: a working desk's monitor animates, and its sprite halves around it should
    // not be damage because it does.
    for (const part of it.parts) {
      if (part.kind === 'live') run(part.draw);
      else run(() => blitSprite(ctx, cache, part.key, part.draw, opts.spriteOnly));
    }
  }

  // Lanyards in the air (lane 01M3F81DD9): over everything on the floor, under the night veil.
  const tosses = opts.welcome?.tosses;
  if (tosses?.length) run(() => drawTosses(ctx, fit, tosses, heads, t));

  // Interior lighting: veil the room to the night level, then let occupied desks' lamps glow through.
  drawInteriorLight(ctx, fit, env, poses, byName, litLamps, dreamLamps, run);

  // The Welcome Wagon's light-emitting bits (lane 01M3F81DD9) go over the night veil, like the lamps:
  // a monitor saying hello and an agent's status light are sources, not surfaces.
  const welcome = opts.welcome;
  if (welcome) run(() => drawWelcomeGlows(ctx, fit, welcome, placements, heads, t));

  // Dream bubbles also go over the veil. A dream happens at night, and a bubble lost in the dark
  // would leave the dreamer looking like any other late worker.
  for (const [name, at] of heads) {
    if (byName.get(name)?.dreaming) run(() => drawDreamBubble(ctx, fit, at, t));
  }

  // Collapse any queue/nook members past the render cap into a single "+N" pill, so a very large roster
  // stays bounded. Hidden count = placed-but-not-drawn (capped members get no pose in homePoses).
  let stripTotal = 0;
  let nookTotal = 0;
  let stripDrawn = 0;
  let nookDrawn = 0;
  for (const [name, pl] of placements) {
    if (pl.kind === 'strip') {
      stripTotal++;
      if (poses.has(name)) stripDrawn++;
    } else if (pl.kind === 'nook') {
      nookTotal++;
      if (poses.has(name)) nookDrawn++;
    }
  }
  if (stripTotal - stripDrawn > 0) {
    const a = project(ENTRANCE.lx + 34, ENTRANCE.ly - 10, fit);
    run(() =>
      drawCountPill(
        ctx,
        { x: a.x, y: a.y - 66 * fit.scale },
        `+${stripTotal - stripDrawn} waiting`,
        fit.scale,
      ),
    );
  }
  if (nookTotal - nookDrawn > 0) {
    const a = project(NOOK.lx, NOOK.ly, fit);
    run(() =>
      drawCountPill(
        ctx,
        { x: a.x, y: a.y - 52 * fit.scale },
        `+${nookTotal - nookDrawn} away`,
        fit.scale,
      ),
    );
  }

  // Frame the whole diorama last — a soft edge vignette so the scene fades into the panel at the corners.
  run(() => drawVignette(ctx));

  return { heads, bases };
}

// ── the Welcome Wagon (lane 01M3F81DD9) ────────────────────────────────────────────────────────────
// Everything a new Member's arrival adds to the room. Built from the same primitives as the furniture
// (`box`, `project`, `roundRect`) so it depth-sorts and scales like the rest of the office; the timing
// is welcomeRoom.ts's, the painting is here.

/** The wagon's red — a toy-wagon red, warm enough to belong in an amber room. */
export const WAGON_RED = '#c8412f';
/** The nameplate card stock. */
export const POLAROID_WHITE = '#f7f3ea';
/** An agent's status light blinking as it boots up. */
export const BOOT_LED = '#9ff5b0';
const MUSTARD = '#E1AD01';
/** How long a label strip curls off the counter, scene seconds (welcomeRoom prunes on the same number). */
const LABEL_S = 2.0;
const HELLO_S = 1.0;
const BLINK_S = 1.2;
/** How far behind the dog the wagon rolls, floor units — handle length plus half a wagon. */
const WAGON_LAG = 24;

/** A name on a nameplate: ten characters, then an ellipsis — a card has no room for more. */
export function plateText(name: string): string {
  return name.length <= 10 ? name : `${name.slice(0, 9)}…`;
}

/**
 * Where the wagon is, trailing the dog: back along the way it came (from the waypoint it is leaving
 * toward where it stands), so it follows the dog around corners instead of swinging out wide.
 */
export function wagonTrail(pet: PetState): { lx: number; ly: number } {
  const from = pet.path[pet.seg] ?? { lx: pet.lx - (pet.flip ? -1 : 1), ly: pet.ly };
  let dx = pet.lx - from.lx;
  let dy = pet.ly - from.ly;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = pet.flip ? -1 : 1; // standing: behind is opposite to where it faces
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  return { lx: pet.lx - dx * WAGON_LAG, ly: pet.ly - dy * WAGON_LAG };
}

/** The rendered dog's last direction, per pet — the figure's hysteresis needs the one before. */
const dogDirs = new WeakMap<PetState, Dir8>();

/**
 * The rendered dog (lane 01M5D8EJ40): one cell of `office-art-dog.webp` at the pet's floor point, in
 * the direction of its last leg. Its shadow is in the render. Untinted, like the furniture: the night
 * veil paints over it as it does over everything rendered under the day rig.
 */
function drawRenderedDog(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  pet: PetState,
  t: number,
  dog: NonNullable<RenderedAssets['dog']>,
): void {
  const dir = dogDir(pet.heading ?? 0, dogDirs.get(pet));
  dogDirs.set(pet, dir);
  const { anim, frame } = dogFrame(dog.spec, pet, t);
  const c = dogCell(dog.spec, anim, dir, frame);
  if (c.sw <= 0 || c.sh <= 0) return;
  const k = fit.scale / dog.spec.scale;
  const p = project(pet.lx, pet.ly, fit);
  const dx = p.x - (dog.spec.anchor.x - c.ox) * k;
  const dy = p.y - (dog.spec.anchor.y - c.oy) * k;
  if (c.flip) {
    ctx.save();
    ctx.translate(dx + c.sw * k, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(dog.sheet, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw * k, c.sh * k);
    ctx.restore();
  } else {
    ctx.drawImage(dog.sheet, c.sx, c.sy, c.sw, c.sh, dx, dy, c.sw * k, c.sh * k);
  }
}

/** A label strip in the newcomer's colour, printed out of the counter's label maker and curling up. */
function drawLabelStrip(ctx: CanvasRenderingContext2D, fit: Fit, color: string, age: number): void {
  const rise = Math.min(1, age / 0.6);
  const fade = age > LABEL_S - 0.5 ? (LABEL_S - age) / 0.5 : 1;
  ctx.globalAlpha = Math.max(0, fade);
  box(
    ctx,
    fit,
    FRONT_DESK.lx + 30,
    FRONT_DESK.ly + 10,
    14,
    2,
    3,
    color,
    FRONT_DESK.high + 2 + rise * 6,
  );
  ctx.globalAlpha = 1;
}

/**
 * A lanyard in the air: a card on a trailing cord, arcing from the receptionist's hands to the
 * newcomer's chest over the flight, spinning a little as it goes.
 */
function drawTosses(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  tosses: WelcomePaint['tosses'],
  heads: Map<string, Pt>,
  t: number,
): void {
  const s = fit.scale;
  const from = project(RECEPTIONIST.lx, RECEPTIONIST.ly, fit);
  const start = { x: from.x, y: from.y - 70 * s };
  for (const toss of tosses) {
    const k = (t - toss.t0) / TOSS_S;
    if (k < 0 || k >= 1) continue;
    const head = heads.get(toss.name);
    // `heads` is the plate anchor above the crown; the chest is ~52 units below it.
    const end = head
      ? { x: head.x, y: head.y + 52 * s }
      : { x: start.x + 60 * s, y: start.y + 20 * s };
    const e = 1 - (1 - k) * (1 - k); // eases out as it lands
    const x = start.x + (end.x - start.x) * e;
    const y = start.y + (end.y - start.y) * e - Math.sin(k * Math.PI) * 38 * s; // the arc
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(k * Math.PI * 1.5);
    ctx.strokeStyle = toss.color;
    ctx.lineWidth = Math.max(1, 1.4 * s);
    ctx.beginPath();
    ctx.ellipse(0, -5 * s, 4 * s, 5 * s, 0, 0, Math.PI * 2); // the cord, a loop in the air
    ctx.stroke();
    ctx.fillStyle = POLAROID_WHITE;
    ctx.fillRect(-2.6 * s, 0, 5.2 * s, 6.4 * s);
    ctx.fillStyle = toss.color;
    ctx.fillRect(-2.6 * s, 0, 5.2 * s, 1.8 * s);
    ctx.restore();
  }
}

/**
 * The Welcome Wagon's light sources, drawn over the night veil: a newcomer's monitor saying hello for
 * a second as they sit down, and an agent's status light blinking twice as it boots up.
 */
function drawWelcomeGlows(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  w: WelcomePaint,
  placements: Map<string, Placement>,
  heads: Map<string, Pt>,
  t: number,
): void {
  const s = fit.scale;
  for (const [name, t0] of w.hello) {
    const age = t - t0;
    const pl = placements.get(name);
    if (age < 0 || age >= HELLO_S || pl?.kind !== 'desk') continue;
    const slot = DESK_SLOTS[pl.slot];
    if (!slot) continue;
    const [mx, my] = deskPoint(slot, MONITOR_ALONG, 0);
    const m = project(mx, my, fit);
    ctx.globalAlpha = Math.sin((age / HELLO_S) * Math.PI); // lights up and fades, one breath
    roundRect(ctx, m.x - 17 * s, m.y - (DESK_UP + 34) * s, 34 * s, 16 * s, 3 * s, POLAROID_WHITE);
    ctx.fillStyle = '#26221e';
    ctx.font = canvasFont(Math.round(9 * s * 1.5), '--font-sans', 700);
    ctx.textAlign = 'center';
    ctx.fillText('hello', m.x, m.y - (DESK_UP + 23) * s);
    ctx.globalAlpha = 1;
  }
  for (const [name, t0] of w.bootBlink) {
    const age = t - t0;
    const at = heads.get(name);
    if (age < 0 || age >= BLINK_S || !at) continue;
    // Two blinks: on for 0.15 s, off for 0.15 s, twice — then the ordinary firefly takes over.
    if (Math.floor(age / 0.15) % 2 !== 0 || age >= 0.6) continue;
    ellipse(ctx, { x: at.x, y: at.y + 14 * s }, 2.6 * s, 2.6 * s, BOOT_LED);
  }
}

/** A dreaming seat's lamp, as a share of a working lamp's spill (goal dreaming, lane 5). */
export const DREAM_LAMP = 0.35;
/** One slow breath of the dream bubble, in scene seconds. */
const DREAM_BREATH_S = 3.2;
const DREAM_CLOUD = '244, 239, 255';
const DREAM_MOON = '#e8c35a';

/**
 * The bubble's motion at scene time `t`, kept apart from the drawing so it can be tested. `bob` is
 * a gentle float in scene units. `dots` are the three trail dots' alphas, which brighten one after
 * another from the head up to the cloud, the way a thought rises.
 */
export function dreamBubble(t: number): { bob: number; dots: [number, number, number] } {
  const phase = (((t / DREAM_BREATH_S) % 1) + 1) % 1;
  const dot = (i: number): number => {
    const d = (((phase - i / 3) % 1) + 1) % 1;
    return 0.35 + 0.55 * Math.max(0, Math.cos(d * Math.PI * 2));
  };
  return { bob: Math.sin(phase * Math.PI * 2) * 1.6, dots: [dot(0), dot(1), dot(2)] };
}

/** The cloud's size against the puffs it is drawn from: big enough to read at 720p (~30 css px). */
const DREAM_CLOUD_K = 1.5;
/** Trail dots from the shoulder up toward the cloud: [dx, dy, r] in scene units off the plate anchor. */
const DREAM_TRAIL: ReadonlyArray<readonly [number, number, number]> = [
  [16, 50, 1.8],
  [21, 45, 2.4],
  [25, 39, 3],
];
/** Cloud centre off the plate anchor: right of the face, and low enough that its top clears it. */
const DREAM_CLOUD_AT = { dx: 42, dy: 20 } as const;

/**
 * Where the dream bubble goes for a head anchor `at`, at scale `s` and float `bob`. Kept pure so a
 * test can hold it to the two things the stage capture showed it must do: stay BELOW `at.y`, where
 * the DOM nameplate hangs (a cloud straddling that line was drawn under the plate), and stay off the
 * face (`headBox`).
 */
export function dreamBubbleLayout(
  at: Pt,
  s: number,
  bob: number,
): {
  trail: Array<{ x: number; y: number; r: number }>;
  cloud: { cx: number; cy: number; k: number; halfW: number };
  box: { x0: number; y0: number; x1: number; y1: number };
} {
  const k = DREAM_CLOUD_K * s;
  const trail = DREAM_TRAIL.map(([dx, dy, r]) => ({
    x: at.x + dx * s,
    y: at.y + (dy + bob * 0.5) * s,
    r: r * s,
  }));
  const cx = at.x + DREAM_CLOUD_AT.dx * s;
  const cy = at.y + (DREAM_CLOUD_AT.dy + bob) * s;
  // The puffs below span x ±15 and y −11…+9 in cloud units.
  const halfW = 15 * k;
  const box = {
    x0: Math.min(cx - halfW, ...trail.map((d) => d.x - d.r)),
    y0: Math.min(cy - 11 * k, ...trail.map((d) => d.y - d.r)),
    x1: cx + halfW,
    y1: Math.max(cy + 9 * k, ...trail.map((d) => d.y + d.r)),
  };
  return { trail, cloud: { cx, cy, k, halfW }, box };
}

/**
 * A thought bubble beside a dreaming seat: three trail dots rising from the shoulder to a small cloud
 * holding a crescent moon. It reads as asleep and thinking, not stuck. No words in it, because the
 * nameplate already says who this is and the digest says what they dreamed.
 */
function drawDreamBubble(ctx: CanvasRenderingContext2D, fit: Fit, at: Pt, t: number): void {
  const { bob, dots } = dreamBubble(t);
  const { trail, cloud } = dreamBubbleLayout(at, fit.scale, bob);
  trail.forEach((d, i) => {
    ellipse(ctx, { x: d.x, y: d.y }, d.r, d.r, `rgba(${DREAM_CLOUD}, ${dots[i]})`);
  });
  // The cloud: four overlapping puffs, so it looks drawn rather than generated.
  const { cx, cy, k } = cloud;
  const fill = `rgba(${DREAM_CLOUD}, 0.94)`;
  ellipse(ctx, { x: cx, y: cy }, 13 * k, 9 * k, fill);
  ellipse(ctx, { x: cx - 8 * k, y: cy + 2 * k }, 7 * k, 6 * k, fill);
  ellipse(ctx, { x: cx + 8 * k, y: cy + 2 * k }, 7 * k, 6 * k, fill);
  ellipse(ctx, { x: cx + 1 * k, y: cy - 5 * k }, 7 * k, 6 * k, fill);
  // A crescent: the moon, then a cloud-coloured bite out of its upper right.
  ellipse(ctx, { x: cx, y: cy }, 5 * k, 5 * k, DREAM_MOON);
  ellipse(ctx, { x: cx + 2.4 * k, y: cy - 1.6 * k }, 4.4 * k, 4.4 * k, fill);
}

/**
 * Screen anchors for the *animated* desk props (Tier-A CSS overlays, ADR 086): the spinning point of each
 * desktop fan's grille and the steam source above each desk coffee mug. Recomputed from the same
 * `PROP_SPEC` geometry the canvas draw uses, so a fan/steam element always lands on its drawn prop. Which
 * desks *carry* a prop is a stable per-desk hash, but both animate **only at an occupied desk** — an
 * unattended running fan or a steaming fresh mug reads as wrong (nobody's there). `occupied` (the set of
 * desk slot ids with a seated member) gates both; the physical fan and mug are still drawn at empty desks,
 * just idle (the fan off, the mug empty — see `deskFan` / `deskCoffee`).
 */
export function animatedDeskAnchors(
  fit: Fit,
  occupied: Set<number>,
): { fans: Pt[]; coffees: Pt[] } {
  const fans: Pt[] = [];
  const coffees: Pt[] = [];
  for (const slot of DESK_SLOTS) {
    if (!occupied.has(slot.id)) continue; // empty desk: fan idle, mug empty — nothing animates
    if (deskHasProp(slot.id, 'fan')) {
      const [ix, iy] = deskPoint(slot, PROP_SPEC.fan.along, PROP_SPEC.fan.across);
      const b = project(ix, iy, fit);
      fans.push({ x: b.x, y: b.y - (DESK_UP + 17) * fit.scale }); // matches deskFan's grille centre
    }
    if (deskHasProp(slot.id, 'coffee')) {
      const [ix, iy] = deskPoint(slot, PROP_SPEC.coffee.along, PROP_SPEC.coffee.across);
      const b = project(ix, iy, fit);
      coffees.push({ x: b.x, y: b.y - (DESK_UP + 12) * fit.scale }); // matches deskCoffee's mug rim
    }
  }
  return { fans, coffees };
}

/** Screen position of the break-nook coffee machine (the ambient steam source, ADR 086). */
export function coffeeAnchor(fit: Fit): Pt {
  const s = project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit);
  // Off the warmer plate, which is the machine's full height (MACHINE_H) above the counter — steam
  // rising out of the middle of the body instead would read as the machine being on fire.
  return { x: s.x, y: s.y - (LOUNGE.counter.h + MACHINE_H + 2) * fit.scale };
}

/** A transient act cue: a tinted ring + optional glyph (`ring`), a broadcast sweep (`wave`), a glow
 * at the entrance when someone comes or goes (`door`), or a celebration burst over an accepted
 * member's head (`confetti`). */
export interface Cue {
  at: Pt;
  to?: Pt;
  source?: string;
  color: string;
  glyph: '' | '?' | '!' | '📣' | '✓' | '↦' | '↪';
  t: number;
  urgent: boolean;
  kind?: 'ring' | 'wave' | 'door' | 'thread' | 'confetti' | 'toss' | 'dust';
  /** Confetti only: a newcomer's colour (lane 01M3F81DD9) — alternated with mustard, replacing the
   *  celebration palette, so the burst is theirs and the brand's. */
  tint?: string;
}

/** The celebration palette — the cue-family literals the scene already speaks (accept green, the
 * accent mustard, handoff sea blue, danger coral), cycled per particle. */
const CONFETTI_COLORS = ['#5cd49a', '#f4cf52', '#7fc8d8', '#f3776a'] as const;
const CONFETTI_COUNT = 18;

/**
 * One confetti particle's whole flight, derived from its index alone — deterministic, so a cue
 * draws identically for a given `t` (no per-frame randomness to make tests flaky or frames shear).
 * A ballistic puff: up and out from the head, gravity pulling the tail down, spinning as it goes.
 */
function confettiParticle(i: number, t: number, scale: number, at: Pt) {
  // Golden-angle fan: spreads the launch directions without two particles ever sharing one.
  const angle = -Math.PI / 2 + Math.sin(i * 2.399963) * 1.1;
  const speed = (34 + ((i * 7919) % 23)) * scale;
  const x = at.x + Math.cos(angle) * speed * t * 1.6;
  const y = at.y + Math.sin(angle) * speed * t * 1.9 + 52 * scale * t * t; // gravity
  const spin = t * (4 + (i % 5)) + i;
  return { x, y, spin, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]! };
}

/** A confetti fleck's colour: the celebration palette, or — for a welcome — the newcomer's own colour
 *  alternated with the brand mustard (lane 01M3F81DD9). */
export function confettiColor(i: number, tint?: string): string {
  if (tint) return i % 2 === 0 ? tint : MUSTARD;
  return CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
}

export function drawCue(ctx: CanvasRenderingContext2D, cue: Cue, scale: number): void {
  const { at, color, t } = cue;

  if (cue.kind === 'thread' && cue.to) {
    const dx = cue.to.x - at.x;
    const dy = cue.to.y - at.y;
    const lift = Math.min(70, Math.max(18, Math.hypot(dx, dy) * 0.18));
    const control = {
      x: at.x + dx / 2,
      y: at.y + dy / 2 - lift * scale,
    };
    const eased = CANVAS_EASE.out(t);
    ctx.globalAlpha = (1 - t) * 0.58;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([7 * scale, 8 * scale]);
    ctx.lineDashOffset = -eased * 30 * scale;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.quadraticCurveTo(control.x, control.y, cue.to.x, cue.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'toss' && cue.to) {
    // An abandoned lane's crumpled card (ADR 751), thrown from the hand into the wastebasket: a high
    // arc that drops into the bin's mouth over the first two thirds of the cue, spinning as it goes.
    const f = Math.min(1, t * 1.5);
    if (f >= 1) return;
    const dx = cue.to.x - at.x;
    const dy = cue.to.y - at.y;
    const lift = (26 + Math.abs(dx) * 0.25) * scale;
    const x = at.x + dx * f;
    const y = at.y + dy * f - lift * 4 * f * (1 - f);
    drawPaperBall(ctx, x, y, 2.6 * scale, f * 9);
    return;
  }

  if (cue.kind === 'dust') {
    // A card moved with nobody in the room to carry it (ADR 751): a small puff of cork dust where it
    // hung, so the change is seen rather than a card silently jumping.
    const grow = 1 - Math.pow(1 - t, 2);
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      ctx.globalAlpha = (1 - t) * 0.45;
      ctx.beginPath();
      ctx.arc(at.x + Math.cos(a) * grow * 7 * scale, at.y + Math.sin(a) * grow * 4 * scale - grow * 3 * scale, (1.6 + grow * 2) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'confetti') {
    // The acceptance celebration: a one-shot ballistic puff of paper over the celebrant's head.
    // Fully derived from `t` — nothing stored per frame, nothing re-arms, so it costs exactly one
    // cue lifetime and holds still under ?still like every other event cue.
    ctx.globalAlpha = Math.max(0, 1 - t * t * 1.15);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const p = confettiParticle(i, t, scale, at);
      ctx.save();
      ctx.translate(p.x, p.y - 26 * scale);
      ctx.rotate(p.spin);
      ctx.fillStyle = confettiColor(i, cue.tint);
      // Fleck size is stream-tested: 4.8×2.8 read as noise at room zoom (2026-08-19 eyeball),
      // and the 720p encode eats another third — these proportions are the floor, not a taste call.
      ctx.fillRect(-3.6 * scale, -2.1 * scale, 7.2 * scale, 4.2 * scale);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'wave') {
    // A broadcast sweep: a big, diffuse ring rolling out from the announcer across the room.
    const grow = 1 - Math.pow(1 - t, 2);
    const r = (24 + grow * 300) * scale;
    ctx.globalAlpha = (1 - t) * (1 - t) * 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'door') {
    // The entrance "opens" — a glass-tall glow that brightens then fades as someone passes through.
    const w = 58 * scale;
    const h = 96 * scale;
    ctx.globalAlpha = Math.sin(Math.min(1, t) * Math.PI) * 0.5;
    ctx.fillStyle = color;
    roundRect(ctx, at.x - w / 2, at.y - h, w, h, 6 * scale, color);
    // The leaves part a crack down the middle as they let someone through, then close (L5): the light
    // spills out of a slit, not a slab.
    const crack = Math.sin(Math.min(1, t) * Math.PI);
    ctx.globalAlpha = Math.min(1, crack * 1.4);
    ctx.fillStyle = '#fff6d6';
    ctx.fillRect(
      at.x - crack * 1.6 * scale,
      at.y - h + 4 * scale,
      crack * 3.2 * scale,
      h - 8 * scale,
    );
    ctx.globalAlpha = 1;
    return;
  }

  const grow = 1 - Math.pow(1 - t, 3);
  const r = (8 + grow * 34) * scale;
  ctx.globalAlpha = (1 - t) * (1 - t) * 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = (cue.urgent ? 3.5 : 2.4) * scale;
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, r, r * 0.6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (cue.glyph) {
    const rise = t * 26 * scale;
    ctx.globalAlpha = Math.max(0, 1 - t * 1.1);
    ctx.font = canvasFont(Math.round(15 * scale));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cue.urgent ? '#f3776a' : color;
    ctx.fillText(cue.glyph, at.x, at.y - 20 * scale - rise);
    ctx.globalAlpha = 1;
  }
}
