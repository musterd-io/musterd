/**
 * The rendered art for tests: the REAL manifest, dog spec and figure spec from `./assets/`, with fake
 * images in place of every file. A test that renders the room needs art — the painters that used to
 * stand in for it went with lane 01M5D8EJ40 — and the real specs mean a test sees the ids, anchors
 * and clips the room actually ships, not a stand-in that can drift from them.
 */
import type { LayerId } from './figure';
import dogJson from './assets/dog.json';
import figureJson from './assets/figure.json';
import manifestJson from './assets/manifest.json';
import type { RenderedAssets } from './assets';
import { parseFigureSpec } from './assets';
import { parseDogSpec } from './dogSheet';
import { parseManifest } from './manifest';

/** The one fake image every asset resolves to; a `drawImage` with it as the source is a blit of art. */
export const FAKE_IMG = { fake: true } as unknown as CanvasImageSource;

/** Every asset id in the shipped manifest. */
export const ART_IDS: readonly string[] = manifestJson.assets.map((a) => a.id);

/**
 * The art, with fake images. `ids` limits which assets are "loaded" (the rest are missing, as a failed
 * load leaves them); `dog` is in by default; the figure sheets are in only when asked — composing a
 * figure frame needs a canvas, which a node test has to stub (`document.createElement`).
 */
export function fakeArt(opts: { ids?: readonly string[]; dog?: boolean; figure?: boolean } = {}): RenderedAssets {
  const ids = opts.ids ?? ART_IDS;
  const art: RenderedAssets = {
    manifest: parseManifest(manifestJson),
    images: new Map(ids.map((id) => [id, FAKE_IMG])),
    missing: ART_IDS.filter((id) => !ids.includes(id)).map((id) => `${id}.webp`),
  };
  if (opts.dog !== false) art.dog = { spec: parseDogSpec(dogJson), sheet: FAKE_IMG };
  if (opts.figure) {
    const spec = parseFigureSpec(figureJson);
    art.figure = { spec, sheets: new Map(spec.layers.map((l) => [l.id as LayerId, FAKE_IMG])), scratch: {} };
  }
  return art;
}
