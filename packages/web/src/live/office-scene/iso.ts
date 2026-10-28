/**
 * Isometric projection ported from the Figma "Live Office" spec: a fixed bird's-eye 2:1 iso, drawn in
 * screen space (no camera tilt). Logical floor is FLOOR×FLOOR; `project()` maps a logical point to the
 * panel given a fitted origin+scale; painter's order is ascending `depth()` (= lx+ly) so nearer things
 * draw last and overlap correctly.
 */

export const KX = 0.70710678;
export const KY = 0.35355339;

/**
 * An orthographic corner camera: `kx` spreads a floor unit left/right of the back corner, `ky` drops
 * it down the panel. Azimuth is always 45° (kx = cos 45°, so Blender renders with a square pixel —
 * `art/office/scene.py`); elevation is `asin(ky / kx)`. Heights are drawn 1:1 by both paths.
 */
export interface Camera {
  kx: number;
  ky: number;
}

/**
 * The room's camera (office realism, spec §2.2): the Figma frames' corner, "a touch lower" than their
 * 2:1 iso (`KY`, elevation 30°) so figures stand up and faces face the viewer — elevation ≈ 26°. The
 * builder tuned `ky` against the render with nick's eye (spec §6.2) and asked Blender for 0.31, but the
 * Blender cameras lift by the height stretch too, so the art renders through 0.33729 — the value
 * `scene.effective_ky(0.31)` computes and `manifest.json` records. Projecting at 0.31 put everything
 * placed on the floor up to ~48 units off the baked floor toward the room's edges: the front door
 * floated above the skirting, the café counter stood off its wall (ADR 746, lane 01M6017YB1). Every
 * fit projects through it (lane 01M5D8EJ40: the painted office and its iso camera are gone).
 */
export const CORNER_CAMERA: Camera = { kx: KX, ky: 0.33729 };
/** Logical floor extent (both axes). Desk/furniture anchors live in [0, FLOOR]. */
export const FLOOR = 900;
/** Floor slab thickness, in screen px at scale 1. */
export const THICK = 22;

/** Back-wall height in screen px at scale 1. Owned here (not in render) because the fit has to know how
 * far the scene rises above the floor's back corner — see `fitFloor`. `render.ts` imports it to draw. */
export const WALL_H = 188;
/** Screen px (at scale 1) the scene rises above the floor's back corner: the back walls, plus a little
 * headroom for the string lights and anything perched on top of them. The fit reserves this above the
 * diamond so the back corner and wall tops never clip off the top of the panel. */
export const SCENE_RISE = WALL_H + 14;
/** Screen px (at scale 1) the scene drops below the floor's front corner: the slab thickness plus the
 * soft contact shadow pooled under it (see `drawGroundShadow`). Reserved below the diamond by the fit. */
export const SCENE_DROP = THICK + 28;

export interface Pt {
  x: number;
  y: number;
}

export interface Fit {
  ox: number;
  oy: number;
  scale: number;
  /** The camera this fit projects through; absent means `CORNER_CAMERA`. */
  cam?: Camera;
}

/** The camera a fit projects through. */
export function cameraOf(fit: Fit): Camera {
  return fit.cam ?? CORNER_CAMERA;
}

/** Project a logical floor point (lx,ly) to screen pixels under a fit. */
export function project(lx: number, ly: number, fit: Fit): Pt {
  const cam = fit.cam ?? CORNER_CAMERA;
  return {
    x: fit.ox + (lx - ly) * cam.kx * fit.scale,
    y: fit.oy + (lx + ly) * cam.ky * fit.scale,
  };
}

/** Painter's depth key — larger is nearer the viewer (drawn later). */
export function depth(lx: number, ly: number): number {
  return lx + ly;
}

/**
 * The painter's depth key for a piece of furniture with a FOOTPRINT, taken at its near corner rather
 * than its centre.
 *
 * One scalar key per item is the whole painter, and for a person it is honest — a body is about as
 * wide as it is deep, so its centre is its position. For a 120-wide desk it is a lie: the centre sits
 * (w + d) / 2 behind the edge the viewer actually sees, so a member standing in FRONT of that edge
 * still keys lower than the desk and paints behind it. That is the "members walk through the
 * furniture" nick reported on 2026-09-14, and it is worst on the biggest footprints — desks, the
 * bench counter, the meeting table — because that is where centre is furthest from edge.
 *
 * Keying the near corner makes the comparison the one the eye is making: is the member in front of
 * this thing's front edge, or behind it? Both answers then come out right, and the seated case is
 * unchanged in meaning — a member at the chair behind a desk still keys lower than the desk's front
 * edge, so the slab still paints over their legs, which is what a desk does to your legs.
 *
 * Use it for anything whose footprint is large enough for the error to show. Small items (plants,
 * chairs, a printer) are near enough square that centre and edge agree within a pixel; they stay on
 * `depth` so their keys keep meaning exactly what they always did.
 */
export function nearDepth(lx: number, ly: number, w: number, d: number): number {
  return lx + ly + (w + d) / 2;
}

/**
 * A box to fit, in screen px at scale 1, relative to the floor's BACK corner (where `project(0, 0)`
 * lands). `x` runs left/right of that corner, `y` down from it — negative `top` is above the corner.
 */
export interface FitBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The whole scene: the floor diamond (2·FLOOR·KX wide), the back walls rising above its back corner
 * (`SCENE_RISE`), and the slab + contact shadow below its front corner (`SCENE_DROP`). Fitting only the
 * floor diamond (the old behaviour) let the wall tops clip off the top of the panel at wide/short aspect
 * ratios, which is why the back corner was getting cut off.
 */
export function roomBox(cam: Camera = CORNER_CAMERA): FitBox {
  return {
    left: -FLOOR * cam.kx,
    right: FLOOR * cam.kx,
    top: -SCENE_RISE,
    bottom: FLOOR * cam.ky * 2 + SCENE_DROP,
  };
}
export const ROOM_BOX: FitBox = roomBox();

/**
 * Fit a box into a panel: the largest scale that leaves `margin` of the binding axis, the box centred.
 * 0.94 → 0.96 (nick, 2026-08-03): the scene is height-bound at most aspects the product uses, so the
 * margin is the room's size on screen, and 6% of unused height on a 720p stream is 43 wasted pixels.
 */
export function fitBox(panelW: number, panelH: number, box: FitBox, margin = 0.96, cam?: Camera): Fit {
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  const scale = Math.max(0.05, Math.min((panelW * margin) / bw, (panelH * margin) / bh));
  const fit: Fit = {
    ox: panelW / 2 - ((box.left + box.right) / 2) * scale,
    oy: panelH / 2 - ((box.top + box.bottom) / 2) * scale,
    scale,
  };
  // Only set when asked for: the painted path's fits keep their exact shape (and their snapshots).
  if (cam) fit.cam = cam;
  return fit;
}

/** Fit the whole scene, margin and all — the musterd.io hero and /office-preview; /live and /broadcast fit the furnished room instead (`furnishedBox` in render.ts). */
export function fitFloor(panelW: number, panelH: number, cam?: Camera): Fit {
  return cam ? fitBox(panelW, panelH, roomBox(cam), 0.96, cam) : fitBox(panelW, panelH, ROOM_BOX);
}
