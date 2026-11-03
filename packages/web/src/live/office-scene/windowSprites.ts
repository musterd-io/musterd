import { roll, slotAt } from './ambientSeed';
import { WALL_H, type Fit } from './iso';
import { WINDOWS } from './layout';
import type { LightEnv } from './lighting';
import type { Weather } from './weather';
import { WALL_EDGES, wallPt, paneQuad, type ViewSetting } from './windowView';

/**
 * Life outside the windows (window views, lane 01M6ENGW2H): clouds drifting, the sun and moon on the
 * clock, stars after dark, and per setting one or two signature movers — a tram and a plane for the
 * city; a boat, gulls and the lighthouse beacon for the coast; a hawk and the cabin's glow for the
 * mountain (increment 2, lane 01M6ENH3T5). Pure: `moversAt(…)` is a function of the instant, so every viewer sees the same tram at the
 * same time (`ambientSeed` rolls), and nothing allocates per frame beyond the list. Rare and slow by
 * design (spec anti-goal: the windows must never be the loudest thing in the room).
 *
 * Positions are in pane space: `x` along the wall 0→1, `y` down the pane 0→1.
 */
export interface Mover {
  kind: 'cloud' | 'sun' | 'moon' | 'star' | 'tram' | 'plane' | 'boat' | 'gull' | 'beacon' | 'hawk' | 'cabin';
  which: 0 | 1;
  i: number;
  x: number;
  y: number;
  /** A size, in pane widths. */
  s: number;
  alpha: number;
  /** Clouds only: how far toward the night's slate the white goes, 0 by day → ~0.8 at full night. */
  shade?: number;
}

const CLOUD_PERIOD_S = 140; // one pane-width per 140 s
const TRAM_SLOT_MS = 180_000;
const TRAM_S = 26;
const PLANE_SLOT_MS = 300_000;
const PLANE_S = 48;
const BOAT_SLOT_MS = 240_000;
const BOAT_S = 90;
const GULL_SLOT_MS = 30_000;
const GULL_S = 11;
const BEACON_PERIOD_MS = 4_000;
const BEACON_ON_MS = 300;
const HAWK_S = 40;
/** Where `exterior.py` put the lighthouse lantern and the cabin windows, in pane space (wall 0). */
export const LIGHTHOUSE = { which: 0, i: 1, x: 0.6, y: 0.44 } as const;
export const CABIN = { which: 0, i: 0, x: 0.56, y: 0.8 } as const;
const STARS: ReadonlyArray<[number, number]> = [
  [0.12, 0.22], [0.33, 0.12], [0.48, 0.3], [0.64, 0.18], [0.78, 0.26], [0.9, 0.1], [0.22, 0.4], [0.7, 0.42],
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The four panes as one strip of sky, in screen order left to right: the left wall's far window, its
 *  near one, then the right wall's near and far. On the left wall `+t` runs screen-left, so its far
 *  window (`i` 1) is the leftmost. */
const SKY_PANES: ReadonlyArray<{ which: 0 | 1; i: number }> = [
  { which: 0, i: 1 },
  { which: 0, i: 0 },
  { which: 1, i: 0 },
  { which: 1, i: 1 },
];

/** Where a body `f` of the way across the sky (0 → 1) shows: one pane, and its x in that pane. */
export function skyPane(f: number): { which: 0 | 1; i: number; x: number } {
  const s = clamp01(f) * SKY_PANES.length;
  const k = Math.min(SKY_PANES.length - 1, Math.floor(s));
  return { ...SKY_PANES[k]!, x: s - k };
}

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
        out.push({ kind: 'cloud', which, i, x, y: 0.12 + n * 0.16, s: n === 0 ? 0.22 : 0.14, alpha: weather === 'clear' ? 0.85 : 0.6, shade: night * 0.8 });
      }
      // the sun, 6 → 19, and the moon by night: each in ONE pane at a time (nick, 2026-11-03: "i see the
      // sun in all 4 windows … in real life that wouldnt be possible"). It is at infinity, so from inside
      // it shows through one window only; over the day it crosses the four, left to right on screen. Its
      // noon peak (y 0.23) stays under the right wall's roman shades, which fold over the top fifth.
      if (!wet && h >= 6 && h <= 19) {
        const sx = (h - 6) / 13;
        const at = skyPane(sx);
        if (at.which === which && at.i === i) out.push({ kind: 'sun', which, i, x: at.x, y: 0.5 - Math.sin(sx * Math.PI) * 0.27, s: 0.09, alpha: 1 });
      }
      // the moon and stars only through a clear-enough sky: rain and snow hide both, cloud the stars
      if (!wet && night > 0.2 && (h >= 19 || h <= 6)) {
        const mT = ((h + 5) % 24) / 11;
        const at = skyPane(mT);
        if (at.which === which && at.i === i) out.push({ kind: 'moon', which, i, x: at.x, y: 0.12 + Math.cos(mT * Math.PI) * 0.08, s: 0.05, alpha: night });
      }
      if (weather === 'clear' && night > 0.2) for (const [x, y] of STARS) out.push({ kind: 'star', which, i, x, y, s: 0.004, alpha: night });
      if (view === 'coast') {
        // the boat, on wall 1: a 90 s crossing along the horizon when the 4-minute slot rolls it
        if (which === 1) {
          const slot = slotAt(nowMs, BOAT_SLOT_MS);
          if (roll(team, slot, 'boat') < 0.4) {
            const bx = ((nowMs - slot * BOAT_SLOT_MS) / 1000) / BOAT_S;
            if (bx <= 1.15) out.push({ kind: 'boat', which, i, x: -0.15 + bx * 1.3, y: 0.62, s: 0.05, alpha: 1 });
          }
        }
        // two gulls, 11 s arcs, by day and in clear weather, when the 30 s slot rolls them
        if (weather === 'clear' && env.daylight > 0.3) {
          const slot = slotAt(nowMs, GULL_SLOT_MS);
          if (roll(team, slot, `gull-${which}-${i}`) < 0.5) {
            const gt = ((nowMs - slot * GULL_SLOT_MS) / 1000) / GULL_S;
            if (gt <= 1.1) {
              const dir = roll(team, slot, 'gull-dir') < 0.5 ? 1 : -1;
              for (let n = 0; n < 2; n++) {
                const x = dir > 0 ? -0.1 + gt * 1.2 : 1.1 - gt * 1.2;
                out.push({ kind: 'gull', which, i, x: x + n * 0.06 * dir, y: 0.3 + n * 0.05 + Math.sin(gt * Math.PI * 2 + n) * 0.04, s: 0.02, alpha: 0.9 });
              }
            }
          }
        }
        // the lighthouse beacon: a 0.3 s flash every 4 s, once it is dark enough for stars
        if (night > 0.2 && which === LIGHTHOUSE.which && i === LIGHTHOUSE.i && nowMs % BEACON_PERIOD_MS < BEACON_ON_MS) {
          out.push({ kind: 'beacon', which, i, x: LIGHTHOUSE.x, y: LIGHTHOUSE.y, s: 0.06, alpha: night });
        }
      }
      if (view === 'mountain') {
        // the hawk, over wall 1's wide pane: a slow 40 s circle above the ridges by day
        if (which === 1 && i === 1 && env.daylight > 0.3 && !wet) {
          const ph = ((nowMs / 1000) % HAWK_S) / HAWK_S * Math.PI * 2;
          out.push({ kind: 'hawk', which, i, x: 0.5 + Math.cos(ph) * 0.22, y: 0.32 + Math.sin(ph) * 0.07, s: 0.018, alpha: 0.85 });
        }
        // the cabin's windows: a warm glow after dark, over the plate's lit quads
        if (night > 0.2 && which === CABIN.which && i === CABIN.i) {
          out.push({ kind: 'cabin', which, i, x: CABIN.x, y: CABIN.y, s: 0.05, alpha: night });
        }
      }
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
  return movers.some((m) => m.kind !== 'sun' && m.kind !== 'moon' && m.kind !== 'star' && m.kind !== 'cabin');
}

/**
 * Clip to the glass: the lights between the mullions, inside the frame (review I1 — a mover drawn
 * over the whole opening painted across the mullions and the frame strips the shell holds). Matches
 * `scene.py` `wall()`: frame strips ±0.004 of t, 3 units top and bottom, mullions ±0.0015 of t.
 */
function clipGlass(ctx: CanvasRenderingContext2D, fit: Fit, which: 0 | 1, i: number): void {
  const w = WINDOWS[i]!;
  const edge = WALL_EDGES[which]!;
  const inset = 3 / WALL_H;
  const u0 = w.u0 + inset;
  const u1 = w.u1 - inset;
  ctx.beginPath();
  for (let k = 0; k < w.mullions; k++) {
    const a = (k === 0 ? w.t0 + 0.004 : w.t0 + ((w.t1 - w.t0) * k) / w.mullions + 0.0015);
    const b = (k === w.mullions - 1 ? w.t1 - 0.004 : w.t0 + ((w.t1 - w.t0) * (k + 1)) / w.mullions - 0.0015);
    const p0 = wallPt(edge, a, u0, fit);
    const p1 = wallPt(edge, b, u0, fit);
    const p2 = wallPt(edge, b, u1, fit);
    const p3 = wallPt(edge, a, u1, fit);
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
  }
  ctx.clip();
}


/** Draw the movers, each clipped to its pane's glass. Canvas primitives only; no images. */
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
    clipGlass(ctx, fit, m.which, m.i);
    ctx.globalAlpha = m.alpha;
    switch (m.kind) {
      case 'cloud': {
        // white by day, toward a moonlit slate by night — a white cloud at midnight read as a lamp
        const k = m.shade ?? 0;
        ctx.fillStyle = `rgb(${Math.round(255 - 185 * k)},${Math.round(255 - 175 * k)},${Math.round(255 - 145 * k)})`;
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
      case 'boat': {
        // a hull and a white sail, leaning with the wind
        ctx.fillStyle = '#2b3340';
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x + r * 0.7, p.y + r * 0.35);
        ctx.lineTo(p.x - r * 0.7, p.y + r * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#f6f3ea';
        ctx.beginPath();
        ctx.moveTo(p.x - r * 0.1, p.y - r * 0.05);
        ctx.lineTo(p.x - r * 0.1, p.y - r * 1.6);
        ctx.lineTo(p.x + r * 0.8, p.y - r * 0.05);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'gull': {
        // the classic two-stroke bird
        ctx.strokeStyle = '#f4f4f0';
        ctx.lineWidth = Math.max(1, r * 0.18);
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y);
        ctx.quadraticCurveTo(p.x - r * 0.5, p.y - r * 0.6, p.x, p.y);
        ctx.quadraticCurveTo(p.x + r * 0.5, p.y - r * 0.6, p.x + r, p.y);
        ctx.stroke();
        break;
      }
      case 'beacon': {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
        g.addColorStop(0, 'rgba(255,250,220,1)');
        g.addColorStop(0.3, 'rgba(255,230,150,0.8)');
        g.addColorStop(1, 'rgba(255,220,120,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        // the sweep: a faint fan to the right
        ctx.fillStyle = 'rgba(255,240,190,0.18)';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + r * 9, p.y - r * 1.6);
        ctx.lineTo(p.x + r * 9, p.y + r * 1.6);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'hawk': {
        ctx.strokeStyle = '#3a3630';
        ctx.lineWidth = Math.max(1, r * 0.25);
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y + r * 0.2);
        ctx.quadraticCurveTo(p.x - r * 0.4, p.y - r * 0.5, p.x, p.y);
        ctx.quadraticCurveTo(p.x + r * 0.4, p.y - r * 0.5, p.x + r, p.y + r * 0.2);
        ctx.stroke();
        break;
      }
      case 'cabin': {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.6);
        g.addColorStop(0, 'rgba(255,214,130,0.55)');
        g.addColorStop(1, 'rgba(255,200,110,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
        ctx.fill();
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
