/**
 * The three signs on the office walls (office decor refresh, lane 01M6FXKVDD): the wiki, the settings
 * tab and the work board. nick picked the look from three mockups: carved oak with raised gold
 * lettering, hung on short brass chains, with a small brass picture light that glows after dark.
 *
 * They are rendered art (`wall/sign-<name>`, `scene.py` `wall_sign`, which mirrors these numbers); the
 * doors stay DOM (`index.ts`): an invisible button over each sign keeps its accessible name, its hover
 * glow and the 24px tap floor, and takes its box from `signRect`. The lamps light after dark in
 * `render.ts` `drawInteriorLight`, with the room's other lamps.
 */
import { FLOOR, WALL_H, type Fit, type Pt } from './iso';
import { WALL_EDGES, wallPt } from './windowView';

export type SignName = 'wiki' | 'settings' | 'board';

export interface Sign {
  wall: 0 | 1;
  /** Centre along the wall (0…1) and up it (0…1), as the art's `tc`/`uc`. */
  tc: number;
  uc: number;
  /** Size in logical units. */
  w: number;
  h: number;
  text: string;
  /** A brass picture light above it. The settings tab has none: the calendar hangs right above it. */
  lamp: boolean;
}

export const SIGN_NAMES: readonly SignName[] = ['wiki', 'settings', 'board'];

export const SIGNS: Record<SignName, Sign> = {
  // Over the wiki shelf's left end: the plaster between the river painting (ends t 0.17) and the near
  // window's drape (starts t 0.225). Its bottom clears the shelf top and whatever stands on it (66 + 22).
  wiki: { wall: 0, tc: 0.1985, uc: 0.54, w: 42, h: 20, text: 'wiki', lamp: true },
  // Flush under the working-hours calendar (its bottom edge is at u 0.3 − 26/188), across its middle,
  // as wide as the bay between the windows allows.
  settings: { wall: 1, tc: 0.52, uc: 0.1005, w: 96, h: 22, text: 'settings', lamp: false },
  // Centred over the board, just above its top edge (u 0.798), its picture light under the ceiling.
  board: { wall: 1, tc: 0.8922, uc: 0.8617, w: 104, h: 22, text: 'work board', lamp: true },
};

/**
 * A sign's screen box: the axis-aligned bounds of its four corners, grown to the 24px tap floor. `tiltDeg` is the slope of its edges, as `boardAnchor.tiltDeg`.
 */
export function signRect(
  fit: Fit,
  name: SignName,
): { x: number; y: number; w: number; h: number; tiltDeg: number } {
  const s = SIGNS[name];
  const edge = WALL_EDGES[s.wall]!;
  const dt = s.w / 2 / FLOOR;
  const du = s.h / 2 / WALL_H;
  const corners: Pt[] = [
    wallPt(edge, s.tc - dt, s.uc - du, fit),
    wallPt(edge, s.tc + dt, s.uc - du, fit),
    wallPt(edge, s.tc + dt, s.uc + du, fit),
    wallPt(edge, s.tc - dt, s.uc + du, fit),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  let x = Math.min(...xs);
  let y = Math.min(...ys);
  let w = Math.max(...xs) - x;
  let h = Math.max(...ys) - y;
  const [l, r] =
    corners[0]!.x <= corners[1]!.x ? [corners[0]!, corners[1]!] : [corners[1]!, corners[0]!];
  const tiltDeg = (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
  const MIN = 24;
  if (w < MIN) {
    x -= (MIN - w) / 2;
    w = MIN;
  }
  if (h < MIN) {
    y -= (MIN - h) / 2;
    h = MIN;
  }
  return { x, y, w, h, tiltDeg };
}
