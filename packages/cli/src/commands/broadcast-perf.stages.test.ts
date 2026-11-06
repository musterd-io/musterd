import { describe, expect, it } from 'vitest';
import { parseOfficeStats } from './broadcast';
import { makePerfRecorder, meanStageMs, stageDelta, type PerfSample } from './broadcast-perf';
import { formatStages } from './stream';

/** Lane 01M6S5V5DY: the page's per-stage frame timings reach the machine log, per drawn frame. */
describe('per-stage frame timings', () => {
  it('parseOfficeStats keeps a well-formed profile and drops a malformed one', () => {
    const base = { ticks: 10, draws: 9, beats: 0 };
    expect(
      parseOfficeStats(
        JSON.stringify({ ...base, prof: { frames: 9, ms: { walls: 40, items: 'x' } } }),
      ),
    ).toEqual({ ...base, prof: { frames: 9, ms: { walls: 40 } } });
    expect(parseOfficeStats(JSON.stringify({ ...base, prof: { ms: {} } }))).toEqual(base);
    expect(parseOfficeStats(JSON.stringify(base))).toEqual(base);
  });

  it('stageDelta is the per-frame mean between two cumulative readings', () => {
    const a = { frames: 10, ms: { frame: 1000, walls: 100 } };
    const b = { frames: 20, ms: { frame: 2000, walls: 250, items: 50 } };
    expect(stageDelta(a, b)).toEqual({ frame: 100, walls: 15, items: 5 });
  });

  it('no reading, no frames drawn, or a reload resetting the counters gives nothing', () => {
    const a = { frames: 10, ms: { walls: 100 } };
    expect(stageDelta(undefined, a)).toBeUndefined();
    expect(stageDelta(a, a)).toBeUndefined();
    expect(stageDelta(a, { frames: 2, ms: { walls: 5 } })).toBeUndefined();
  });

  it('the recorder writes stageMs from the second sample on', async () => {
    const written: PerfSample[] = [];
    let t = 0;
    let office = { ticks: 10, draws: 10, prof: { frames: 10, ms: { frame: 1000, walls: 200 } } };
    const rec = makePerfRecorder({
      queueBytes: () => 0,
      emitted: () => 0,
      office: async () => office,
      cpu: async () => ({ chrome: 0, ffmpeg: 0, pipeline: 0, other: 0 }),
      load1: () => 0,
      now: () => t,
      write: (s) => written.push(s),
    });
    await rec.tick();
    t = 1000;
    office = { ticks: 20, draws: 20, prof: { frames: 20, ms: { frame: 2000, walls: 300 } } };
    await rec.tick();
    expect(written[0]!.stageMs).toBeUndefined();
    expect(written[1]!.stageMs).toEqual({ frame: 100, walls: 10 });
  });

  it('the summary means each stage and prints the frame first, then costliest first', () => {
    const s = (stageMs?: Record<string, number>) => ({ stageMs }) as unknown as PerfSample;
    const m = meanStageMs([
      s({ frame: 100, walls: 10, items: 30 }),
      s(),
      s({ frame: 80, walls: 20, items: 10 }),
    ]);
    expect(m).toEqual({ frame: 90, walls: 15, items: 20 });
    expect(formatStages(m!)).toBe('frame 90.0 · items 20.0 · walls 15.0');
    expect(meanStageMs([s()])).toBeUndefined();
  });
});
