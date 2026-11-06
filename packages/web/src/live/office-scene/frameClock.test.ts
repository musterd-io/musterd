import { describe, expect, it } from 'vitest';
import { MAX_FRAME_DT_S, frameDt } from './frameClock';

/** Wall seconds against room seconds over one second of frames drawn at `fps`. */
function roomSecondsPerWallSecond(fps: number): number {
  const gap = 1000 / fps;
  let room = 0;
  for (let i = 0; i < fps; i++) room += frameDt(gap);
  return room;
}

describe('the office keeps wall time on a slow page (lane 01M6S4FE8C)', () => {
  it('keeps wall time at every draw rate the stream box has been measured at, and down to 4 a second', () => {
    for (const fps of [60, 30, 20, 17, 15, 10, 5, 4]) {
      expect(roomSecondsPerWallSecond(fps), `${fps} draws/s`).toBeCloseTo(1, 6);
    }
  });

  it('the old 50 ms cap is what slowed the stream: 15 draws a second ran the room at 75%', () => {
    let room = 0;
    for (let i = 0; i < 15; i++) room += Math.min(0.05, 1000 / 15 / 1000);
    expect(room).toBeCloseTo(0.75, 6);
  });

  it('still refuses to teleport after a long stall', () => {
    expect(frameDt(3000)).toBe(MAX_FRAME_DT_S);
    expect(MAX_FRAME_DT_S).toBe(0.25);
  });

  it('a nonsense or zero gap advances nothing', () => {
    expect(frameDt(0)).toBe(0);
    expect(frameDt(-5)).toBe(0);
    expect(frameDt(Number.NaN)).toBe(0);
  });
});
