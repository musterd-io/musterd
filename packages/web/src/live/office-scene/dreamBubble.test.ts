import { describe, expect, it } from 'vitest';
import { headBox } from './plateLayout';
import { DREAM_LAMP, dreamBubble, dreamBubbleLayout } from './render';

describe('a dreaming seat (goal dreaming, lane 5)', () => {
  it('turns its lamp down rather than off', () => {
    expect(DREAM_LAMP).toBeGreaterThan(0);
    expect(DREAM_LAMP).toBeLessThan(1);
  });

  it('floats gently and stays bounded', () => {
    for (let t = 0; t < 10; t += 0.1) {
      const { bob, dots } = dreamBubble(t);
      expect(Math.abs(bob)).toBeLessThanOrEqual(1.6);
      for (const a of dots) {
        expect(a).toBeGreaterThanOrEqual(0.35);
        expect(a).toBeLessThanOrEqual(0.9);
      }
    }
  });

  // The thought rises: across one breath the brightest dot moves head → cloud, never backwards.
  it('lights the trail dots one after another, from the head up', () => {
    const brightest = (t: number) => {
      const { dots } = dreamBubble(t);
      return dots.indexOf(Math.max(...dots));
    };
    expect([0, 1.1, 2.2].map(brightest)).toEqual([0, 1, 2]);
  });

  // The nameplate is DOM over the canvas, hung bottom-centre on the head anchor, so anything the
  // canvas draws above the anchor near the head is under the plate. The 2026-10-01 stage capture had
  // the cloud straddling that line at 720p, read as a crumb under "Bo sonnet 4.5".
  describe('at stage size', () => {
    const at = { x: 400, y: 300 };
    const STAGE_720 = 0.67; // fit.scale read off the 1280×720 capture (cloud 30 units → 20 css px)
    const bobs = [-1.6, 0, 1.6];

    it('keeps the whole bubble below the nameplate line', () => {
      for (const bob of bobs) {
        const { box } = dreamBubbleLayout(at, STAGE_720, bob);
        expect(box.y0).toBeGreaterThan(at.y);
      }
    });

    it('keeps the cloud off the face', () => {
      const face = headBox(at, STAGE_720);
      for (const bob of bobs) {
        const { cloud } = dreamBubbleLayout(at, STAGE_720, bob);
        expect(cloud.cx - cloud.halfW).toBeGreaterThan(face.x1);
      }
    });

    it('draws a cloud big enough to read across a room', () => {
      const { cloud } = dreamBubbleLayout(at, STAGE_720, 0);
      expect(cloud.halfW * 2).toBeGreaterThanOrEqual(30);
    });
  });

  it('is the same at the same time, so a cached frame never jumps', () => {
    expect(dreamBubble(4.2)).toEqual(dreamBubble(4.2));
    // Negative scene time (a clock reset) wraps into the same breath rather than going NaN.
    expect(dreamBubble(-1).bob).toBeCloseTo(dreamBubble(-1 + 3.2).bob, 9);
  });
});
