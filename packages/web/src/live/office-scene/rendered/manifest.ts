/**
 * The rendered-art manifest (office realism, spec 2026-10-20 §3.1, plan Task 1).
 *
 * `packages/web/art/office/render.py` writes `rendered/assets/manifest.json` beside the PNGs it
 * renders; the scene reads it back through {@link parseManifest}. One manifest describes one render:
 * every asset in it was rendered from the same orthographic camera (`camera`) at the same scale, so
 * a blit only has to agree on `scale` once to land every asset on the painted floor.
 *
 * Hand-written shape check rather than zod: the web package carries no schema library, and a
 * manifest is a build input we author, not external input (hard rule 4 is about the wire).
 */
export interface RenderedAsset {
  /** Stable id the painters look up, e.g. `desk/base`, `room/floor`, `desk/lamp-on`. */
  id: string;
  /** Basename of the PNG, e.g. `office-desk-base.png` — the `office-` prefix is what the byte budget sums. */
  file: string;
  /** Source size in px, rendered at 2× (spec §5). */
  w: number;
  h: number;
  /** Where the asset's floor point (its `lx, ly` origin) sits inside the source, in source px. */
  anchor: { x: number; y: number };
  /** Source px per floor unit at 2×; the same for every asset of one render. */
  scale: number;
}

export interface RenderedManifest {
  version: 1;
  /** The orthographic camera the render used — must match `iso.ts`'s `Camera` for the active path. */
  camera: { kx: number; ky: number };
  assets: RenderedAsset[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseAsset(v: unknown, i: number): RenderedAsset {
  if (!isRecord(v)) throw new Error(`manifest asset ${i} is not an object`);
  const { id, file, w, h, anchor, scale } = v;
  if (typeof id !== 'string' || !id) throw new Error(`manifest asset ${i} needs an id`);
  if (typeof file !== 'string' || !file) throw new Error(`manifest asset ${id} needs a file`);
  if (!isNum(w) || !isNum(h)) throw new Error(`manifest asset ${id} needs numeric w and h`);
  if (!isRecord(anchor) || !isNum(anchor['x']) || !isNum(anchor['y']))
    throw new Error(`manifest asset ${id} needs an anchor {x, y}`);
  if (!isNum(scale) || scale <= 0) throw new Error(`manifest asset ${id} needs a positive scale`);
  return { id, file, w, h, anchor: { x: anchor['x'], y: anchor['y'] }, scale };
}

/** Parse a manifest JSON value; throws with the offending field named. */
export function parseManifest(json: unknown): RenderedManifest {
  if (!isRecord(json)) throw new Error('manifest is not an object');
  if (json['version'] !== 1) throw new Error(`manifest version ${String(json['version'])} is not 1`);
  const camera = json['camera'];
  if (!isRecord(camera) || !isNum(camera['kx']) || !isNum(camera['ky']))
    throw new Error('manifest needs a camera {kx, ky}');
  const assets = json['assets'];
  if (!Array.isArray(assets)) throw new Error('manifest needs an assets array');
  return {
    version: 1,
    camera: { kx: camera['kx'], ky: camera['ky'] },
    assets: assets.map(parseAsset),
  };
}

export function assetById(m: RenderedManifest, id: string): RenderedAsset | undefined {
  return m.assets.find((a) => a.id === id);
}
