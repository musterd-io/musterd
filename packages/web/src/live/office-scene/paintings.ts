/**
 * The office paintings (office decor refresh, lane 01M6FXB2CA, ADR 789): an original painting in every
 * frame, filling the frame's opening up to a thin mat. The frame and mat are rendered art (`wall/art-N`);
 * the picture is a committed image (`painting/N`, made by `art/office/paintings.py`) drawn here onto the
 * wall's plane and multiplied by the room's light, so it dims with the room at dusk and night.
 */
import type { ArtPiece } from './layout';
import type { Pt } from './iso';

/** The mat left showing round a print, logical units (`paintings.py` MAT). */
export const MAT = 2;

/**
 * The print's half-width and half-height in logical units. The frame's bar is `w × 0.06` (thick) or
 * `w × 0.025` (thin) a side, as `scene.wall_art` builds it, and the mat shows `MAT` inside that; an
 * unframed canvas is printed edge to edge.
 */
export function printOpening(w: number, h: number, frame: ArtPiece['frame']): { hw: number; hh: number } {
  if (frame === 'none') return { hw: w / 2, hh: h / 2 };
  const bar = w * (frame === 'thick' ? 0.06 : 0.025);
  return { hw: (w - 2 * bar) / 2 - MAT, hh: (h - 2 * bar) / 2 - MAT };
}

/**
 * The plane the print is drawn in, units out of the plaster. The picture paints OVER the rendered frame,
 * so it is placed just behind the frame's front face (`scene.wall_art`: 3.2 thick, 2.2 thin), where the
 * eye reads the opening; on the mat's own face (1.2) it rides up over the top bar and leaves a strip of
 * mat at the bottom. An unframed canvas is its own face (2.6).
 */
export function printDepth(frame: ArtPiece['frame']): number {
  return frame === 'none' ? 2.6 : frame === 'thick' ? 2.8 : 1.8;
}

/**
 * How far below `wallPt`'s centre a framed mat actually renders, logical units. Measured 2026-11-03 from
 * the `wall/art-N` assets (the mat's bright centroid against the anchor): 2.05, 2.61, 1.68 and 2.11 for
 * the four framed pieces. Without it a painting rides up over the frame's top bar.
 */
export const PRINT_DROP = 2;

/**
 * The image's top-left, top-right and bottom-left corners on screen. `p(a, b)` maps wall space (`a`
 * along the wall from the print's centre, `b` up) to the screen. On the back-left wall `+t` runs
 * screen-left, so the image's left edge sits at `+hw` there (`mirror`), or the painting reads backwards.
 */
export function paintingQuad(
  p: (a: number, b: number) => Pt,
  hw: number,
  hh: number,
  mirror: boolean,
): [Pt, Pt, Pt] {
  const left = mirror ? hw : -hw;
  return [p(left, hh), p(-left, hh), p(left, -hh)];
}

/**
 * Draw an `iw × ih` image onto `quad` (an affine map, so it lies flat on the wall), then multiply the
 * room's light `tint` over the same quad. No image yet: nothing is drawn, and the mat shows bare.
 */
export function drawPainting(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource | undefined,
  quad: [Pt, Pt, Pt],
  iw: number,
  ih: number,
  tint: string,
): void {
  if (!img) return;
  const [o, x, y] = quad;
  ctx.save();
  ctx.transform((x.x - o.x) / iw, (x.y - o.y) / iw, (y.x - o.x) / ih, (y.y - o.y) / ih, o.x, o.y);
  ctx.drawImage(img, 0, 0, iw, ih);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, iw, ih);
  ctx.restore();
}
