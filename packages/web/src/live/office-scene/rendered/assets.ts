/**
 * The rendered-art loaders (office realism, plan Task 2).
 *
 * The pre-rendered office is the office (lane 01M5D8EJ40: the painters and the `?office=painted`
 * opt-out went with Task 19; `docs/wiki/restoring-the-painted-office.md` says how to get them back).
 * An asset that fails to load is listed in `missing` rather than failing the load: a room with one
 * item missing beats a blank panel (Review Focus 1).
 */
import type { DogSpec } from './dogSheet';
import type { FigureScratch, LayerId } from './figure';
import { type Anim, ANIMS, CARRY_ANIMS, DIR8, type Dir8, type SheetSpec } from './figureSheet';
import type { RenderedManifest } from './manifest';

export interface RenderedAssets {
  manifest: RenderedManifest;
  /** Decoded images by asset id. An id absent here was in the manifest but failed to load. */
  images: Map<string, CanvasImageSource>;
  /** The files that failed, by basename, for the one `console.warn` the scene prints. */
  missing: string[];
  /** The office dog's sheet and spec (`dog.json`, increment 4), when in the build and loaded. */
  dog?: { spec: DogSpec; sheet: CanvasImageSource } | undefined;
  /** The member figure's sprite sheets (increment 3), when `figure.json` is in the build and loaded. */
  figure?: FigureAssets | undefined;
}

export interface FigureAssets {
  spec: SheetSpec;
  /** Neutral sheets by layer id; a layer absent here failed to load and is skipped by `drawFigureFrame`. */
  sheets: Map<LayerId, CanvasImageSource>;
  /** The tint pass's one scratch canvas (`tintFrame`) and the composed frames, shared by every member. */
  scratch: FigureScratch;
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

/**
 * Load the layer sheets of `spec` — only those in `wanted` when given (`wornLayers`: what the roster
 * wears), else all. A sheet that fails is left out (its layer is skipped). Never rejects.
 */
export async function loadFigureAssets(
  spec: FigureSpecJson,
  urlFor: (file: string) => string,
  loadImage: (url: string) => Promise<CanvasImageSource> = domImage,
  wanted?: ReadonlySet<LayerId>,
): Promise<FigureAssets & { missing: string[] }> {
  const sheets = new Map<LayerId, CanvasImageSource>();
  const files = new Map(spec.layers.map((l) => [l.id, l.file] as const));
  const missing = await loadFigureLayers(sheets, files, wanted ?? files.keys(), urlFor, loadImage);
  const { layers: _layers, ...sheet } = spec;
  void _layers;
  return { spec: sheet, sheets, scratch: {}, missing };
}

/**
 * Load into `sheets` every sheet of `ids` it lacks — the rest of a roster's wardrobe as members join
 * (or go dnd and put the headphones on). `inFlight` keeps two calls from fetching one sheet twice.
 * Resolves to the files that failed. Never rejects.
 */
export async function loadFigureLayers(
  sheets: Map<LayerId, CanvasImageSource>,
  files: ReadonlyMap<LayerId, string>,
  ids: Iterable<LayerId>,
  urlFor: (file: string) => string,
  loadImage: (url: string) => Promise<CanvasImageSource> = domImage,
  inFlight: Set<LayerId> = new Set(),
): Promise<string[]> {
  const missing: string[] = [];
  const todo = [...ids].filter((id) => !sheets.has(id) && !inFlight.has(id) && files.has(id));
  for (const id of todo) inFlight.add(id);
  await Promise.all(
    todo.map(async (id) => {
      const file = files.get(id)!;
      try {
        sheets.set(id, await loadImage(urlFor(file)));
      } catch {
        missing.push(file);
      } finally {
        inFlight.delete(id);
      }
    }),
  );
  return missing;
}

export function domImage(url: string): Promise<CanvasImageSource> {
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
  /** Which ids to load now; the rest wait for `syncImages`. Every id when omitted. */
  want: (id: string) => boolean = () => true,
): Promise<RenderedAssets> {
  const images = new Map<string, CanvasImageSource>();
  const missing: string[] = [];
  await Promise.all(
    manifest.assets.filter((a) => want(a.id)).map(async (a) => {
      try {
        images.set(a.id, await loadImage(urlFor(a.file)));
      } catch {
        missing.push(a.file);
      }
    }),
  );
  return { manifest, images, missing };
}

/**
 * Bring the loaded subset of `ids` in line with `wanted`: load what is wanted and absent, drop what
 * is loaded and no longer wanted (the browser frees a dropped image's decoded pixels). Ids outside
 * `ids` are never touched. Resolves true when an image arrived, so the caller can rebake. Never
 * rejects; a file that fails stays absent and is tried again on the next sync.
 */
export async function syncImages(
  r: RenderedAssets,
  ids: (id: string) => boolean,
  wanted: Set<string>,
  urlFor: (file: string) => string,
  loadImage: (url: string) => Promise<CanvasImageSource> = domImage,
  inFlight: Set<string> = new Set(),
): Promise<boolean> {
  for (const id of [...r.images.keys()]) if (ids(id) && !wanted.has(id)) r.images.delete(id);
  const fetch = r.manifest.assets.filter((a) => ids(a.id) && wanted.has(a.id) && !r.images.has(a.id) && !inFlight.has(a.id));
  if (!fetch.length) return false;
  let arrived = false;
  await Promise.all(
    fetch.map(async (a) => {
      inFlight.add(a.id);
      try {
        const img = await loadImage(urlFor(a.file));
        // still wanted? the clock or the room may have moved on while it decoded
        if (wanted.has(a.id)) {
          r.images.set(a.id, img);
          arrived = true;
        }
      } catch {
        /* absent until the next sync */
      } finally {
        inFlight.delete(a.id);
      }
    }),
  );
  return arrived;
}
