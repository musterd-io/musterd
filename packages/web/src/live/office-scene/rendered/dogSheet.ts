/**
 * The rendered office dog (office realism increment 4, lane 01M5D8EJ40): `dog.json` and its one sheet,
 * `office-art-dog.webp`, written by `render.py --dog` (art source `packages/web/art/office/dog.py`).
 *
 * The dog is one image in its own colours — nothing is tinted — so this is the figure's sheet logic
 * cut down: a clip per pet mode, eight directions of which three are mirrors, cells cropped to their
 * own pixels and packed into one atlas.
 */
import type { PetState } from '../pet';
import { DIR8, type Dir8, dir8FromHeading } from './figureSheet';

export type DogAnim = 'walk' | 'sit' | 'curl' | 'stretch';
export const DOG_ANIMS: readonly DogAnim[] = ['walk', 'sit', 'curl', 'stretch'];

export interface DogSpec {
  scale: number;
  frame: { w: number; h: number };
  anchor: { x: number; y: number };
  anims: Record<DogAnim, { row: number; frames: number; fps: number; loop: boolean }>;
  mirror: Partial<Record<Dir8, Dir8>>;
  file: string;
  /** Six per cell — x, y, w, h in the atlas, ox, oy inside the frame — in DOG_ANIMS, then DIR8, then frame order. */
  cells: number[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse `dog.json`; throws with the offending field named. */
export function parseDogSpec(json: unknown): DogSpec {
  if (!isRecord(json)) throw new Error('dog.json is not an object');
  const { scale, frame, anchor, anims, mirror, file, cells } = json;
  if (!isNum(scale) || scale <= 0) throw new Error('dog.json needs a positive scale');
  if (!isRecord(frame) || !isNum(frame['w']) || !isNum(frame['h'])) throw new Error('dog.json needs frame {w, h}');
  if (!isRecord(anchor) || !isNum(anchor['x']) || !isNum(anchor['y'])) throw new Error('dog.json needs anchor {x, y}');
  if (typeof file !== 'string' || !file) throw new Error('dog.json needs a file');
  if (!Array.isArray(cells) || cells.some((n) => !isNum(n))) throw new Error('dog.json cells is not a number list');
  if (!isRecord(anims)) throw new Error('dog.json needs anims');
  const out = {} as DogSpec['anims'];
  for (const a of DOG_ANIMS) {
    const v = anims[a];
    if (!isRecord(v) || !isNum(v['row']) || !isNum(v['frames']) || !isNum(v['fps']) || typeof v['loop'] !== 'boolean')
      throw new Error(`dog.json anim ${a} needs {row, frames, fps, loop}`);
    out[a] = { row: v['row'], frames: v['frames'], fps: v['fps'], loop: v['loop'] };
  }
  const mirrorOk = mirror === undefined || (isRecord(mirror) && Object.entries(mirror).every(([k, v]) => (DIR8 as readonly unknown[]).includes(k) && (DIR8 as readonly unknown[]).includes(v)));
  if (!mirrorOk) throw new Error('dog.json mirror is not a direction map');
  const total = DOG_ANIMS.reduce((n, a) => n + out[a].frames * DIR8.length, 0);
  if (cells.length !== total * 6) throw new Error(`dog.json has ${cells.length / 6} cells, the clips need ${total}`);
  return {
    scale,
    frame: { w: frame['w'], h: frame['h'] },
    anchor: { x: anchor['x'], y: anchor['y'] },
    anims: out,
    mirror: (mirror ?? {}) as DogSpec['mirror'],
    file,
    cells: cells as number[],
  };
}

/** The clip and frame for the pet as it is now: the trot from its gait phase, a stretch over its own beat, the rest looping. */
export function dogFrame(spec: DogSpec, pet: Pick<PetState, 'mode' | 'modeT' | 'phase'>, t: number): { anim: DogAnim; frame: number } {
  const anim: DogAnim = pet.mode === 'walk' ? 'walk' : pet.mode === 'sit' ? 'sit' : pet.mode === 'stretch' ? 'stretch' : 'curl';
  const a = spec.anims[anim];
  if (anim === 'walk') return { anim, frame: Math.floor((((pet.phase % 1) + 1) % 1) * a.frames) % a.frames };
  if (anim === 'stretch') return { anim, frame: Math.min(a.frames - 1, Math.floor((pet.modeT * a.fps) / 4)) };
  // sit and curl loop slowly: a tail sweep, a breath
  return { anim, frame: Math.floor(t * 3) % a.frames };
}

export interface DogCell {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  ox: number;
  oy: number;
  flip: boolean;
}

/** The atlas cell for (anim, dir, frame): a mirrored direction reads its source flipped about the frame's centre line. */
export function dogCell(spec: DogSpec, anim: DogAnim, dir: Dir8, frame: number): DogCell {
  const src = spec.mirror[dir];
  let base = 0;
  for (const a of DOG_ANIMS) {
    if (a === anim) break;
    base += spec.anims[a].frames * DIR8.length;
  }
  const i = base + DIR8.indexOf(src ?? dir) * spec.anims[anim].frames + frame;
  const [sx = 0, sy = 0, sw = 0, sh = 0, ox = 0, oy = 0] = spec.cells.slice(i * 6, i * 6 + 6);
  return src ? { sx, sy, sw, sh, ox: spec.frame.w - ox - sw, oy, flip: true } : { sx, sy, sw, sh, ox, oy, flip: false };
}

/** The dog's direction from its heading, with the figure's hysteresis so a diagonal does not flicker. */
export function dogDir(heading: number, prev?: Dir8): Dir8 {
  return dir8FromHeading(heading, prev);
}
