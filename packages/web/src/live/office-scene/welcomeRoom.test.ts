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
    expect(room.onRoster([subject('nick'), subject('ada')], 0)).toEqual([]);
    expect(room.active()).toBe(false);
    run(room, 0, 5_000);
    expect(calls).toEqual([]);
  });

  it('a first-online human is flagged to carry the moving box; an agent carries nothing', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick'), subject('ada'), subject('bot1', { kind: 'agent' })], 0);
    const out = room.onRoster(
      [subject('nick'), online(subject('ada')), online(subject('bot1', { kind: 'agent' }))],
      10,
    );
    expect(out.map((a) => a.name)).toEqual(['ada', 'bot1']);
    expect(calls.filter((c) => c.startsWith('first:'))).toEqual(['first:ada:movingBox', 'first:bot1:null']);
    expect(room.active()).toBe(true); // queued — the scene must keep ticking to start it
  });

  it('someone seen online on load who lapses and comes back is not welcomed again (e2e 2026-09-26)', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([online(subject('nick'))], 0); // first load: nick is on the floor
    expect(room.onRoster([subject('nick')], 1_000)).toEqual([]); // lapses to offline/unknown
    expect(room.onRoster([online(subject('nick'))], 2_000)).toEqual([]); // …and returns
    expect(calls).toEqual([]);
  });

  it('an empty first roster is not the baseline — the page mounted before the roster arrived', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    expect(room.onRoster([], 0)).toEqual([]);
    // The real roster lands: that is the first roster, not a whole team arriving at once.
    expect(room.onRoster([subject('nick'), subject('ada'), subject('lin')], 100)).toEqual([]);
    run(room, 0, 8_000);
    expect(calls).toEqual([]);
  });

  it('a crowd walking in rings the door once, with no single colour', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick')], 0);
    room.onRoster([subject('nick'), ...['g1', 'g2', 'g3'].map((n) => online(subject(n)))], 0);
    expect(calls.filter((c) => c.startsWith('door:'))).toEqual(['door:null']);
    expect(calls.filter((c) => c === 'sound:doorbell@door')).toHaveLength(1);
  });

  it('still mode never welcomes anyone', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, { reduced: false, still: true });
    room.onRoster([subject('nick')], 0);
    expect(room.onRoster([subject('nick'), subject('ada')], 10)).toEqual([]);
    run(room, 0, 8_000);
    expect(calls).toEqual([]);
  });
});

describe('welcomeRoom — dispatch', () => {
  it('Act 1 rings the desk, prints the label, sends the wagon and captions', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick')], 0);
    room.onRoster([subject('nick'), subject('ada', { sponsored_by: 'nick' })], 0);
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
    room.onRoster([subject('ada')], 0);
    room.onRoster([online(subject('ada'))], 0);
    // The door rings as they walk through it — at the roster, not 2 s later when the script starts.
    expect(calls.slice(-2)).toEqual(['door:40', 'sound:doorbell@door']);
    run(room, WAVE_MS, WAVE_MS + 2_000);
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
    room.onRoster([subject('ada')], 0);
    room.onRoster([online(subject('ada'))], 0);
    run(room, WAVE_MS, WAVE_MS + 2_000);
    expect(room.paint.lanyards.has('ada')).toBe(true);
    run(room, WAVE_MS + 2_050, WAVE_MS + 40_000);
    expect(room.paint.lanyards.has('ada')).toBe(false);
    expect(room.active()).toBe(false);
  });

  it('the lanyard flies from the counter for 0.6 s before it is on them', () => {
    const { ports } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('ada')], 0);
    room.onRoster([online(subject('ada'))], 0);
    run(room, WAVE_MS, WAVE_MS + 1_600); // the toss lands at 1.6 s
    expect(room.paint.tosses.map((x) => x.name)).toEqual(['ada']);
    expect(room.paint.tosses[0]!.color).toBe('c(ada,40)');
    run(room, WAVE_MS + 1_650, WAVE_MS + 2_400);
    expect(room.paint.tosses).toEqual([]);
    expect(room.paint.lanyards.has('ada')).toBe(true);
  });

  it('an agent gets the boot blink with the toss; a human does not', () => {
    const { ports } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('bot1', { kind: 'agent' }), subject('ada')], 0);
    room.onRoster([online(subject('bot1', { kind: 'agent' })), subject('ada')], 0);
    run(room, WAVE_MS, WAVE_MS + 2_000);
    expect(room.paint.bootBlink.has('bot1')).toBe(true);
    const r2 = createWelcomeRoom(fakePorts().ports, OPTS);
    r2.onRoster([subject('ada')], 0);
    r2.onRoster([online(subject('ada'))], 0);
    run(r2, WAVE_MS, WAVE_MS + 2_000);
    expect(r2.paint.bootBlink.size).toBe(0);
  });

  it('the hello screen lights once they are seated, and fades from the paint after a second', () => {
    const { ports, seated } = fakePorts();
    seated.add('ada');
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('ada')], 0);
    room.onRoster([online(subject('ada'))], 0);
    run(room, WAVE_MS, WAVE_MS + 6_100);
    expect(room.paint.hello.has('ada')).toBe(true);
    run(room, WAVE_MS + 6_150, WAVE_MS + 7_500);
    expect(room.paint.hello.has('ada')).toBe(false);
  });

  it('the crowd gets zoomies', () => {
    const { ports, calls } = fakePorts();
    const room = createWelcomeRoom(ports, OPTS);
    const crowd = ['g1', 'g2', 'g3', 'g4'].map((n) => subject(n));
    room.onRoster([subject('nick')], 0);
    room.onRoster([subject('nick'), ...crowd.map(online)], 0);
    run(room, WAVE_MS, WAVE_MS + 6_000);
    expect(calls).toContain('zoomies');
  });

  it('does not start over a real act walk', () => {
    let busy = true;
    const { ports, calls } = fakePorts({ busy: () => busy });
    const room = createWelcomeRoom(ports, OPTS);
    room.onRoster([subject('nick')], 0);
    room.onRoster([subject('nick'), subject('ada')], 0);
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
    room.onRoster([subject('nick')], 0);
    room.onRoster([subject('nick'), online(subject('ada'))], 0);
    run(room, WAVE_MS, WAVE_MS + 8_000);
    // No glow (motion) — but the doorbell still rings: audio is not motion (E3 spec §2).
    expect(calls).toEqual([
      'sound:doorbell@door',
      'sound:ratchet@desk',
      'caption:ada joined the team — welcome',
    ]);
    expect(room.paint.labels).toHaveLength(0);
  });
});
