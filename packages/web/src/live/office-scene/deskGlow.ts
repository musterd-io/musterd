/**
 * A lane done's glow (goal bell spec 2026-11-03): a small warm pool over the closer's desk for a
 * second and a half, with the ding. Nobody gets up; the desk just brightens and settles.
 */
import type { Pt } from './iso';

/** How long the glow lasts, seconds. */
export const DESK_GLOW_S = 1.5;

/** The glow's strength `sinceS` seconds after the lane closed: up to 0.5 by 0.2 s, back to 0 by 1.5 s. */
export function deskGlowAlpha(sinceS: number): number {
  if (!(sinceS >= 0) || sinceS >= DESK_GLOW_S) return 0;
  if (sinceS < 0.2) return 0.5 * (sinceS / 0.2);
  const k = (sinceS - 0.2) / (DESK_GLOW_S - 0.2);
  return 0.5 * (1 - k) * (1 - k);
}

/** Add the glow over a desk top at `at` (screen px), `scale` px per unit. Additive, like the lamps. */
export function drawDeskGlow(ctx: CanvasRenderingContext2D, at: Pt, scale: number, alpha: number): void {
  if (alpha <= 0) return;
  const r = 46 * scale;
  const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
  g.addColorStop(0, `rgba(255, 206, 130, ${alpha})`);
  g.addColorStop(1, 'rgba(255, 206, 130, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, r, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
