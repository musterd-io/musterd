import { describe, expect, it } from 'vitest';
import type { Arrival } from './arrivals';
import {
  BACKLOG_MAX,
  createWelcomeWagon,
  MAX_WAIT_MS,
  enqueueArrivals,
  stepWelcomeWagon,
  welcomePlaying,
  WAVE_MS,
  type WagonDeps,
  type WelcomeBeat,
} from './welcomeWagon';

const a = (name: string, over: Partial<Arrival> = {}): Arrival => ({
  kind: 'created',
  name,
  memberKind: 'human',
  hue: 40,
  sponsor: null,
  online: false,
  ...over,
});
const deps = (over: Partial<WagonDeps> = {}): WagonDeps => ({
  busy: false,
  reduced: false,
  present: () => true,
  hasDesk: () => true,
  seated: () => true,
  atMark: () => true,
  ...over,
});
/** Step from t0 to t1 (ms) in 50 ms frames, collecting every beat with the time it fired. */
function run(
  s: ReturnType<typeof createWelcomeWagon>,
  t0: number,
  t1: number,
  d: WagonDeps = deps(),
) {
  const out: { at: number; beat: WelcomeBeat }[] = [];
  for (let t = t0; t <= t1; t += 50)
    for (const beat of stepWelcomeWagon(s, t, d)) out.push({ at: t - t0, beat });
  return out;
}
const types = (xs: { beat: WelcomeBeat }[]) => xs.map((x) => x.beat.type);

describe('welcomeWagon — Act 1 (created, offline)', () => {
  it('waits for the wave window, then rings, labels, sends the wagon and captions', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { sponsor: 'nick' })], 0);
    expect(stepWelcomeWagon(s, WAVE_MS - 1, deps())).toEqual([]); // the wave is still forming
    const beats = run(s, WAVE_MS, WAVE_MS + 5_000);
    expect(types(beats)).toEqual(['ring', 'say', 'label', 'wagon', 'caption']);
    expect(beats.find((b) => b.beat.type === 'say')!.beat).toEqual({
      type: 'say',
      text: 'oh! someone new: ada',
    });
    expect(beats.find((b) => b.beat.type === 'caption')!.beat).toEqual({
      type: 'caption',
      text: 'ada was added to the team · by nick',
      who: 'ada',
    });
    expect(welcomePlaying(s)).toBe(false);
  });

  it('with no free desk there is no delivery — the wall takes no polaroid (2026-10-12)', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 5_000, deps({ hasDesk: () => false }));
    expect(types(beats)).not.toContain('wagon');
    expect(types(beats)).toContain('caption');
  });

  it('several created in one wave: one ring, their labels, one plural caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada'), a('lin')], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 5_000);
    expect(types(beats).filter((x) => x === 'ring')).toHaveLength(1);
    expect(types(beats).filter((x) => x === 'label')).toHaveLength(2);
    expect(beats.find((b) => b.beat.type === 'caption')!.beat).toMatchObject({
      text: '2 members were added to the team',
    });
  });
});

describe('welcomeWagon — Act 2 (first time online)', () => {
  it('doorbell, toss at the mark, waves, confetti once seated, hello, caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 8_000);
    expect(types(beats)).toEqual(['toss', 'say', 'wave', 'confetti', 'hello', 'caption']);
    expect(beats.find((b) => b.beat.type === 'caption')!.beat).toMatchObject({
      text: 'ada joined the team — welcome',
    });
  });

  it('the toss waits for the arrival to reach the mark', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    let atMark = false;
    const d = deps({ atMark: () => atMark });
    expect(types(run(s, WAVE_MS, WAVE_MS + 3_000, d))).not.toContain('toss');
    atMark = true;
    expect(types(run(s, WAVE_MS + 3_050, WAVE_MS + 3_100, d))).toContain('toss');
  });

  it('confetti waits for the seat, and gives up after the gate timeout', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 20_000, deps({ seated: () => false }));
    expect(types(beats)).not.toContain('confetti');
    expect(types(beats)).toContain('caption'); // the line is still written
    expect(welcomePlaying(s)).toBe(false);
  });

  it('created-and-online folds Act 1 in: label and wagon ride along, one caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('guest', { online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000));
    expect(t).toContain('label');
    expect(t).toContain('wagon');
    expect(t.filter((x) => x === 'caption')).toHaveLength(1);
    expect(t).not.toContain('ring'); // the fold is one moment: the door opened it, no phone call
  });

  it('skips beats for a Member who left before they fired', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000, deps({ present: () => false })));
    expect(t).toEqual([]);
  });
});

describe('welcomeWagon — the crowd', () => {
  const crowd = (n: number) => Array.from({ length: n }, (_, i) => a(`g${i}`, { online: true }));

  it('one zoomies, a toss per member, one confetti, one caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(5), 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 10_000));
    expect(t.filter((x) => x === 'zoomies')).toHaveLength(1);
    expect(t.filter((x) => x === 'toss')).toHaveLength(5);
    expect(t.filter((x) => x === 'confetti')).toHaveLength(1);
    expect(t.filter((x) => x === 'caption')).toHaveLength(1);
  });

  it('tosses are 0.6 s apart, wave after wave', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(3), 0);
    const first = run(s, WAVE_MS, WAVE_MS + 6_000);
    const tossAt = first.filter((b) => b.beat.type === 'toss').map((b) => b.at);
    expect(tossAt[1]! - tossAt[0]!).toBe(600);
    enqueueArrivals(
      s,
      [a('x', { online: true }), a('y', { online: true }), a('z', { online: true })],
      10_000,
    );
    const second = run(s, 10_000 + WAVE_MS, 10_000 + WAVE_MS + 6_000);
    expect(second.filter((b) => b.beat.type === 'toss')).toHaveLength(3);
  });

  it('an all-human crowd says people; a mixed one says members — never guests (sloane)', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(3), 0);
    const cap = run(s, WAVE_MS, WAVE_MS + 6_000).find((b) => b.beat.type === 'caption')!.beat;
    expect(cap).toMatchObject({ text: '3 people joined — welcome' });
    const s2 = createWelcomeWagon();
    enqueueArrivals(s2, [...crowd(2), a('bot', { online: true, memberKind: 'agent' })], 0);
    const cap2 = run(s2, WAVE_MS, WAVE_MS + 6_000).find((b) => b.beat.type === 'caption')!.beat;
    expect(cap2).toMatchObject({ text: '3 members joined — welcome' });
  });

  it('past the backlog cap, everything pending merges into one wave', () => {
    const s = createWelcomeWagon();
    // Arrivals 3 s apart would normally be separate waves…
    for (let i = 0; i <= BACKLOG_MAX; i++)
      enqueueArrivals(s, [a(`s${i}`, { online: true })], i * 3_000);
    const start = BACKLOG_MAX * 3_000 + WAVE_MS;
    const t = types(run(s, start, start + 12_000));
    expect(t.filter((x) => x === 'zoomies')).toHaveLength(1); // …but the backlog plays as one crowd
    expect(t.filter((x) => x === 'toss')).toHaveLength(BACKLOG_MAX + 1);
  });
});

describe('welcomeWagon — the final review (lane 01M3F81DD9)', () => {
  it('created, then connected a second later, is ONE folded welcome — not Act 2 then Act 1', () => {
    // member add → presence:offline refetch; the connect ~1 s later → presence:online refetch: two
    // records for the same name inside one wave.
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 1_000);
    const t = types(run(s, 1_000 + WAVE_MS, 1_000 + WAVE_MS + 12_000));
    expect(t).not.toContain('ring');
    expect(t.filter((x) => x === 'label')).toHaveLength(1);
    expect(t.filter((x) => x === 'caption')).toHaveLength(1);
    expect(t.indexOf('label')).toBeLessThan(t.indexOf('toss'));
  });

  it('a Member added and removed before the wave starts is not announced at all', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('adaa')], 0); // the typo…
    expect(run(s, WAVE_MS, WAVE_MS + 6_000, deps({ present: (n) => n !== 'adaa' }))).toEqual([]);
    expect(welcomePlaying(s)).toBe(false);
  });

  it('a short hidden gap pauses the sequence instead of bursting it', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    run(s, WAVE_MS, WAVE_MS + 200); // started
    const afterGap = stepWelcomeWagon(s, WAVE_MS + 10_200, deps()).map((b) => b.type);
    expect(afterGap).toEqual([]); // nothing fires on the frame the tab comes back
    const resumed = types(run(s, WAVE_MS + 10_250, WAVE_MS + 18_000));
    expect(resumed).toEqual(['toss', 'say', 'wave', 'confetti', 'hello', 'caption']); // in order, paced
  });
});

describe('welcomeWagon — guards', () => {
  it('does not START while real choreography plays', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    expect(run(s, WAVE_MS, WAVE_MS + 3_000, deps({ busy: true }))).toEqual([]);
    expect(types(run(s, WAVE_MS + 3_050, WAVE_MS + 8_000))[0]).toBe('ring');
  });

  it('a room that is never quiet cannot starve a welcome — after MAX_WAIT_MS it starts anyway', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    const busy = deps({ busy: true });
    expect(run(s, WAVE_MS, WAVE_MS + MAX_WAIT_MS - 100, busy)).toEqual([]);
    expect(types(run(s, WAVE_MS + MAX_WAIT_MS, WAVE_MS + MAX_WAIT_MS + 5_000, busy))[0]).toBe('ring');
  });

  it('once started, busy does not stop it', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    run(s, WAVE_MS, WAVE_MS + 100);
    expect(types(run(s, WAVE_MS + 150, WAVE_MS + 5_000, deps({ busy: true })))).toContain(
      'caption',
    );
  });

  it('reduced motion: end states and caption only', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000, deps({ reduced: true })));
    expect(t).toEqual(['label', 'caption']);
  });

  it('a sequence left unstepped past STALE_S (hidden tab) is dropped whole, not burst', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    stepWelcomeWagon(s, WAVE_MS, deps()); // starts
    expect(stepWelcomeWagon(s, WAVE_MS + 60_000, deps())).toEqual([]);
    expect(welcomePlaying(s)).toBe(false);
  });
});
