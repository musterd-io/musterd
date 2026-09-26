import { describe, expect, it } from 'vitest';
import type { ArrivalSubject } from './arrivals';
import { createWelcomeRoom, type WelcomePorts } from './welcomeRoom';
import { WAVE_MS } from './welcomeWagon';

/**
 * The Welcome Wagon's wiring (lane 01M3F81DD9): roster → arrivals → sequencer → the room's residents.
 * `mountOffice` cannot run under vitest's node environment (no canvas, no rAF — scene-loop.test.ts
 * says why), so everything the scene decides lives here, behind ports the tests fake; index.ts only
 * plugs the real residents in.
 */
function subject(name: string, over: Partial<ArrivalSubject> = {}): ArrivalSubject {
  return {
    name,
    kind: 'human',
    service: false,
    presence: 'offline',
    offline_reason: 'unknown',
    hue: 40,
    created_at: null,
    sponsored_by: null,
    ...over,
  };
}
const online = (s: ArrivalSubject): ArrivalSubject => ({
  ...s,
  presence: 'online',
  offline_reason: null,
});

function fakePorts(over: Partial<WelcomePorts> = {}) {
  const calls: string[] = [];
  const seated = new Set<string>();
  const ports: WelcomePorts = {
    present: () => true,
    hasDesk: () => true,
    seated: (n) => seated.has(n),
    reachedMark: () => true,
    busy: () => false,
    kindOf: (n) => (n.startsWith('bot') ? 'agent' : 'human'),
    color: (n, hue) => `c(${n},${hue})`,
    expectFirstArrival: (n, carry) => void calls.push(`first:${n}:${carry}`),
    receptionist: (cue) => void calls.push(`recep:${cue}`),
    say: (text) => void calls.push(`say:${text}`),
    wagon: (n) => void calls.push(`wagon:${n}`),
    polaroid: (n) => void calls.push(`polaroid:${n}`),
    zoomies: () => void calls.push('zoomies'),
    wave: (n) => void calls.push(`wave:${n}`),
    confetti: (n, color) => void calls.push(`confetti:${n}:${color}`),
    door: (hue) => void calls.push(`door:${hue}`),
    caption: (text) => void calls.push(`caption:${text}`),
    sound: (m, near) => void calls.push(`sound:${m}@${typeof near === 'string' ? near : near.name}`),
    ...over,
  };
  return { ports, calls, seated };
}

/** Run the room's step from t0 to t1 ms in 50 ms frames; the scene clock advances with it. */
function run(room: ReturnType<typeof createWelcomeRoom>, t0: number, t1: number) {
  for (let t = t0; t <= t1; t += 50) room.step(t, t / 1000);
}

const OPTS = { reduced: false, still: false };

describe('welcomeRoom — the roster side', () => {
  it('the first roster is never an arrival and wakes nothing', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    expect(room.onRoster([subject('nick'), subject('ada')], new Set(), 0)).toEqual([]);
    expect(room.active()).toBe(false);
    run(room, 0, 5_000);
    expect(calls).toEqual([]);
  });

  it('a first-online human is flagged to carry the moving box; an agent carries nothing', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick'), subject('ada'), subject('bot1', { kind: 'agent' })], new Set(), 0);
    const out = room.onRoster(
      [subject('nick'), online(subject('ada')), online(subject('bot1', { kind: 'agent' }))],
      new Set(),
      10,
    );
    expect(out.map((a) => a.name)).toEqual(['ada', 'bot1']);
    expect(calls).toEqual(['first:ada:movingBox', 'first:bot1:null']);
    expect(room.active()).toBe(true); // queued — the scene must keep ticking to start it
  });

  it('derives the new-arrivals corner from the roster, coloured by the port', () => {
    const { ports } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    const now = 50 * 3_600_000;
    room.onRoster([subject('ada', { created_at: now - 1_000 }), subject('lin', { created_at: now - 2_000 })], new Set(['lin']), now);
    expect(room.paint.polaroids).toEqual([{ name: 'ada', color: 'c(ada,40)' }]);
  });

  it('still mode never welcomes anyone', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, { reduced: false, still: true });
    room.onRoster([subject('nick')], new Set(), 0);
    expect(room.onRoster([subject('nick'), subject('ada')], new Set(), 10)).toEqual([]);
    run(room, 0, 8_000);
    expect(calls).toEqual([]);
  });
});

describe('welcomeRoom — dispatch', () => {
  it('Act 1 rings the desk, prints the label, sends the wagon and captions', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick')], new Set(), 0);
    room.onRoster([subject('nick'), subject('ada', { sponsored_by: 'nick' })], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 1_000);
    expect(room.paint.labels).toHaveLength(1);
    run(room, WAVE_MS + 1_050, WAVE_MS + 5_000);
    expect(calls).toEqual([
      'recep:ring',
      'sound:ring@desk',
      'say:oh! someone new: ada',
      'recep:label',
      'sound:ratchet@desk',
      'wagon:ada',
      'sound:rattle@desk',
      'caption:ada was added to the team · by nick',
    ]);
    expect(room.started()).toBe(1);
  });

  it('Act 2 hangs the lanyard on the toss and takes it off once they sit', () => {
    const { ports, calls, seated } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('ada')], new Set(), 0);
    room.onRoster([online(subject('ada'))], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 2_000);
    expect(calls).toContain('door:40');
    expect(calls).toContain('sound:doorbell@door');
    expect(calls).toContain('recep:toss');
    expect(room.paint.lanyards.get('ada')).toBe('c(ada,40)');
    seated.add('ada');
    run(room, WAVE_MS + 2_050, WAVE_MS + 8_000);
    expect(room.paint.lanyards.has('ada')).toBe(false);
    expect(calls).toContain('wave:ada');
    expect(calls).toContain('confetti:ada:c(ada,40)');
    expect(calls).toContain('sound:pop@ada');
    expect(calls.at(-1)).toBe('caption:ada joined the team — welcome');
  });

  it('a guest who never sits (the overflow gallery) loses the lanyard anyway, so the loop can park', () => {
    const { ports } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('ada')], new Set(), 0);
    room.onRoster([online(subject('ada'))], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 2_000);
    expect(room.paint.lanyards.has('ada')).toBe(true);
    run(room, WAVE_MS + 2_050, WAVE_MS + 40_000);
    expect(room.paint.lanyards.has('ada')).toBe(false);
    expect(room.active()).toBe(false);
  });

  it('an agent gets the boot blink with the toss; a human does not', () => {
    const { ports } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('bot1', { kind: 'agent' }), subject('ada')], new Set(), 0);
    room.onRoster([online(subject('bot1', { kind: 'agent' })), subject('ada')], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 2_000);
    expect(room.paint.bootBlink.has('bot1')).toBe(true);
    const r2 = createWelcomeRoom(fakePorts().ports, OPTS);
    r2.onRoster([subject('ada')], new Set(), 0);
    r2.onRoster([online(subject('ada'))], new Set(), 0);
    run(r2, WAVE_MS, WAVE_MS + 2_000);
    expect(r2.paint.bootBlink.size).toBe(0);
  });

  it('the hello screen lights once they are seated, and fades from the paint after a second', () => {
    const { ports, seated } = fakePorts();
    seated.add('ada');
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('ada')], new Set(), 0);
    room.onRoster([online(subject('ada'))], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 6_100);
    expect(room.paint.hello.has('ada')).toBe(true);
    run(room, WAVE_MS + 6_150, WAVE_MS + 7_500);
    expect(room.paint.hello.has('ada')).toBe(false);
  });

  it('the crowd flips the counter and the counter folds away a minute after', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    const crowd = ['g1', 'g2', 'g3', 'g4'].map((n) => subject(n));
    room.onRoster([subject('nick')], new Set(), 0);
    room.onRoster([subject('nick'), ...crowd.map(online)], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 6_000);
    expect(calls).toContain('zoomies');
    expect(room.paint.counter?.value).toBe(4);
    expect(room.expire(WAVE_MS + 30_000)).toBe(false);
    expect(room.expire(WAVE_MS + 70_000)).toBe(true);
    expect(room.paint.counter).toBeNull();
  });

  it('does not start over a real act walk', () => {
    let busy = true;
    const { ports, calls } = fakePorts({ busy: () => busy });
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick')], new Set(), 0);
    room.onRoster([subject('nick'), subject('ada')], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 3_000);
    expect(calls).toEqual([]);
    busy = false;
    run(room, WAVE_MS + 3_050, WAVE_MS + 3_100);
    expect(calls[0]).toBe('recep:ring');
  });
});

describe('welcomeRoom — reduced motion', () => {
  it('no first-arrival walk flag, no receptionist moves, no label strip — sound and caption only', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, { reduced: true, still: false });
    room.onRoster([subject('nick')], new Set(), 0);
    room.onRoster([subject('nick'), online(subject('ada'))], new Set(), 0);
    run(room, WAVE_MS, WAVE_MS + 8_000);
    expect(calls).toEqual(['sound:ratchet@desk', 'caption:ada joined the team — welcome']);
    expect(room.paint.labels).toHaveLength(0);
  });
});
