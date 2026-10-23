import { describe, expect, it } from 'vitest';
import { DIR8 } from './figureSheet';
import { DOG_ANIMS, dogCell, dogFrame, parseDogSpec } from './dogSheet';

const frames = { walk: 8, sit: 4, curl: 4, stretch: 6 } as const;
const total = DOG_ANIMS.reduce((n, a) => n + frames[a] * DIR8.length, 0);
let row = 0;
const anims = Object.fromEntries(DOG_ANIMS.map((a) => [a, { row: (row += 8) - 8, frames: frames[a], fps: 12, loop: a !== 'stretch' }]));
// every cell 10×10 at its own index, offset (2, 3) in a 66-wide frame
const cells = Array.from({ length: total }, (_, i) => [i, 0, 10, 10, 2, 3]).flat();
const json = { scale: 1.5, frame: { w: 66, h: 51 }, anchor: { x: 33, y: 39 }, anims, mirror: { S: 'E', W: 'N', SW: 'NE' }, file: 'office-art-dog.webp', cells };

describe('the rendered dog (lane 01M5D8EJ40)', () => {
  it('parses dog.json, and refuses one whose cells do not match its clips', () => {
    expect(parseDogSpec(json).anims.walk.frames).toBe(8);
    expect(() => parseDogSpec({ ...json, cells: cells.slice(6) })).toThrow(/cells/);
    expect(() => parseDogSpec({ ...json, file: '' })).toThrow(/file/);
  });

  it('a mode picks its clip: the trot from the gait phase, the stretch from its own beat, the rest loop', () => {
    const spec = parseDogSpec(json);
    expect(dogFrame(spec, { mode: 'walk', modeT: 0, phase: 2.5 }, 0)).toEqual({ anim: 'walk', frame: 4 });
    expect(dogFrame(spec, { mode: 'stretch', modeT: 99, phase: 0 }, 0)).toEqual({ anim: 'stretch', frame: 5 });
    expect(dogFrame(spec, { mode: 'sleep', modeT: 0, phase: 0 }, 1).anim).toBe('curl');
    expect(dogFrame(spec, { mode: 'sit', modeT: 0, phase: 0 }, 1).anim).toBe('sit');
  });

  it('reads the cell in clip, direction, frame order; a mirrored direction reads its source, flipped', () => {
    const spec = parseDogSpec(json);
    // sit is after walk's 8 × 8 cells; NE is direction 7
    expect(dogCell(spec, 'sit', 'NE', 1).sx).toBe(64 + 7 * 4 + 1);
    const e = dogCell(spec, 'walk', 'E', 0);
    const s = dogCell(spec, 'walk', 'S', 0);
    expect(s.sx).toBe(e.sx);
    expect(s.flip).toBe(true);
    expect(s.ox).toBe(66 - 2 - 10);
  });
});
