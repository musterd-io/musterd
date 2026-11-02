import { roll, slotAt } from './ambientSeed';
import type { Fit } from './iso';
import { WINDOWS } from './layout';
import type { LightEnv } from './lighting';
import type { Weather } from './weather';
import { paneQuad, type ViewSetting } from './windowView';

/**
 * Life outside the windows (window views, lane 01M6ENGW2H): clouds drifting, the sun and moon on the
 * clock, stars after dark, and per setting one or two signature movers — a tram and a plane for the
 * city. Pure: `moversAt(…)` is a function of the instant, so every viewer sees the same tram at the
 * same time (`ambientSeed` rolls), and nothing allocates per frame beyond the list. Rare and slow by
 * design (spec anti-goal: the windows must never be the loudest thing in the room).
 *
 * Positions are in pane space: `x` along the wall 0→1, `y` down the pane 0→1.
 */
export interface Mover {
  kind: 'cloud' | 'sun' | 'moon' | 'star' | 'tram' | 'plane';
  which: 0 | 1;
  i: number;
  x: number;
  y: number;
  /** A size, in pane widths. */
  s: number;
  alpha: number;
}

const CLOUD_PERIOD_S = 140; // one pane-width per 140 s
const TRAM_SLOT_MS = 180_000;
const TRAM_S = 26;
const PLANE_SLOT_MS = 300_000;
const PLANE_S = 48;
const STARS: ReadonlyArray<[number, number]> = [
  [0.12, 0.22], [0.33, 0.12], [0.48, 0.3], [0.64, 0.18], [0.78, 0.26], [0.9, 0.1], [0.22, 0.4], [0.7, 0.42],
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function moversAt(
  view: ViewSetting,
  nowMs: number,
  env: LightEnv,
  weather: Weather,
  team: string,
): Mover[] {
  const out: Mover[] = [];
  const h = env.hours;
  const wet = weather === 'rain' || weather === 'snow';
  const night = clamp01(1 - env.daylight);
  const sec = nowMs / 1000;
  for (const which of [0, 1] as const) {
    for (let i = 0; i < WINDOWS.length; i++) {
      // clouds: two per pane, each with its own phase from a seeded roll, drifting left to right
      for (let n = 0; n < 2; n++) {
        const phase = roll(team, 0, `cloud-${which}-${i}-${n}`);
        const x = ((sec / CLOUD_PERIOD_S + phase + which * 0.37) % 1.3) - 0.15;
        out.push({ kind: 'cloud', which, i, x, y: 0.12 + n * 0.16, s: n === 0 ? 0.22 : 0.14, alpha: weather === 'clear' ? 0.85 : 0.6 });
      }
      // the sun, 6 → 19, on an arc; the moon mirrored by night
      if (!wet && h >= 6 && h <= 19) {
        const sx = (h - 6) / 13;
        out.push({ kind: 'sun', which, i, x: sx, y: 0.44 - Math.sin(sx * Math.PI) * 0.36, s: 0.09, alpha: 1 });
      }
      if (night > 0.2 && (h >= 19 || h <= 6)) {
        const mT = ((h + 5) % 24) / 11;
        out.push({ kind: 'moon', which, i, x: 0.8 - mT * 0.68, y: 0.12 + Math.cos(mT * Math.PI) * 0.08, s: 0.05, alpha: night });
      }
      if (night > 0.2) for (const [x, y] of STARS) out.push({ kind: 'star', which, i, x, y, s: 0.004, alpha: night });
      if (view === 'city') {
        // the tram, on wall 0 only: a 26 s crossing when the 3-minute slot rolls it
        if (which === 0) {
          const slot = slotAt(nowMs, TRAM_SLOT_MS);
          if (roll(team, slot, 'tram') < 0.35) {
            const tx = ((nowMs - slot * TRAM_SLOT_MS) / 1000) / TRAM_S;
            if (tx <= 1.1) out.push({ kind: 'tram', which, i, x: -0.1 + tx * 1.2, y: 0.9, s: 0.1, alpha: 1 });
          }
        }
        // the plane, at dusk and after, when the 5-minute slot rolls it; never in rain or snow
        if (!wet && env.daylight < 0.5) {
          const slot = slotAt(nowMs, PLANE_SLOT_MS);
          if (roll(team, slot, 'plane') < 0.25) {
            const px = ((nowMs - slot * PLANE_SLOT_MS) / 1000) / PLANE_S;
            if (px <= 1.3) out.push({ kind: 'plane', which, i, x: -0.3 + px * 1.4, y: 0.16, s: 0.03, alpha: 0.9 });
          }
        }
      }
    }
  }
  return out;
}

/** Is anything in motion? (Clouds always drift; a frame with movers needs the next frame.) */
export function moversMove(movers: readonly Mover[]): boolean {
  return movers.some((m) => m.kind === 'cloud' || m.kind === 'tram' || m.kind === 'plane');
}

/** Draw the movers, each clipped to its pane. Canvas primitives only; no images. */
export function drawMovers(ctx: CanvasRenderingContext2D, fit: Fit, movers: readonly Mover[]): void {
  for (const m of movers) {
    const q = paneQuad(fit, m.which, m.i);
    // pane-space → screen: x along the wall (q0→q1), y down the pane (q3→q0)
    const px = (x: number, y: number) => ({
      x: q[3].x + (q[1].x - q[0].x) * x + (q[0].x - q[3].x) * y,
      y: q[3].y + (q[1].y - q[0].y) * x + (q[0].y - q[3].y) * y,
    });
    const w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    const p = px(m.x, m.y);
    const r = m.s * w;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    ctx.lineTo(q[1].x, q[1].y);
    ctx.lineTo(q[2].x, q[2].y);
    ctx.lineTo(q[3].x, q[3].y);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = m.alpha;
    switch (m.kind) {
      case 'cloud': {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.32, 0, 0, Math.PI * 2);
        ctx.ellipse(p.x - r * 0.3, p.y - r * 0.14, r * 0.45, r * 0.4, 0, 0, Math.PI * 2);
        ctx.ellipse(p.x + r * 0.3, p.y - r * 0.08, r * 0.35, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sun': {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
        g.addColorStop(0, 'rgba(255,246,210,1)');
        g.addColorStop(0.45, 'rgba(255,214,120,0.9)');
        g.addColorStop(1, 'rgba(255,200,100,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'moon': {
        ctx.fillStyle = '#f3efe2';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'star': {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(p.x, p.y, Math.max(1, r), Math.max(1, r));
        break;
      }
      case 'tram': {
        ctx.fillStyle = '#e2503c';
        ctx.fillRect(p.x - r, p.y - r * 0.22, r * 2, r * 0.44);
        ctx.fillStyle = 'rgba(255,245,200,0.85)';
        ctx.fillRect(p.x - r * 0.8, p.y - r * 0.14, r * 1.6, r * 0.14);
        break;
      }
      case 'plane': {
        const tail = ctx.createLinearGradient(p.x - r * 10, p.y, p.x, p.y);
        tail.addColorStop(0, 'rgba(255,255,255,0)');
        tail.addColorStop(1, 'rgba(255,255,255,0.7)');
        ctx.fillStyle = tail;
        ctx.fillRect(p.x - r * 10, p.y, r * 10, Math.max(1, r * 0.12));
        ctx.fillStyle = '#dcdcdc';
        ctx.fillRect(p.x, p.y - r * 0.1, r, Math.max(1, r * 0.2));
        break;
      }
    }
    ctx.restore();
  }
}
