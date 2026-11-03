import { describe, expect, it } from 'vitest';

import { drawPainting, paintingQuad, printOpening } from './paintings';
import { recordingCtx } from './recording-ctx';

describe('printOpening', () => {
  it('fills a thick frame up to a 2-unit mat', () => {
    const o = printOpening(54, 42, 'thick');
    expect(o.hw).toBeCloseTo(21.76, 2);
    expect(o.hh).toBeCloseTo(15.76, 2);
  });
  it('fills a thin frame up to a 2-unit mat', () => {
    const o = printOpening(22, 30, 'thin');
    expect(o.hw).toBeCloseTo(8.45, 2);
    expect(o.hh).toBeCloseTo(12.45, 2);
  });
  it('prints an unframed canvas edge to edge', () => {
    expect(printOpening(26, 26, 'none')).toEqual({ hw: 13, hh: 13 });
  });
});

describe('paintingQuad', () => {
  const p = (a: number, b: number) => ({ x: a, y: -b });
  it("puts the image's top-left at the wall's -a end on the right wall", () => {
    expect(paintingQuad(p, 10, 5, false)[0]).toEqual({ x: -10, y: -5 });
  });
  it('flips it on the back-left wall, where +t runs screen-left', () => {
    expect(paintingQuad(p, 10, 5, true)[0]).toEqual({ x: 10, y: -5 });
  });
});

describe('drawPainting', () => {
  const quad = paintingQuad((a, b) => ({ x: a, y: -b }), 10, 5, false);
  it('draws nothing before the image arrives', () => {
    const { ctx, ops } = recordingCtx();
    drawPainting(ctx, undefined, quad, 100, 50, '#ffffff');
    expect(ops).toEqual([]);
  });
  it('draws the image once, then multiplies the room light over it', () => {
    const { ctx, ops } = recordingCtx();
    drawPainting(ctx, {} as CanvasImageSource, quad, 100, 50, '#c0a080');
    const names = ops.map((o) => o.name);
    expect(names.filter((n) => n === 'drawImage')).toHaveLength(1);
    expect(names.indexOf('transform')).toBeLessThan(names.indexOf('drawImage'));
    expect(ops).toContainEqual({ name: 'set:globalCompositeOperation', args: ['multiply'] });
    expect(ops).toContainEqual({ name: 'set:fillStyle', args: ['#c0a080'] });
    expect(names.indexOf('fillRect')).toBeGreaterThan(names.indexOf('drawImage'));
  });
});
