/**
 * Compose a member's figure for one frame from tinted identity layers (office realism, plan
 * Task 11; spec §3.2). `layersFor` is the draw order and the colour of each layer, read from
 * `appearance.ts`; `drawFigureFrame` blits them back to front at the member's floor point.
 * A layer whose sheet is missing is skipped, so a new hair style or hat added to `appearance.ts`
 * before its sheet is rendered draws the figure without it, never nothing (Review Focus 2).
 */
import { type Accessory, type Appearance, type Ears, type Eyes, type FacialHair, type Hat, type HairStyle, lookFor, type Smile, type TopCut } from '../appearance';
import { project, type Fit } from '../iso';
import type { CarryKind, OfficeNode } from '../types';
import { type Anim, type Dir8, frameCell, type SheetSpec } from './figureSheet';
import { type CreateCanvas, defaultCreate, mulHex, SOFT, tintFrame } from './tint';

export type LayerId =
  | 'skin'
  | 'eyes'
  | `mouth/${Smile}`
  | `hair/${HairStyle}`
  | `facial/${FacialHair}`
  | `hat/${Hat}`
  | `top/${TopCut}`
  | 'bottom'
  | 'shoes'
  | `acc/${Accessory}`
  | `acc/${Eyes}`
  | `acc/${Ears}`
  | 'tell/eyes'
  | 'tell/collar'
  | `carry/${CarryLayer}`
  | 'lanyard'
  | 'lanyard-card';

/** The carried things' sheets (`figure.py` CARRY): the moving box is the box in kraft, a plant in it. */
export type CarryLayer =
  | 'laptop'
  | 'box'
  | 'plant'
  | 'plate'
  | 'card'
  | 'mug'
  | 'bottle'
  | 'phone'
  | 'folder';

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
    case 'folder':
      return [{ id: `carry/${h.carry}`, color: null }];
    default:
      return h.mug ? [{ id: 'carry/mug', color: h.mug }] : [];
  }
}

export interface Layer {
  id: LayerId;
  /** Multiply tint for the neutral sheet; null draws the sheet as rendered (the eyes). */
  color: string | null;
}

/**
 * Back to front (figure v2, plan Task 7): skin and its untinted eyes, shoes, trousers, the top over
 * them, whatever they carry and a lanyard, then hair and facial hair (their sheets already have the
 * torso cut out behind them, so long hair in front of the shoulders shows), hat, accessory. Pieces
 * overlap now (the body is only skin), so this order is what decides what is in front.
 *
 * An agent wears no visor (nick, 2026-10-22: "i actually dont like the use of visors for any
 * members"); it is told apart by two glows in its identity colour — its eyes, and a thin collar light
 * at the neckline, which reads from every side. `topColor` is that identity colour, which
 * `appearance.ts` deliberately does not carry.
 */
export function layersFor(a: Appearance, kind: OfficeNode['kind'], topColor: string | null = null, held: Held = {}): Layer[] {
  const out: Layer[] = [{ id: 'skin', color: a.skin }, { id: 'eyes', color: null }];
  const agent = kind === 'agent';
  if (agent) out.push({ id: 'tell/eyes', color: topColor });
  // their own smile (`appearance.ts`), a darker grey tinted with their skin, so it reads as lips on any skin
  out.push({ id: `mouth/${a.smile}`, color: a.skin });
  out.push({ id: 'shoes', color: a.shoes });
  out.push({ id: 'bottom', color: a.bottom });
  out.push({ id: `top/${a.cut}`, color: topColor });
  out.push(...carried(held));
  if (held.lanyard) out.push({ id: 'lanyard', color: held.lanyard }, { id: 'lanyard-card', color: null });
  if (agent) out.push({ id: 'tell/collar', color: topColor });
  if (a.hair !== 'bald') out.push({ id: `hair/${a.hair}`, color: a.hairColor });
  if (a.facialHair !== 'none') out.push({ id: `facial/${a.facialHair}`, color: a.hairColor });
  if (a.hat !== 'none') out.push({ id: `hat/${a.hat}`, color: a.hatColor });
  // every worn spot, in its own colour (v2-5a): glasses on the eyes, headphones on the ears, a scarf
  if (a.eyes !== 'none') out.push({ id: `acc/${a.eyes}`, color: a.accessoryColor });
  if (a.ears !== 'none') out.push({ id: `acc/${a.ears}`, color: a.ears === 'headphones' ? a.accessoryColor : a.metal });
  if (a.neck !== 'none') out.push({ id: `acc/${a.neck}`, color: a.accessoryColor });
  return out;
}

export interface FigureScratch {
  canvas?: HTMLCanvasElement;
  composites?: Map<string, HTMLCanvasElement>;
  /** The cache's size limit (`compositeCapFor` the floor); `COMPOSITE_CAP` until the roster sets it. */
  cap?: number;
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
  /** The one scratch canvas the tint pass reuses (grown to fit; made on first use with `create`), and the composed frames (`composite`). */
  scratch: FigureScratch;
  create?: CreateCanvas;
}

export function drawFigureFrame(d: FigureDraw): void {
  const { ctx, fit, spec } = d;
  const tint = d.tint ?? '#ffffff';
  const size = d.size ?? 1;
  const k = (fit.scale * size) / spec.scale;
  // the member's build: wider or narrower about the floor point, never taller (spec §2.1)
  const kx = k * (d.look.build ?? 1);
  const arms = d.part === 'arms';
  /* One frame's layers, with the cell each one reads and its colour under the room's tint. The key
     names exactly those pixels, so a hit is the same composite this frame would build. */
  const parts: Part[] = [];
  let key = tint;
  for (const layer of layersFor(d.look, d.kind, d.topColor ?? null, d.held)) {
    const sheet = d.sheets.get(layer.id);
    if (!sheet) continue;
    // The overlay draws only the layers that stored arm pixels; the rest of the figure stays behind the desk.
    const id = arms ? `${layer.id}@arms` : layer.id;
    if (arms && !spec.cells?.[id]) continue;
    const c = frameCell(spec, id, d.anim, d.dir, d.t, d.startT, d.frame);
    if (c.sw <= 0 || c.sh <= 0) continue;
    const color = layer.color ? mulHex(layer.color, tint) : tint === '#ffffff' ? null : tint;
    parts.push({ sheet, c, color });
    key += `|${id}:${color ?? ''}:${c.sx},${c.sy}${c.flip ? 'f' : ''}`;
  }
  if (!parts.length) return;
  const img = composite(d, key, parts);
  if (!img) return;
  const p = project(d.at.lx, d.at.ly, fit);
  const alpha = d.alpha ?? 1;
  if (alpha < 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
  }
  ctx.drawImage(img, 0, 0, spec.frame.w, spec.frame.h, p.x - spec.anchor.x * kx, p.y - spec.anchor.y * k, spec.frame.w * kx, spec.frame.h * k);
  if (alpha < 1) ctx.restore();
}

interface Part {
  sheet: CanvasImageSource;
  c: ReturnType<typeof frameCell>;
  color: string | null;
}

/**
 * How many composed frames the figure keeps. A composite is one frame-sized canvas (108 × 156 at
 * today's spec, ~67 KB). Tinting six layers per member per frame was ~400 draw calls a frame with 14
 * on the floor, the bulk of the rendered office's frame time; caching the composite fixes that only
 * if the floor's working set fits. Measured 2026-10-23 on /office-preview?n=14 (looping
 * choreography): ~640 distinct frames, ~46 a figure. At a fixed 320 the cache thrashed (~1.1 misses
 * a frame, ~7% over the painted office); sized to the floor, misses fell to ~0 and the rendered
 * office matched the painted one (2.7 vs 2.6 ms a frame, back to back). Lane 01M5D8EJ40.
 */
export const COMPOSITE_PER_FIGURE = 48;
/** The floor at its smallest: a two-person team still keeps a few hundred frames. */
export const COMPOSITE_CAP = 320;

/** The cap for a floor of `members` (the receptionist and a visitor or two on top). */
export function compositeCapFor(members: number): number {
  return Math.max(COMPOSITE_CAP, (members + 2) * COMPOSITE_PER_FIGURE);
}

/** The member's frame, tinted and layered once, then reused while the same pixels are asked for. */
function composite(d: FigureDraw, key: string, parts: Part[]): HTMLCanvasElement | null {
  const cache = (d.scratch.composites ??= new Map());
  const hit = cache.get(key);
  if (hit) {
    // most recently used goes to the back, so eviction takes the stalest
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { w, h } = d.spec.frame;
  let out: HTMLCanvasElement;
  if (cache.size >= (d.scratch.cap ?? COMPOSITE_CAP)) {
    const [oldest, canvas] = cache.entries().next().value as [string, HTMLCanvasElement];
    cache.delete(oldest);
    out = canvas;
  } else {
    out = (d.create ?? defaultCreate)(w, h);
  }
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  const g = out.getContext('2d', SOFT);
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  for (const { sheet, c, color } of parts) {
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
      g.save();
      g.translate(c.ox + c.sw, c.oy);
      g.scale(-1, 1);
      g.drawImage(src, sx, sy, c.sw, c.sh, 0, 0, c.sw, c.sh);
      g.restore();
    } else {
      g.drawImage(src, sx, sy, c.sw, c.sh, c.ox, c.oy, c.sw, c.sh);
    }
  }
  cache.set(key, out);
  return out;
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
  'eyes',
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
  'carry/folder',
  'lanyard',
  'lanyard-card',
];
