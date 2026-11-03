/**
 * The goal bell (goal bell spec 2026-11-03, lane 01M6HHH5EH): a brass bell on a wall bracket over the
 * work board's top-left corner, with a rope hanging from its clapper down the strip of plaster between
 * the board and the window. It rings when a goal ships.
 *
 * Why the left corner, not the right the spec guessed: a rope hangs in front of the wall, and on this
 * wall "in front" lands screen-left. Hung at the board's right end, the rope crossed the board's frame;
 * at its left end it falls into the bare plaster between the board and the window, clear of the goal
 * tabs in the board's left gutter.
 *
 * The bracket and the bell are rendered (`scene.py` `wall_bell`, which mirrors `BELL`): `wall/bell-
 * bracket` is static and `wall/bell` is the body, drawn turned about its pivot by `bellSwing`. The
 * rope is painted live, so it follows the swing.
 */
import { FLOOR, WALL_H, project, type Fit, type Pt } from './iso';
import { WALL_EDGES, wallPt } from './windowView';

export const BELL = {
  wall: 1 as const,
  /** Along the wall: the strip between window 2 (ends t 0.78) and the board (starts t ≈ 0.798). */
  tc: 0.79,
  /** The pivot: where the yoke hangs from the bracket, up the wall. */
  pivotU: 0.915,
  /** How far the pivot stands out from the plaster, logical units. */
  out: 6,
  /** The bell's mouth radius and its height, pivot to lip. */
  r: 6.5,
  h: 15,
};

/** The rope: from the clapper under the bell's lip down to hand height for a standing member. */
export const ROPE = { uTop: BELL.pivotU - (BELL.h + 2) / WALL_H, uBottom: 0.37 };

/** How long a ring swings, seconds. */
export const BELL_SWING_S = 3;

/** The bell's angle off plumb `sinceS` after a strike, radians, in the wall's plane: up to ±0.35
 *  in the first swing, damped to rest by `BELL_SWING_S`. `cap` limits it (reduced motion). */
export function bellSwing(sinceS: number, cap = 0.35): number {
  if (!(sinceS >= 0) || sinceS >= BELL_SWING_S) return 0;
  const a = 0.35 * Math.sin(2 * Math.PI * 1.65 * sinceS) * Math.exp(-sinceS / 0.9);
  return Math.max(-cap, Math.min(cap, a));
}

/** The pivot on screen: the wall point at the bell's `tc`/`pivotU`, carried `out` units off the wall. */
export function bellPivot(fit: Fit): Pt {
  const edge = WALL_EDGES[BELL.wall]!;
  const w = wallPt(edge, BELL.tc, BELL.pivotU, fit);
  const o = project(0, BELL.out, fit);
  const z = project(0, 0, fit);
  return { x: w.x + o.x - z.x, y: w.y + o.y - z.y };
}

/**
 * The screen affine for turning by `angle` in the wall's plane about `pivot`: rotation in (along, up)
 * wall space, carried to the screen through the wall's own axes, so the bell swings along the wall
 * rather than in the screen's plane.
 */
export function wallTurn(fit: Fit, pivot: Pt, angle: number): DOMMatrix2DInit {
  const edge = WALL_EDGES[BELL.wall]!;
  const p0 = wallPt(edge, 0.5, 0.5, fit);
  const pa = wallPt(edge, 0.5 + 1 / FLOOR, 0.5, fit); // one unit along
  const pu = wallPt(edge, 0.5, 0.5 + 1 / WALL_H, fit); // one unit up
  const [ax, ay, ux, uy] = [pa.x - p0.x, pa.y - p0.y, pu.x - p0.x, pu.y - p0.y];
  const det = ax * uy - ux * ay;
  // B maps wall (along, up) → screen; M = B · R(angle) · B⁻¹.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const r = [ax * c + ux * s, ay * c + uy * s, -ax * s + ux * c, -ay * s + uy * c]; // B·R columns
  const a = (r[0]! * uy - r[2]! * ay) / det;
  const b = (r[1]! * uy - r[3]! * ay) / det;
  const cc = (-r[0]! * ux + r[2]! * ax) / det;
  const d = (-r[1]! * ux + r[3]! * ax) / det;
  return { a, b, c: cc, d, e: pivot.x - a * pivot.x - cc * pivot.y, f: pivot.y - b * pivot.x - d * pivot.y };
}
