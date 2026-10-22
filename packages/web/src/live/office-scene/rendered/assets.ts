/**
 * The rendered-art flag and loader (office realism, plan Task 2).
 *
 * `?office=rendered` turns the pre-rendered path on for one page load (spec §7: the flag lives until
 * nick accepts the look on /live, then /broadcast, then it goes). Until the assets have decoded the
 * painted scene draws, and an asset that fails to load is listed in `missing` rather than failing
 * the load: a room with one painted desk among rendered ones beats a blank panel (Review Focus 1).
 */
import type { LayerId } from './figure';
import { type Anim, ANIMS, CARRY_ANIMS, DIR8, type Dir8, type SheetSpec } from './figureSheet';
import type { RenderedManifest } from './manifest';

export function renderedOfficeFromSearch(search: string): boolean {
  try {
    return new URLSearchParams(search).get('office') === 'rendered';
  } catch {
    return false;
  }
}

export interface RenderedAssets {
  manifest: RenderedManifest;
  /** Decoded images by asset id. An id absent here was in the manifest but failed to load. */
  images: Map<string, CanvasImageSource>;
  /** The files that failed, by basename, for the one `console.warn` the scene prints. */
  missing: string[];
  /** The member figure's sprite sheets (increment 3), when `figure.json` is in the build and loaded. */
  figure?: FigureAssets | undefined;
}

export interface FigureAssets {
  spec: SheetSpec;
  /** Neutral sheets by layer id; a layer absent here failed to load and is skipped by `drawFigureFrame`. */
  sheets: Map<LayerId, CanvasImageSource>;
  /** The tint pass's one scratch canvas (`tintFrame`), shared by every member and frame. */
  scratch: { canvas?: HTMLCanvasElement };
}

/** What `render.py --figure` writes: a SheetSpec plus the sheet file per layer. */
export interface FigureSpecJson extends SheetSpec {
  layers: Array<{ id: LayerId; file: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse `figure.json`; throws with the offending field named. */
export function parseFigureSpec(json: unknown): FigureSpecJson {
  if (!isRecord(json)) throw new Error('figure.json is not an object');
  const { scale, frame, anchor, anims, layers } = json;
  if (!isNum(scale) || scale <= 0) throw new Error('figure.json needs a positive scale');
  if (!isRecord(frame) || !isNum(frame['w']) || !isNum(frame['h'])) throw new Error('figure.json needs frame {w, h}');
  if (!isRecord(anchor) || !isNum(anchor['x']) || !isNum(anchor['y'])) throw new Error('figure.json needs anchor {x, y}');
  if (!isRecord(anims)) throw new Error('figure.json needs anims');
  const out = {} as SheetSpec['anims'];
  for (const a of ANIMS) {
    const v = anims[a];
    // A gesture or carrying clip is optional (a sheet from before increment 3b has none; the base clip plays).
    if (v === undefined && (a.startsWith('g-') || a === 'sit-hand' || (CARRY_ANIMS as readonly string[]).includes(a))) continue;
    if (!isRecord(v) || !isNum(v['row']) || !isNum(v['frames']) || !isNum(v['fps']) || typeof v['loop'] !== 'boolean')
      throw new Error(`figure.json anim ${a} needs {row, frames, fps, loop}`);
    const dirs = v['dirs'];
    const baseOf = v['base'];
    const own = v['layers'];
    if (baseOf !== undefined && !(ANIMS as readonly unknown[]).includes(baseOf)) throw new Error(`figure.json anim ${a} base is not a clip`);
    if (own !== undefined && (!Array.isArray(own) || own.some((x) => typeof x !== 'string')))
      throw new Error(`figure.json anim ${a} layers is not a list of layer ids`);
    if (dirs !== undefined && (!Array.isArray(dirs) || dirs.some((d) => !(DIR8 as readonly unknown[]).includes(d))))
      throw new Error(`figure.json anim ${a} dirs is not a list of directions`);
    out[a] = {
      row: v['row'],
      frames: v['frames'],
      fps: v['fps'],
      loop: v['loop'],
      ...(dirs ? { dirs: dirs as Dir8[] } : {}),
      ...(baseOf !== undefined ? { base: baseOf as Anim } : {}),
      ...(own !== undefined ? { layers: own as string[] } : {}),
    };
  }
  if (!Array.isArray(layers)) throw new Error('figure.json needs a layers array');
  const cellsIn = json['cells'];
  let cells: Record<string, number[]> | undefined;
  if (cellsIn !== undefined) {
    if (!isRecord(cellsIn)) throw new Error('figure.json cells is not an object');
    cells = {};
    for (const [k, v] of Object.entries(cellsIn)) {
      if (!Array.isArray(v) || v.some((n) => !isNum(n))) throw new Error(`figure.json cells ${k} is not a number list`);
      cells[k] = v as number[];
    }
  }
  const ls = layers.map((l, i) => {
    if (!isRecord(l) || typeof l['id'] !== 'string' || typeof l['file'] !== 'string') throw new Error(`figure.json layer ${i} needs {id, file}`);
    return { id: l['id'] as LayerId, file: l['file'] };
  });
  const mirrorIn = json['mirror'];
  let mirror: SheetSpec['mirror'];
  if (mirrorIn !== undefined) {
    const ok = isRecord(mirrorIn) && Object.entries(mirrorIn).every(([k, v]) => (DIR8 as readonly unknown[]).includes(k) && (DIR8 as readonly unknown[]).includes(v));
    if (!ok) throw new Error('figure.json mirror is not a direction map');
    mirror = mirrorIn as SheetSpec['mirror'];
  }
  const height = json['height'];
  if (height !== undefined && !isNum(height)) throw new Error('figure.json height is not a number');
  return {
    scale,
    frame: { w: frame['w'], h: frame['h'] },
    anchor: { x: anchor['x'], y: anchor['y'] },
    anims: out,
    layers: ls,
    ...(cells ? { cells } : {}),
    ...(mirror ? { mirror } : {}),
    ...(isNum(height) ? { height } : {}),
  };
}

/** Load every layer sheet of `spec`; a sheet that fails is left out (its layer is skipped). Never rejects. */
export async function loadFigureAssets(
  spec: FigureSpecJson,
  urlFor: (file: string) => string,
  loadImage: (url: string) => Promise<CanvasImageSource> = domImage,
): Promise<FigureAssets & { missing: string[] }> {
  const sheets = new Map<LayerId, CanvasImageSource>();
  const missing: string[] = [];
  await Promise.all(
    spec.layers.map(async (l) => {
      try {
        sheets.set(l.id, await loadImage(urlFor(l.file)));
      } catch {
        missing.push(l.file);
      }
    }),
  );
  const { layers: _layers, ...sheet } = spec;
  void _layers;
  return { spec: sheet, sheets, scratch: {}, missing };
}

function domImage(url: string): Promise<CanvasImageSource> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  return img.decode().then(() => img);
}

/**
 * Load every asset in `manifest`. `urlFor` maps a basename to the URL Vite serves it at; `loadImage`
 * is injectable so the loader is testable under node. Never rejects.
 */
export async function loadRenderedAssets(
  manifest: RenderedManifest,
  urlFor: (file: string) => string,
  loadImage: (url: string) => Promise<CanvasImageSource> = domImage,
): Promise<RenderedAssets> {
  const images = new Map<string, CanvasImageSource>();
  const missing: string[] = [];
  await Promise.all(
    manifest.assets.map(async (a) => {
      try {
        images.set(a.id, await loadImage(urlFor(a.file)));
      } catch {
        missing.push(a.file);
      }
    }),
  );
  return { manifest, images, missing };
}
