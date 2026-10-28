import { setPortrait } from '../portraits';
import { lookFor } from './appearance';
import type { FigureAssets } from './rendered/assets';
import { drawFigureFrame, type FigureScratch } from './rendered/figure';
import type { OfficeNode } from './types';

/**
 * Paint each member's portrait from their rendered figure and publish it for `MemberFace`
 * (`../portraits.ts`, lane 01M6017Z38). One idle frame facing the camera (SE), drawn large on a scratch
 * canvas, then cropped to the head and shoulders and kept as a small square PNG. A member is painted
 * again only when what decides the picture changes: their look, their colour, or a sheet that arrived.
 */

/** Output size, px: the largest face /live shows is 26 CSS px, so 64 covers DPR 2 with room. */
const OUT = 64;
/** Draw scale (px per floor unit): large enough that the crop is sharp at `OUT`. */
const SCALE = 3;
/** The head and shoulders: this share of the figure's height, from the top of the head. */
const BUST = 0.36;

const painted = new Map<string, string>();
const scratch: FigureScratch = {};

export function paintPortraits(fig: FigureAssets, nodes: Iterable<OfficeNode>): void {
  if (typeof document === 'undefined') return;
  for (const node of nodes) {
    const key = `${node.kind}|${node.color}|${node.dnd ? 1 : 0}|${fig.sheets.size}`;
    if (painted.get(node.name) === key) continue;
    const url = paint(fig, node);
    if (!url) continue;
    painted.set(node.name, key);
    setPortrait(node.name, url);
  }
}

function paint(fig: FigureAssets, node: OfficeNode): string | null {
  const W = 220;
  const H = 320;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  drawFigureFrame({
    ctx,
    fit: { ox: W / 2, oy: H - 20, scale: SCALE },
    at: { lx: 0, ly: 0 },
    sheets: fig.sheets,
    spec: fig.spec,
    look: lookFor(node),
    kind: node.kind,
    topColor: node.color,
    anim: 'idle',
    dir: 'SE',
    t: 0,
    startT: 0,
    frame: 0,
    scratch,
  });
  // Find the figure's own pixels, then take the top of it.
  const { data } = ctx.getImageData(0, 0, W, H);
  let top = H;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3]! > 24) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null;
  const side = Math.round((bottom - top) * BUST);
  const cx = (left + right) / 2;
  const out = document.createElement('canvas');
  out.width = OUT;
  out.height = OUT;
  const o = out.getContext('2d');
  if (!o) return null;
  o.imageSmoothingQuality = 'high';
  // a hair of headroom above the crown, the shoulders running off the bottom edge
  o.drawImage(c, cx - side / 2, top - side * 0.06, side, side, 0, 0, OUT, OUT);
  return out.toDataURL('image/png');
}
