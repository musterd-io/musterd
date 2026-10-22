/**
 * Compose a member's figure for one frame from tinted identity layers (office realism, plan
 * Task 11; spec §3.2). `layersFor` is the draw order and the colour of each layer, read from
 * `appearance.ts`; `drawFigureFrame` blits them back to front at the member's floor point.
 * A layer whose sheet is missing is skipped, so a new hair style or hat added to `appearance.ts`
 * before its sheet is rendered draws the figure without it, never nothing (Review Focus 2).
 */
import { type Accessory, type Appearance, type FacialHair, type Hat, type HairStyle, lookFor, type TopCut } from '../appearance';
import { project, type Fit } from '../iso';
import type { CarryKind, OfficeNode } from '../types';
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
  | 'visor'
  | `carry/${CarryLayer}`
  | 'lanyard'
  | 'lanyard-card';

/** The carried things' sheets (`figure.py` CARRY): the moving box is the box in kraft, a plant in it. */
export type CarryLayer = 'laptop' | 'box' | 'plant' | 'plate' | 'card' | 'mug' | 'bottle' | 'phone';

/** The handoff box's blue, and the moving box's kraft — the painter's colours (`character.ts`). */
const BOX = '#8fd0dd';
const MOVING_BOX = '#c9a26b';
/** The break nook's ceramic, for a mug that is not a desk mug. */
const NOOK_MUG = '#d6d0c6';

/** What a member has with them this frame, beyond what they wear (plan Task 16). */
export interface Held {
  carry?: CarryKind | null;
  /** The desk mug's colour while a sip beat raises it. */
  mug?: string;
  /** A first arrival's lanyard, in their colour. */
  lanyard?: string;
}

function carried(h: Held): Layer[] {
  switch (h.carry) {
    case 'box':
      return [{ id: 'carry/box', color: BOX }];
    case 'movingBox':
      return [
        { id: 'carry/box', color: MOVING_BOX },
        { id: 'carry/plant', color: null },
      ];
    case 'mug':
      return [{ id: 'carry/mug', color: h.mug ?? NOOK_MUG }];
    case 'laptop':
    case 'plate':
    case 'card':
    case 'bottle':
    case 'phone':
      return [{ id: `carry/${h.carry}`, color: null }];
    default:
      return h.mug ? [{ id: 'carry/mug', color: h.mug }] : [];
  }
}

export interface Layer {
  id: LayerId;
  /** Multiply tint for the neutral sheet; null draws the sheet as rendered (the visor). */
  color: string | null;
}

/**
 * Back to front: skin, hair, facial hair, top, bottom, shoes, whatever they carry and a lanyard, hat,
 * accessory, and the visor last for an agent — "the one tell the office cannot afford to lose".
 * `topColor` is the member's identity colour, which `appearance.ts` deliberately does not carry. A
 * carried thing's sheet already has the hands and body cut out of it where they are in front.
 */
export function layersFor(a: Appearance, kind: OfficeNode['kind'], topColor: string | null = null, held: Held = {}): Layer[] {
  const out: Layer[] = [{ id: 'skin', color: a.skin }];
  if (a.hair !== 'bald') out.push({ id: `hair/${a.hair}`, color: a.hairColor });
  if (a.facialHair !== 'none') out.push({ id: `facial/${a.facialHair}`, color: a.hairColor });
  out.push({ id: `top/${a.cut}`, color: topColor });
  out.push({ id: 'bottom', color: a.bottom });
  out.push({ id: 'shoes', color: a.shoes });
  out.push(...carried(held));
  if (held.lanyard) out.push({ id: 'lanyard', color: held.lanyard }, { id: 'lanyard-card', color: null });
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
  /** What they carry, a sip's mug, a lanyard. */
  held?: Held;
  /** `arms` is the seated overlay: only each layer's `@arms` cells, drawn again over the desk. */
  part?: 'all' | 'arms';
  anim: Anim;
  dir: Dir8;
  t: number;
  startT: number;
  /** A gesture's frame, chosen by the beat rather than the clock (`animFor`). */
  frame?: number;
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
  const arms = d.part === 'arms';
  for (const layer of layersFor(d.look, d.kind, d.topColor ?? null, d.held)) {
    const sheet = d.sheets.get(layer.id);
    if (!sheet) continue;
    // The overlay draws only the layers that stored arm pixels; the rest of the figure stays behind the desk.
    const key = arms ? `${layer.id}@arms` : layer.id;
    if (arms && !spec.cells?.[key]) continue;
    const c = frameCell(spec, key, d.anim, d.dir, d.t, d.startT, d.frame);
    if (c.sw <= 0 || c.sh <= 0) continue;
    const dx = p.x - (spec.anchor.x - c.ox) * k;
    const dy = p.y - (spec.anchor.y - c.oy) * k;
    const color = layer.color ? mulHex(layer.color, tint) : tint === '#ffffff' ? null : tint;
    let src: CanvasImageSource = sheet;
    let sx = c.sx;
    let sy = c.sy;
    if (color) {
      d.scratch.canvas ??= (d.create ?? defaultCreate)(c.sw, c.sh);
      const tinted = tintFrame(d.scratch.canvas, sheet, c.sx, c.sy, c.sw, c.sh, color);
      if (!tinted) continue;
      src = tinted;
      sx = 0;
      sy = 0;
    }
    if (c.flip) {
      // A mirrored direction: the stored one, flipped about the cell's own right edge.
      ctx.save();
      ctx.translate(dx + c.sw * k, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(src, sx, sy, c.sw, c.sh, 0, 0, c.sw * k, c.sh * k);
      ctx.restore();
    } else {
      ctx.drawImage(src, sx, sy, c.sw, c.sh, dx, dy, c.sw * k, c.sh * k);
    }
  }
  if (alpha < 1) ctx.restore();
}

/**
 * The sheets a roster needs: every layer its members wear (`lookFor`, so a dnd member's headphones
 * count), plus the carried things and the lanyard — small, and wanted the moment an errand or a first
 * arrival starts, not a fetch later. Every other hair style, hat, top and accessory stays on the server
 * until someone wearing it joins.
 */
export function wornLayers(nodes: Iterable<Pick<OfficeNode, 'name' | 'kind' | 'dnd'>>): Set<LayerId> {
  const out = new Set<LayerId>(ALWAYS_LOADED);
  for (const n of nodes) for (const l of layersFor(lookFor(n), n.kind)) out.add(l.id);
  return out;
}

const ALWAYS_LOADED: readonly LayerId[] = [
  'skin',
  'bottom',
  'shoes',
  'carry/laptop',
  'carry/box',
  'carry/plant',
  'carry/plate',
  'carry/card',
  'carry/mug',
  'carry/bottle',
  'carry/phone',
  'lanyard',
  'lanyard-card',
];
