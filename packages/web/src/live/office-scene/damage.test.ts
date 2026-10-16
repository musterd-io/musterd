import { describe, expect, it } from 'vitest';
import { homePoses } from './actors';
import { makeRecorder, mergeRects, mustRun, planRepaint, type DeviceRect, type Unit } from './damage';
import { memberColor } from '../format';
import { fitFloor } from './iso';
import { computeLightEnv } from './lighting';
import { fmtOps, recordingCtx } from './recording-ctx';
import { renderScene } from './render';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';

const W = 1920;
const H = 1080;

function unitOf(draw: (c: CanvasRenderingContext2D) => void, before?: (c: CanvasRenderingContext2D) => void): Unit {
  const rec = makeRecorder({ width: W, height: H, pad: 0 });
  rec.reset([1, 0, 0, 1, 0, 0]);
  if (before) {
    rec.begin();
    before(rec.ctx);
    rec.end();
  }
  rec.begin();
  draw(rec.ctx);
  return rec.end();
}

const box = (x0: number, y0: number, x1: number, y1: number): DeviceRect => ({ x0, y0, x1, y1 });

describe('the recorder', () => {
  it('measures what a unit paints, in device pixels, through the transform', () => {
    const u = unitOf((c) => {
      c.setTransform(2, 0, 0, 2, 10, 0);
      c.fillStyle = '#f00';
      c.fillRect(5, 5, 10, 20);
    });
    expect(u.rect).toEqual(box(20, 10, 40, 50));
  });

  it('grows a stroke by its half-width, and a mitred one by the miter limit', () => {
    const line = (join: CanvasLineJoin) =>
      unitOf((c) => {
        c.lineWidth = 4;
        c.lineJoin = join;
        c.beginPath();
        c.moveTo(100, 100);
        c.lineTo(200, 100);
        c.stroke();
      }).rect;
    expect(line('round')).toEqual(box(98, 98, 202, 102));
    expect(line('miter')).toEqual(box(80, 80, 220, 120)); // 4/2 × miterLimit 10
  });

  it('a path that is built but never painted is not damage', () => {
    const u = unitOf((c) => {
      c.beginPath();
      c.rect(0, 0, 500, 500);
    });
    expect(u.rect).toBeNull();
  });

  it('keys the same calls the same, and any changed argument or inherited state differently', () => {
    const draw = (x: number) => (c: CanvasRenderingContext2D) => {
      c.fillStyle = '#0a0';
      c.fillRect(x, 10, 20, 20);
    };
    expect(unitOf(draw(10)).key).toBe(unitOf(draw(10)).key);
    expect(unitOf(draw(10)).key).not.toBe(unitOf(draw(10.0001)).key);
    // Same calls, but it reads a lineWidth the unit before left behind.
    const stroke = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(9, 9);
      c.stroke();
    };
    expect(unitOf(stroke, (c) => (c.lineWidth = 1)).key).not.toBe(unitOf(stroke, (c) => (c.lineWidth = 3)).key);
  });

  it('keys a gradient by its content, not its identity — a fresh gradient per frame is the same paint', () => {
    const draw = (stop: string) => (c: CanvasRenderingContext2D) => {
      const g = c.createRadialGradient(5, 5, 0, 5, 5, 9);
      g.addColorStop(0, stop);
      c.fillStyle = g;
      c.fillRect(0, 0, 10, 10);
    };
    expect(unitOf(draw('#fff')).key).toBe(unitOf(draw('#fff')).key);
    expect(unitOf(draw('#fff')).key).not.toBe(unitOf(draw('#000')).key);
  });

  it('a unit that restores what it set is neutral; one that leaks state is not', () => {
    expect(
      unitOf((c) => {
        c.save();
        c.globalAlpha = 0.5;
        c.fillRect(0, 0, 1, 1);
        c.restore();
      }).neutral,
    ).toBe(true);
    expect(unitOf((c) => (c.lineCap = 'round')).neutral).toBe(false);
    expect(unitOf((c) => c.save()).neutral).toBe(false);
  });

  it('says when a unit paints with a path it inherited', () => {
    const fillOnly = (c: CanvasRenderingContext2D) => c.fill();
    const leaveOpen = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.rect(0, 0, 9, 9);
    };
    expect(unitOf(fillOnly, leaveOpen).consumesPath).toBe(true);
    expect(
      unitOf((c) => {
        c.beginPath();
        c.rect(0, 0, 9, 9);
        c.fill();
      }, leaveOpen).consumesPath,
    ).toBe(false);
  });

  it('measures text with the real width it is given, both sides of the anchor', () => {
    const rec = makeRecorder({ width: W, height: H, pad: 0, measure: (_f, t) => t.length * 10 });
    rec.reset([1, 0, 0, 1, 0, 0]);
    rec.begin();
    rec.ctx.font = '20px x';
    rec.ctx.fillText('abc', 100, 100);
    expect(rec.end().rect).toEqual(box(70, 76, 130, 124));
    expect(rec.ctx.measureText('abcd').width).toBe(40);
  });
});

describe('planning a repaint', () => {
  const u = (key: number, rect: DeviceRect | null, neutral = true): Unit => ({ key, rect, neutral });

  it('a first frame is whole; an unchanged frame paints nothing', () => {
    const frame = [u(1, box(0, 0, 10, 10)), u(2, box(50, 50, 60, 60))];
    expect(planRepaint(null, frame, W, H).kind).toBe('full');
    expect(planRepaint(frame, frame, W, H).kind).toBe('none');
  });

  it('damage is the new paint and the paint it replaces — a member who moved, both places', () => {
    const before = [u(1, box(0, 0, 10, 10)), u(7, box(100, 100, 120, 140))];
    const after = [u(1, box(0, 0, 10, 10)), u(8, box(300, 100, 320, 140))];
    const plan = planRepaint(before, after, W, H);
    expect(plan.kind).toBe('rects');
    if (plan.kind !== 'rects') return;
    expect(plan.rects).toHaveLength(2);
    expect(plan.rects).toEqual(expect.arrayContaining([box(100, 100, 120, 140), box(300, 100, 320, 140)]));
  });

  it('two identical units are counted, so losing one of them is still damage', () => {
    const r = box(5, 5, 9, 9);
    const plan = planRepaint([u(3, r), u(3, r)], [u(3, r)], W, H);
    expect(plan).toEqual({ kind: 'rects', rects: [r], area: 16 });
  });

  it('past the ceiling the frame paints whole', () => {
    const big = box(0, 0, W, H * 0.6);
    expect(planRepaint([u(1, big)], [u(2, big)], W, H).kind).toBe('full');
  });

  it('any unit that consumes an inherited path forces a whole frame', () => {
    const before = [u(1, box(0, 0, 9, 9))];
    expect(planRepaint(before, [{ ...u(2, box(0, 0, 9, 9)), consumesPath: true }], W, H).kind).toBe('full');
  });

  it('merging folds every overlap and keeps the count under the cap', () => {
    const merged = mergeRects([box(0, 0, 10, 10), box(5, 5, 15, 15), box(100, 0, 110, 10)]);
    expect(merged).toEqual(expect.arrayContaining([box(0, 0, 15, 15), box(100, 0, 110, 10)]));
    const many = Array.from({ length: 40 }, (_, i) => box(i * 30, 0, i * 30 + 10, 10));
    const capped = mergeRects(many, 8);
    expect(capped.length).toBeLessThanOrEqual(8);
    for (const r of many) expect(capped.some((c) => c.x0 <= r.x0 && c.x1 >= r.x1)).toBe(true);
  });

  it('the paint pass skips a neutral unit away from the damage, and never a leaky one', () => {
    const rects = [box(0, 0, 10, 10)];
    expect(mustRun(u(1, box(50, 50, 60, 60)), rects)).toBe(false);
    expect(mustRun(u(1, box(5, 5, 60, 60)), rects)).toBe(true);
    expect(mustRun(u(1, box(50, 50, 60, 60), false), rects)).toBe(true);
    expect(mustRun(u(1, null), rects)).toBe(false);
  });
});

describe('renderScene through the unit hook', () => {
  function room() {
    const node = (name: string): OfficeNode =>
      ({
        name,
        kind: 'agent',
        service: false,
        woken: false,
        presence: 'online',
        activity: 'working',
        posture: 'working',
        state: null,
        color: memberColor(name, 'agent'),
        role: '',
        surface: null,
        model: null,
        workTitle: null,
        workSource: null,
        laneState: null,
        moreLanes: 0,
        dnd: false,
        offline_reason: null,
        last_seen_at: null,
        created_at: null,
        sponsored_by: null,
      }) as OfficeNode;
    const nodes = ['ada', 'lin', 'fen', 'gus'].map(node);
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const placements = assignSeats(nodes);
    return { placements, byName, poses: homePoses(placements, byName) };
  }
  const fit = fitFloor(W, H);
  const env = computeLightEnv(21, true); // night: the veil, the lamps and each member's glow

  it('running every unit paints exactly what the plain render paints', () => {
    const { placements, byName, poses } = room();
    const a = recordingCtx();
    renderScene(a.ctx, fit, placements, byName, poses, 3, 'revive', env);
    const b = recordingCtx();
    let n = 0;
    renderScene(b.ctx, fit, placements, byName, poses, 3, 'revive', env, null, undefined, null, null, null, {
      units: {
        run(draw) {
          n++;
          draw();
        },
      },
    });
    expect(fmtOps(b.ops)).toEqual(fmtOps(a.ops));
    expect(n).toBeGreaterThan(50); // the room is cut into many units, not one
  });

  it('the measure pass and the paint pass see the same sequence, unit for unit', () => {
    const { placements, byName, poses } = room();
    const rec = makeRecorder({ width: W, height: H });
    rec.reset([1, 0, 0, 1, 0, 0]);
    const units: Unit[] = [];
    renderScene(rec.ctx, fit, placements, byName, poses, 3, 'revive', env, null, undefined, null, null, null, {
      units: {
        run(draw) {
          rec.begin();
          draw();
          units.push(rec.end());
        },
      },
    });
    let i = 0;
    renderScene(recordingCtx().ctx, fit, placements, byName, poses, 3, 'revive', env, null, undefined, null, null, null, {
      units: { run: () => void i++ },
    });
    expect(i).toBe(units.length);
    // Each member's night glow is its own unit, so one walker damages one pool, not the veiled room.
    const veil = units.filter((u) => u.rect && u.rect.x1 - u.rect.x0 >= W && u.rect.y1 - u.rect.y0 >= H);
    expect(veil.length).toBeLessThanOrEqual(2); // the veil and the vignette
  });
});
