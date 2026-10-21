/**
 * Compose a member's figure for one frame from tinted identity layers (office realism, plan
 * Task 11; spec §3.2). `layersFor` is the draw order and the colour of each layer, read from
 * `appearance.ts`; `drawFigureFrame` blits them back to front at the member's floor point.
 * A layer whose sheet is missing is skipped, so a new hair style or hat added to `appearance.ts`
 * before its sheet is rendered draws the figure without it, never nothing (Review Focus 2).
 */
import type { Accessory, Appearance, FacialHair, Hat, HairStyle, TopCut } from '../appearance';
import { project, type Fit } from '../iso';
import type { OfficeNode } from '../types';
import { type Anim, type Dir8, frameCell, type SheetSpec } from './figureSheet';
import { type CreateCanvas, defaultCreate, mulHex, tintFrame } from './tint';

export type LayerId =
  | 'skin'
  | `hair/${HairStyle}`
  | `facial/${FacialHair}`
  | `hat/${Hat}`
  | `top/${TopCut}`
  | 'bottom'
  | 'shoes'
  | `acc/${Accessory}`
  | 'visor';

export interface Layer {
  id: LayerId;
  /** Multiply tint for the neutral sheet; null draws the sheet as rendered (the visor). */
  color: string | null;
}

/**
 * Back to front: skin, hair, facial hair, top, bottom, shoes, hat, accessory, and the visor last
 * for an agent — "the one tell the office cannot afford to lose". `topColor` is the member's
 * identity colour, which `appearance.ts` deliberately does not carry.
 */
export function layersFor(a: Appearance, kind: OfficeNode['kind'], topColor: string | null = null): Layer[] {
  const out: Layer[] = [{ id: 'skin', color: a.skin }];
  if (a.hair !== 'bald') out.push({ id: `hair/${a.hair}`, color: a.hairColor });
  if (a.facialHair !== 'none') out.push({ id: `facial/${a.facialHair}`, color: a.hairColor });
  out.push({ id: `top/${a.cut}`, color: topColor });
  out.push({ id: 'bottom', color: a.bottom });
  out.push({ id: 'shoes', color: a.shoes });
  if (a.hat !== 'none') out.push({ id: `hat/${a.hat}`, color: a.hatColor });
  if (a.accessory !== 'none') out.push({ id: `acc/${a.accessory}`, color: a.accessoryColor });
  if (kind === 'agent') out.push({ id: 'visor', color: null });
  return out;
}

export interface FigureDraw {
  ctx: CanvasRenderingContext2D;
  fit: Fit;
  at: { lx: number; ly: number };
  /** The neutral sheets by layer id, as loaded (`office-art-fig-<layer>.png`). */
  sheets: Map<LayerId, CanvasImageSource>;
  spec: SheetSpec;
  look: Appearance;
  kind: OfficeNode['kind'];
  /** The member's identity colour, for the top. */
  topColor?: string | null;
  anim: Anim;
  dir: Dir8;
  t: number;
  startT: number;
  alpha?: number;
  /** The room's light tint for figures (`figureTintFor`), multiplied into every layer. */
  tint?: string;
  /** Uniform size multiplier (nook/queue actors render at 0.72). */
  size?: number;
  /** The one scratch canvas the tint pass reuses (grown to fit; made on first use with `create`). */
  scratch: { canvas?: HTMLCanvasElement };
  create?: CreateCanvas;
}

export function drawFigureFrame(d: FigureDraw): void {
  const { ctx, fit, spec } = d;
  const tint = d.tint ?? '#ffffff';
  const size = d.size ?? 1;
  const k = (fit.scale * size) / spec.scale;
  const p = project(d.at.lx, d.at.ly, fit);
  const alpha = d.alpha ?? 1;
  if (alpha < 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
  }
  for (const layer of layersFor(d.look, d.kind, d.topColor ?? null)) {
    const sheet = d.sheets.get(layer.id);
    if (!sheet) continue;
    const c = frameCell(spec, layer.id, d.anim, d.dir, d.t, d.startT);
    if (c.sw <= 0 || c.sh <= 0) continue;
    const dx = p.x - (spec.anchor.x - c.ox) * k;
    const dy = p.y - (spec.anchor.y - c.oy) * k;
    const color = layer.color ? mulHex(layer.color, tint) : tint === '#ffffff' ? null : tint;
    if (color) {
      d.scratch.canvas ??= (d.create ?? defaultCreate)(c.sw, c.sh);
      const tinted = tintFrame(d.scratch.canvas, sheet, c.sx, c.sy, c.sw, c.sh, color);
      if (!tinted) continue;
      ctx.drawImage(tinted, 0, 0, c.sw, c.sh, dx, dy, c.sw * k, c.sh * k);
    } else {
      ctx.drawImage(sheet, c.sx, c.sy, c.sw, c.sh, dx, dy, c.sw * k, c.sh * k);
    }
  }
  if (alpha < 1) ctx.restore();
}
