/**
 * The rendered-art flag and loader (office realism, plan Task 2).
 *
 * `?office=rendered` turns the pre-rendered path on for one page load (spec §7: the flag lives until
 * nick accepts the look on /live, then /broadcast, then it goes). Until the assets have decoded the
 * painted scene draws, and an asset that fails to load is listed in `missing` rather than failing
 * the load: a room with one painted desk among rendered ones beats a blank panel (Review Focus 1).
 */
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
