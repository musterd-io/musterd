/**
 * Blit one rendered asset at a floor position (office realism, plan Task 3).
 *
 * The one place a rendered image meets the projection: the asset's anchor (its floor point in
 * source px) is put on `project(lx, ly, fit)`, and the image is sized by `fit.scale / asset.scale`
 * — the panel's px-per-floor-unit over the render's. Everything about WHERE and in WHAT ORDER an
 * item paints stays with the depth items that call this; a rendered desk sorts exactly where the
 * painted one did.
 */
import { type Fit, project } from '../iso';
import type { RenderedAsset } from './manifest';

export function blitAsset(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  a: RenderedAsset,
  img: CanvasImageSource,
  lx: number,
  ly: number,
  alpha = 1,
): void {
  const k = fit.scale / a.scale;
  const at = project(lx, ly, fit);
  const dx = at.x - a.anchor.x * k;
  const dy = at.y - a.anchor.y * k;
  if (alpha >= 1) {
    ctx.drawImage(img, dx, dy, a.w * k, a.h * k);
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, dx, dy, a.w * k, a.h * k);
  ctx.restore();
}
