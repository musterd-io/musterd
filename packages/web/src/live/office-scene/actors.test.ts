import { describe, expect, it } from 'vitest';
import {
  FIRST_ARRIVAL_HOLD_S,
  GESTURE_DUR,
  createActors,
  deskNeighbourPairs,
  homePoses,
  travelDir,
  conversationLooks,
} from './actors';
import { BOARD_STAND, COFFEE_STAND, DESK_SLOTS, ENTRANCE, insideCafe, STRIP_CAP } from './layout';
import { GESTURE, IDLE_GESTURES } from './skeleton';
import { LEISURE_SPOTS } from './layout';
import { REPLAY_TEMPO } from './replay';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';
import { slotRng } from './ambientSeed';

function node(name: string, presence: OfficeNode['presence'] = 'online'): OfficeNode {
  return {
    name,
    kind: 'human',
    service: false,
    woken: false,
    presence,
    activity: 'working',
    posture: presence === 'online' ? 'working' : presence,
    state: null,
    color: 'hsl(200, 60%, 60%)',
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
  };
}
function world(nodes: OfficeNode[]) {
  const placements = assignSeats(nodes);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  return { placements, byName };
}

/**
 * Step through the sit blend the way the real loop does. `actors.active()` counts walks and gestures
 * only — it goes false the moment a trip ends, while the member is still lowering into the chair
 * (`SIT_EASE`, 0.6s). The scene keeps drawing through exactly that gap on its `AFTERGLOW_MS` (2.6s)
 * settling window, so a test that stops at `active()` is looking at a frame the eye never sees.
 *
 * It matters here because the laptop and the dock changed hands on that blend (gptbot, reviewing
 * #1304): the hand lets go when `sit > 0.9`, which is when the dock takes it.
 */
function seated(actors: ReturnType<typeof createActors>, name: string): void {
  for (let i = 0; i < 60 && (actors.poses().get(name)?.sit ?? 1) <= 0.9; i++) actors.step(0.05);
}

describe('travelDir', () => {
  it('faces the dominant axis of travel', () => {
    expect(travelDir(0, 0, 10, 0)).toBe('E');
    expect(travelDir(0, 0, -10, 0)).toBe('W');
    expect(travelDir(0, 0, 0, 10)).toBe('S');
    expect(travelDir(0, 0, 0, -10)).toBe('N');
    expect(travelDir(0, 0, 10, 3)).toBe('E'); // |dx| >= |dy| → horizontal wins
  });
});

describe('homePoses', () => {
  it('is deterministic and independent of roster order', () => {
    const w1 = world([node('Ada'), node('Bo'), node('Cy')]);
    const w2 = world([node('Cy'), node('Ada'), node('Bo')]);
    const a = homePoses(w1.placements, w1.byName);
    const b = homePoses(w2.placements, w2.byName);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [name, pose] of a) expect(b.get(name)).toEqual(pose);
  });

  it('seats present members full-size; an away member leaves the floor, desk kept (§4 lane 4)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo', 'away')]);
    const poses = homePoses(placements, byName);
    expect(poses.get('Ada')!.small).toBe(false);
    // Away is declared absence: jacket over the chair, no body — the pose map omits them.
    expect(poses.has('Bo')).toBe(false);
    expect(placements.get('Bo')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('omits offline (gone) members', () => {
    const { placements, byName } = world([node('Ada'), node('Gone', 'offline')]);
    const poses = homePoses(placements, byName);
    expect(poses.has('Ada')).toBe(true);
    expect(poses.has('Gone')).toBe(false);
  });

  it('marks a leisure sitter casual and a desk member not — the deskless-hands read', () => {
    // `active` posture is what claims the leisure furniture (couch / meeting chairs / waiting chair);
    // `working` competes for a desk. The flag is what stops an idle member on the couch sitting with
    // their arms out on a keyboard that is not there (nick, 2026-08-31).
    const idle = node('Ada');
    idle.posture = 'active';
    const { placements, byName } = world([idle, node('Bo')]);
    const poses = homePoses(placements, byName);
    expect(placements.get('Ada')).toMatchObject({ kind: 'leisure' });
    expect(poses.get('Ada')!.casual).toBe(true);
    expect(placements.get('Bo')).toMatchObject({ kind: 'desk' });
    expect(poses.get('Bo')!.casual).toBe(false);
  });

  it('leaves the standing reader alone — browsing the shelves is not sitting', () => {
    // Fill every seated leisure spot so the next idle member probes onto a `reading` spot, which
    // stands (`sit: 0`) and must not take the seated-casual pose.
    const idlers = ['Ada', 'Bo', 'Cy', 'Di', 'Eli', 'Fi', 'Gus', 'Hana'].map((n) => {
      const m = node(n);
      m.posture = 'active';
      return m;
    });
    const { placements, byName } = world(idlers);
    const poses = homePoses(placements, byName);
    for (const [name, pose] of poses) {
      const pl = placements.get(name);
      if (pl?.kind !== 'leisure') continue;
      // Standing spots are never casual-seated; seated ones always are.
      expect(pose.casual).toBe(pose.sit > 0);
    }
  });

  it('queues overflow (past every desk) single-file receding from the entrance', () => {
    // Three more present-and-working members than the floor has desks → 3 spill onto the queue.
    const nodes = Array.from({ length: DESK_SLOTS.length + 3 }, (_, i) =>
      node(`M${String(i).padStart(2, '0')}`),
    );
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const strip = [...placements.entries()]
      .flatMap(([name, p]) =>
        p.kind === 'strip' ? [{ name, index: p.index, pose: poses.get(name)! }] : [],
      )
      .sort((a, b) => a.index - b.index);

    expect(strip.length).toBeGreaterThanOrEqual(2);
    for (const s of strip) expect(s.pose.small).toBe(true); // queued avatars render small
    // single file: each spot steps further into the room (x up, logical y up toward the desks)
    for (let i = 1; i < strip.length; i++) {
      expect(strip[i]!.pose.lx).toBeGreaterThan(strip[i - 1]!.pose.lx);
      expect(strip[i]!.pose.ly).toBeLessThan(strip[i - 1]!.pose.ly);
    }
    // the head of the queue waits right by the entrance
    const head = strip[0]!.pose;
    expect(Math.hypot(head.lx - ENTRANCE.lx, head.ly - ENTRANCE.ly)).toBeLessThan(120);
  });

  it('caps the queue avatars past STRIP_CAP (rest collapse into the "+N" pill)', () => {
    // every desk + a big overflow → only STRIP_CAP queued avatars get a pose; the rest are placed but undrawn.
    const nodes = Array.from({ length: DESK_SLOTS.length + STRIP_CAP + 4 }, (_, i) =>
      node('Q' + String(i).padStart(2, '0')),
    );
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const strip = [...placements.entries()].filter(([, p]) => p.kind === 'strip');
    const stripDrawn = strip.filter(([name]) => poses.has(name));
    expect(strip.length).toBe(STRIP_CAP + 4); // 4 over the cap
    expect(stripDrawn.length).toBe(STRIP_CAP); // only the cap is drawn
  });

  it('away members hold desks without bodies; the nook is only their overflow past every desk', () => {
    const nodes = Array.from({ length: DESK_SLOTS.length + 3 }, (_, i) =>
      node('A' + String(i).padStart(2, '0'), 'away'),
    );
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const desks = nodes.filter((n) => placements.get(n.name)?.kind === 'desk');
    const nook = nodes.filter((n) => placements.get(n.name)?.kind === 'nook');
    expect(desks.length).toBe(DESK_SLOTS.length);
    expect(nook.length).toBe(3);
    // Desk-holding away members draw no body; the nook overflow still draws small.
    for (const n of desks) expect(poses.has(n.name)).toBe(false);
    for (const n of nook) {
      const p = poses.get(n.name)!;
      expect(p.small).toBe(true);
      expect(insideCafe(p.lx, p.ly)).toBe(true);
    }
  });
});

describe('walk choreography', () => {
  it('walks a mover away from home and returns it, going idle when done', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    expect(actors.active()).toBe(true);

    // partway through the first leg the mover has left its seat
    actors.step(0.2);
    const mid = actors.poses().get('Ada')!;
    expect(mid.lx !== home.lx || mid.ly !== home.ly).toBe(true);

    // run the trip to completion (there → hold → back)
    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    expect(actors.active()).toBe(false);
    seated(actors, 'Ada'); // …and down into the chair, where the dock takes the laptop

    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
    expect(back.carry).toBeNull();
    expect(back.bubble).toBeNull();
  });

  it('a roster update never cuts an act walk in flight (lane 01M5B02V4A)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    actors.step(0.6); // well away from the desk
    expect(actors.actWalkingFor('Ada')).toBe(true);
    // The same roster again — what every envelope and presence frame used to do.
    actors.setHomes(placements, byName, true);
    expect(actors.actWalkingFor('Ada')).toBe(true); // still the help walk, not a plain walk home
    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    const back = actors.poses().get('Ada')!;
    expect(Math.hypot(back.lx - home.lx, back.ly - home.ly)).toBeLessThan(8);
  });

  it('a home that moves under a walker is reached after the walk lands, then the queue drains', () => {
    const three = [node('Ada'), node('Bo'), node('Cy')];
    const { placements, byName } = world(three);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    expect(actors.walk('Ada', { kind: 'help', to: 'Cy', urgent: false })).toBe(true); // queued
    actors.step(0.6);
    // Ada steps away (posture idle) — her home moves to the leisure spots.
    const idleAda: OfficeNode = { ...node('Ada'), posture: 'active', activity: 'active' };
    const idle: OfficeNode[] = three.map((n) => (n.name === 'Ada' ? idleAda : n));
    const moved = world(idle);
    actors.setHomes(moved.placements, moved.byName, true);
    expect(actors.actWalkingFor('Ada')).toBe(true); // the help walk still stands
    let guard = 0;
    while (actors.active() && guard++ < 4000) actors.step(0.05);
    // Where the new home IS: a second, snapped actor set on the same moved world reads it off.
    const snapped = createActors();
    snapped.setHomes(moved.placements, moved.byName, false);
    const home = snapped.poses().get('Ada')!;
    const at = actors.poses().get('Ada')!;
    expect(Math.hypot(at.lx - home.lx, at.ly - home.ly)).toBeLessThan(8); // ends at the NEW home
  });

  it("an act yields only its own member's ambient — a stranger's gesture plays out", () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Cy')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    for (let i = 0; i < 40; i++) actors.step(0.05); // everyone seated
    expect(actors.gestureBeat('Cy', GESTURE.stretch)).toBe(true);
    expect(actors.gestureBeat('Ada', GESTURE.stretch)).toBe(true);
    actors.cancelAmbient('Ada');
    expect(actors.ambientOnly()).toBe(true); // Cy still gesturing
    expect(actors.active()).toBe(true);
    actors.cancelAmbient(); // the old, unscoped form still clears everyone
    expect(actors.active()).toBe(false);
  });

  /**
   * ADR 254 eligible sets: an act addressed to 2-4 seats makes the sender walk to EACH desk, one
   * trip after another, because any of them can discharge it and the room must not rank them
   * (nick, 2026-09-02). `walk` already queued per call; this pins that a set-sized burst actually
   * drains, since the backlog guard caps `pending` at three and MAX_ELIGIBLE is four.
   */
  it('walks the sender to every seat of an eligible set, one desk after another', () => {
    const { placements, byName } = world([
      node('Ada'),
      node('Bo'),
      node('Cy'),
      node('Dee'),
      node('Eve'),
    ]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;
    const desks = new Map(
      ['Bo', 'Cy', 'Dee', 'Eve'].map((n) => [n, actors.poses().get(n)!] as const),
    );

    // The MAX_ELIGIBLE cap: four names, so three queue behind the one that starts immediately.
    for (const to of ['Bo', 'Cy', 'Dee', 'Eve']) {
      expect(actors.walk('Ada', { kind: 'help', to, urgent: false })).toBe(true);
    }

    // Nearest approach to each desk over the whole burst — a leg that never ran stays far away.
    const nearest = new Map([...desks.keys()].map((n) => [n, Infinity]));
    let guard = 0;
    while (actors.active() && guard++ < 20000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      for (const [n, d] of desks) {
        const gap = Math.hypot(p.lx - d.lx, p.ly - d.ly);
        if (gap < nearest.get(n)!) nearest.set(n, gap);
      }
    }
    expect(actors.active()).toBe(false);

    // Every one of the four was actually visited, not just the first.
    /**
     * A visit is "came far closer to that desk than sitting at home ever would". Measured rather
     * than guessed: a walker stops BESIDE a desk, not on it (~72 units of stand-off here), while the
     * four baselines from Ada's own seat are 190, 318, 460 and 673. An absolute "did it touch the
     * desk" threshold reads every leg as a miss, which is exactly the wrong conclusion — so compare
     * each approach with its own baseline instead of with a magic number.
     */
    for (const [n, gap] of nearest) {
      const d = desks.get(n)!;
      const baseline = Math.hypot(home.lx - d.lx, home.ly - d.ly);
      expect({ seat: n, visited: gap < baseline * 0.5 }).toEqual({ seat: n, visited: true });
    }

    // And the sender is back at its own desk when the whole trip is done.
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
  });

  /**
   * The boundary the eligible-set walk sits exactly on, measured rather than assumed.
   *
   * `walk` holds one trip in flight plus three pending, so a four-name set — MAX_ELIGIBLE — fits
   * only when the sender is idle. One walk already running and the last leg is refused, silently:
   * the caller gets `false` and the room simply never shows that desk. Observed in the browser on
   * /office-preview, whose looping script re-fires faster than an ~8.5s round trip drains; from its
   * second loop the guard refuses legs, including a single-recipient walk that predates eligible
   * sets. Recorded here so the next reader knows the fit is exact and not comfortable.
   */
  it('has no headroom at the eligible cap — a busy sender loses the last leg of a four-name set', () => {
    const { placements, byName } = world([
      node('Ada'),
      node('Bo'),
      node('Cy'),
      node('Dee'),
      node('Eve'),
    ]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);

    // One trip already running, then a full four-name set behind it.
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    const accepted = ['Bo', 'Cy', 'Dee', 'Eve'].map((to) =>
      actors.walk('Ada', { kind: 'help', to, urgent: false }),
    );
    expect(accepted).toEqual([true, true, true, false]);
  });

  it("won't walk to a dnd member — do-not-interrupt is honoured by the choreography (\u00a74 lane 4)", () => {
    const focused = { ...node('Bo'), dnd: true };
    const { placements, byName } = world([node('Ada'), focused]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(false);
    expect(actors.active()).toBe(false);
  });

  it("won't play a walk when the target isn't present", () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.walk('Ada', { kind: 'help', to: 'Ghost', urgent: false })).toBe(false);
    expect(actors.active()).toBe(false);
  });

  it('carries a box on a handoff outbound leg', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.walk('Ada', { kind: 'handoff', to: 'Bo', urgent: false });
    actors.step(0.1);
    expect(actors.poses().get('Ada')!.carry).toBe('box');
  });
});

describe('the deliver walk (lane 01M4SPZB1V)', () => {
  it('replaces the submit pin for the same card and carries it to the acceptor, who is approached', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const bo = actors.poses().get('Bo')!;
    const home = actors.poses().get('Ada')!;

    expect(actors.pin('Ada', 7, 'awaiting_acceptance')).toBe(true);
    actors.step(0.2); // the pick-up at the desk has started
    expect(actors.deliver('Ada', 'Bo', 7)).toBe(true);
    // The card is off the cork while it travels, and the pin is gone with it.
    expect(actors.takenSeeds()).toEqual([7]);
    expect(actors.pinnedSeeds()).toEqual([]);

    let nearest = Infinity;
    let carried = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      nearest = Math.min(nearest, Math.hypot(p.lx - bo.lx, p.ly - bo.ly));
      if (p.carry === 'card') carried = true;
      // Never at the board: the pin walk did not survive.
      expect(Math.hypot(p.lx - BOARD_STAND.lx, p.ly - BOARD_STAND.ly)).toBeGreaterThan(30);
    }
    expect(carried).toBe(true);
    expect(nearest).toBeLessThan(80);
    expect(actors.takenSeeds()).toEqual([]);
    seated(actors, 'Ada');
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.carry).toBeNull();
  });

  it('refuses when the acceptor is not in the room, leaving the pin walk to stand', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.pin('Ada', 7, 'awaiting_acceptance')).toBe(true);
    expect(actors.deliver('Ada', 'Bo', 7)).toBe(false);
    let guard = 0;
    while (actors.active() && guard++ < 4000) actors.step(0.05);
    expect(guard).toBeGreaterThan(1);
  });
});

describe('locomotion smoothness', () => {
  /** Shortest signed arc between two angles — mirror of the actor system's wrap-aware turn. */
  const arc = (a: number, b: number): number => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  it('cruises at one continuous speed through waypoints — never a dead stop mid-run', () => {
    // A populated room so the stroll routes around furniture into a multi-leg polyline.
    const { placements, byName } = world(['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fi'].map((n) => node(n)));
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientWalk('Ada')).toBe(true);

    const dt = 1 / 60;
    let prev = actors.poses().get('Ada')!;
    const speeds: number[] = [];
    let guard = 0;
    // Sample the outbound run — it ends when the walker parks at the machine (`moving` flips false).
    while (guard++ < 4000) {
      actors.step(dt);
      const p = actors.poses().get('Ada')!;
      if (!p.moving && speeds.length > 0) break;
      if (p.moving) speeds.push(Math.hypot(p.lx - prev.lx, p.ly - prev.ly) / dt);
      prev = p;
    }
    expect(speeds.length).toBeGreaterThan(20);

    const vmax = Math.max(...speeds);
    const first = speeds.findIndex((s) => s >= 0.9 * vmax);
    const last = speeds.length - 1 - [...speeds].reverse().findIndex((s) => s >= 0.9 * vmax);
    expect(first).toBeGreaterThanOrEqual(0);
    // Between the ramp-in and the ramp-out the run holds cruise speed. The old per-leg easeInOut braked
    // to ~0 at every string-pulled waypoint — exactly the "walk a few steps, pause, walk again" read.
    for (let i = first; i <= last; i++) {
      expect(speeds[i]!).toBeGreaterThan(0.7 * vmax);
    }
  });

  it('swivels the facing through turns — per-frame heading change is rate-bounded, never a snap', () => {
    const { placements, byName } = world(['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fi'].map((n) => node(n)));
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientWalk('Ada')).toBe(true);

    const dt = 1 / 60;
    let prev = actors.poses().get('Ada')!.heading;
    expect(prev).toBeDefined();
    let maxDelta = 0;
    let turned = 0;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(dt);
      const h = actors.poses().get('Ada')!.heading;
      expect(h).toBeDefined();
      const d = Math.abs(arc(prev!, h!));
      maxDelta = Math.max(maxDelta, d);
      turned += d;
      prev = h;
    }
    // TURN_RATE is 9 rad/s — one frame may turn at most 9·dt (plus float slack).
    expect(maxDelta).toBeLessThanOrEqual(9 * dt + 1e-6);
    // …and the trip genuinely turned (out, about-face at the machine, and back into the seat).
    expect(turned).toBeGreaterThan(Math.PI / 2);
  });
});

describe('ambient micro-choreography', () => {
  const settle = (a: ReturnType<typeof createActors>) => {
    let g = 0;
    while (a.active() && g++ < 2000) a.step(0.05);
  };

  it('strolls a desk member out to the coffee stand and back home, going idle when done', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.ambientWalk('Ada')).toBe(true);
    expect(actors.ambientOnly()).toBe(true);

    // it wanders toward the break-nook machine at some point in the trip
    let nearest = Infinity;
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada');
      if (p)
        nearest = Math.min(nearest, Math.hypot(p.lx - COFFEE_STAND.lx, p.ly - COFFEE_STAND.ly));
    }
    expect(nearest).toBeLessThan(10); // paused at the coffee stand mid-trip

    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 3);
    expect(back.ly).toBeCloseTo(home.ly, 3);
    expect(actors.ambientOnly()).toBe(false); // no walks left
    expect(actors.active()).toBe(false);
  });

  it('ambientOnly reflects only self-generated motion (false at rest and during a real walk)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientOnly()).toBe(false); // at rest

    actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false });
    actors.step(0.1);
    expect(actors.ambientOnly()).toBe(false); // a real walk is in flight
  });

  it('only offers idle desk members (excludes away/nook and the already-strolling)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Zoe', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.idleDeskMembers().sort()).toEqual(['Ada', 'Bo']); // Zoe is in the nook (small)

    expect(actors.ambientWalk('Ada')).toBe(true);
    expect(actors.idleDeskMembers()).toEqual(['Bo']); // Ada is now busy
    expect(actors.ambientWalk('Zoe')).toBe(false); // nook members don't stroll
    expect(actors.ambientWalk('Ada')).toBe(false); // already strolling
  });

  it('cancelAmbient yields: drops the beat and walks the stroller straight home', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    actors.ambientWalk('Ada');
    actors.step(0.6); // out on the floor
    expect(actors.ambientOnly()).toBe(true);

    actors.cancelAmbient();
    expect(actors.ambientOnly()).toBe(false); // no longer an ambient walk…
    expect(actors.active()).toBe(true); // …but a return-home walk is in flight
    settle(actors);
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 3);
    expect(back.ly).toBeCloseTo(home.ly, 3);
  });

  it('a real act preempts an in-flight stroll instantly — the trip starts now, not after ambling home', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const bo = homePoses(placements, byName).get('Bo')!;

    actors.ambientWalk('Ada');
    actors.step(0.6); // Ada is out on the floor mid-stroll
    expect(actors.ambientOnly()).toBe(true);

    // a real help walk must replace the stroll immediately (not queue behind a yield-home leg)
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    expect(actors.ambientOnly()).toBe(false); // the stroll was replaced by the real walk

    // and the real trip actually plays: Ada reaches Bo's desk, proving she didn't amble home first
    let nearBo = Infinity;
    let g = 0;
    while (actors.active() && g++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      nearBo = Math.min(nearBo, Math.hypot(p.lx - bo.lx, p.ly - bo.ly));
    }
    expect(nearBo).toBeLessThan(80);
  });

  it('a real act also preempts the yield-home return left by cancelAmbient', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const bo = homePoses(placements, byName).get('Bo')!;

    actors.ambientWalk('Ada');
    actors.step(0.6);
    actors.cancelAmbient(); // stroll → low-priority yield-home walk
    expect(actors.ambientOnly()).toBe(false);
    expect(actors.active()).toBe(true);

    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    let nearBo = Infinity;
    let g = 0;
    while (actors.active() && g++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      nearBo = Math.min(nearBo, Math.hypot(p.lx - bo.lx, p.ly - bo.ly));
    }
    expect(nearBo).toBeLessThan(80); // the help trip ran despite the pending yield-home
  });

  it('plays an in-place gesture on an idle desk member, then clears it (no movement)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.gestureBeat('Ada', 1)).toBe(true);
    expect(actors.active()).toBe(true);
    expect(actors.ambientOnly()).toBe(true); // a gesture is ambient filler

    // the pose carries the gesture but the member does NOT move (stationary beat)
    actors.step(0.3);
    const mid = actors.poses().get('Ada')!;
    expect(mid.gesture).toBe(1);
    expect(mid.lx).toBeCloseTo(home.lx, 5);
    expect(mid.ly).toBeCloseTo(home.ly, 5);
    expect(mid.moving).toBe(false);

    // it ends on its own; the member returns to a plain idle pose (gesture 0)
    let g = 0;
    while (actors.active() && g++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
    expect(actors.active()).toBe(false);
  });

  it('only gestures eligible idle desk members, and excludes a gesturing one from the idle pool', () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Zoe', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);

    expect(actors.gestureBeat('Zoe', 1)).toBe(false); // nook (small) members don't gesture
    expect(actors.gestureBeat('Ada', 1)).toBe(true);
    expect(actors.gestureBeat('Ada', 2)).toBe(false); // already gesturing
    expect(actors.idleDeskMembers()).toEqual(['Bo']); // Ada is busy gesturing
  });

  it('a real act preempts an in-place gesture', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.gestureBeat('Ada', 1);
    expect(actors.ambientOnly()).toBe(true);
    actors.cancelAmbient();
    expect(actors.active()).toBe(false); // the gesture was dropped
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
  });

  it('a no-op roster refresh does not interrupt an in-flight stroll', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);

    actors.ambientWalk('Ada');
    actors.step(0.6);
    expect(actors.ambientOnly()).toBe(true);

    actors.setHomes(placements, byName, true); // identical roster (a poll) — must not yank Ada back
    expect(actors.ambientOnly()).toBe(true);
  });
});

describe('seated micro-beat choreography', () => {
  it('gesture windows vary by kind — a think outlasts a scratch', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.gestureBeat('Ada', GESTURE.chin)).toBe(true);
    expect(actors.gestureBeat('Bo', GESTURE.scratch)).toBe(true);
    for (let i = 0; i < 68; i++) actors.step(0.05); // 3.4s: past scratch (2.8s), inside chin (4.5s)
    expect(actors.poses().get('Ada')!.gesture).toBe(GESTURE.chin);
    expect(actors.poses().get('Bo')!.gesture).toBe(0);
    for (let i = 0; i < 30; i++) actors.step(0.05); // 4.9s total: chin cleared too
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
  });

  it('roll-back slides the sitter away from home and returns them exactly', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;
    actors.gestureBeat('Ada', GESTURE.roll);
    for (let i = 0; i < 30; i++) actors.step(0.05); // 1.5s — mid-window
    const mid = actors.poses().get('Ada')!;
    expect(Math.hypot(mid.lx - home.lx, mid.ly - home.ly)).toBeGreaterThan(5);
    let guard = 0;
    while (actors.active() && guard++ < 200) actors.step(0.05);
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
  });

  it('swivel yaws the heading mid-window and restores it', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const rest = actors.poses().get('Ada')!.heading!;
    actors.gestureBeat('Ada', GESTURE.swivel);
    let maxOff = 0;
    let guard = 0;
    while (actors.active() && guard++ < 200) {
      actors.step(0.05);
      maxOff = Math.max(maxOff, Math.abs(actors.poses().get('Ada')!.heading! - rest));
    }
    expect(maxOff).toBeGreaterThan(0.1); // it really swivelled…
    expect(actors.poses().get('Ada')!.heading!).toBeCloseTo(rest, 5); // …and came back to face the desk
  });
});

describe('errands', () => {
  it('water errand: the bottle is in hand (desk copy hidden) only during the trip, and ends back home', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;
    expect(actors.sceneFx().bottleCarriers.size).toBe(0);

    expect(actors.errandWater('Ada')).toBe(true);
    actors.step(0.1); // inside the pick-it-up hold
    expect(actors.sceneFx().bottleCarriers.has('Ada')).toBe(true);
    expect(actors.poses().get('Ada')!.carry).toBe('bottle');

    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    seated(actors, 'Ada');
    const done = actors.poses().get('Ada')!;
    expect(done.lx).toBeCloseTo(home.lx, 5);
    expect(done.carry).toBeNull();
    expect(actors.sceneFx().bottleCarriers.size).toBe(0); // bottle back on the desk
  });

  it('fridge errand: door opens, a plate is carried, the member really sits and eats, then returns empty-handed', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.errandFridge('Ada')).not.toBeNull();
    let sawDoor = false;
    let sawSitWithPlate = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const fx = actors.sceneFx();
      const p = actors.poses().get('Ada')!;
      if (fx.fridgeOpen) sawDoor = true;
      if (p.carry === 'plate' && p.sit > 0.9) sawSitWithPlate = true;
    }
    expect(sawDoor).toBe(true);
    expect(sawSitWithPlate).toBe(true); // actually ate on the lounge furniture
    seated(actors, 'Ada');
    const done = actors.poses().get('Ada')!;
    expect(done.lx).toBeCloseTo(home.lx, 5);
    expect(done.carry).toBeNull();
    expect(actors.sceneFx().fridgeOpen).toBe(false);
  });

  it('a real act preempts an errand mid-meal: all scene effects clear next frame, member heads home', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.errandFridge('Ada');
    // run until seated with the plate (mid-meal)
    let guard = 0;
    while (
      guard++ < 2000 &&
      !(actors.poses().get('Ada')!.carry === 'plate' && actors.poses().get('Ada')!.sit > 0.9)
    ) {
      actors.step(0.05);
    }
    expect(actors.poses().get('Ada')!.carry).toBe('plate');

    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    actors.step(0.05);
    expect(actors.sceneFx().fridgeOpen).toBe(false);
    expect(actors.poses().get('Ada')!.carry).not.toBe('plate'); // the errand's prop vanished with it
  });

  it('errands are ambient: ambientOnly stays true throughout, and eligibility guards hold', () => {
    const { placements, byName } = world([node('Ada'), node('Bo', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.errandFridge('Bo')).toBeNull(); // nook members don't run errands
    expect(actors.errandWater('Ada')).toBe(true);
    expect(actors.errandWater('Ada')).toBe(false); // already busy
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      expect(actors.ambientOnly()).toBe(true);
      actors.step(0.05);
    }
  });

  it('the coffee run pours and drinks (mug in hand at the machine) instead of standing idle', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.ambientWalk('Ada');
    let sawMug = false;
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      actors.step(0.05);
      if (actors.poses().get('Ada')!.carry === 'mug') sawMug = true;
    }
    expect(sawMug).toBe(true);
  });
});

describe('presence transitions', () => {
  const settle = (a: ReturnType<typeof createActors>) => {
    let g = 0;
    while (a.active() && g++ < 2000) a.step(0.05);
  };

  it('walks an arrival in from the entrance to its seat', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, true); // first call always snaps
    const w2 = world([node('Ada'), node('Bo')]);
    const home = homePoses(w2.placements, w2.byName).get('Bo')!;
    actors.setHomes(w2.placements, w2.byName, true);

    expect(actors.active()).toBe(true);
    const start = actors.poses().get('Bo')!;
    expect(Math.hypot(start.lx - home.lx, start.ly - home.ly)).toBeGreaterThan(50); // near the door
    settle(actors);
    const end = actors.poses().get('Bo')!;
    expect(end.lx).toBeCloseTo(home.lx, 3);
    expect(end.ly).toBeCloseTo(home.ly, 3);
    expect(actors.nodes().has('Bo')).toBe(true);
  });

  it('walks a departure out to the door, then drops it', () => {
    const actors = createActors();
    const w1 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w1.placements, w1.byName, true);
    const w2 = world([node('Ada')]);
    actors.setHomes(w2.placements, w2.byName, true);

    expect(actors.active()).toBe(true);
    // still drawn (as a retained ghost) while walking out
    expect(actors.nodes().has('Bo')).toBe(true);
    expect(actors.poses().has('Bo')).toBe(true);
    settle(actors);
    // gone once it reaches the door
    expect(actors.nodes().has('Bo')).toBe(false);
    expect(actors.poses().has('Bo')).toBe(false);
  });

  it('a member going away walks off the floor — the body leaves, the desk stays theirs', () => {
    const actors = createActors();
    const present = world([node('Ada'), node('Bo')]);
    actors.setHomes(present.placements, present.byName, true);
    const away = world([node('Ada'), node('Bo', 'away')]);
    actors.setHomes(away.placements, away.byName, true);

    settle(actors);
    expect(actors.poses().has('Bo')).toBe(false);
    expect(away.placements.get('Bo')).toMatchObject({ kind: 'desk', owned: true });
  });

  it('snaps without animating when animate=false (reduced motion)', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, true);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, false);
    expect(actors.active()).toBe(false);
    const home = homePoses(w2.placements, w2.byName).get('Bo')!;
    expect(actors.poses().get('Bo')!.lx).toBeCloseTo(home.lx, 3);
  });
});

describe('door staging', () => {
  it('counts a door pulse per arrival/departure and clears on read (none on first snap)', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true); // first call snaps
    expect(actors.takeDoorPulses()).toBe(0);

    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true); // Bo arrives
    expect(actors.takeDoorPulses()).toBe(1);
    expect(actors.takeDoorPulses()).toBe(0); // cleared

    actors.setHomes(one.placements, one.byName, true); // Bo departs
    expect(actors.takeDoorPulses()).toBe(1);
  });

  it('counts arrivals separately from departures (the dog only gets up for arrivals)', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true); // first call snaps
    expect(actors.takeArrivals()).toBe(0);

    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true); // Bo arrives
    expect(actors.takeArrivals()).toBe(1);
    expect(actors.takeArrivals()).toBe(0); // cleared
    actors.takeDoorPulses(); // (drain the pulse the arrival raised — the two counters read independently)

    actors.setHomes(one.placements, one.byName, true); // Bo departs — a door pulse, but not an arrival
    expect(actors.takeDoorPulses()).toBe(1);
    expect(actors.takeArrivals()).toBe(0);
  });

  it('fades an arrival in from transparent to opaque', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true);
    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true);

    expect(actors.poses().get('Bo')!.alpha).toBeLessThan(0.2); // just emerged from the door
    let g = 0;
    while (actors.active() && g++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Bo')!.alpha).toBe(1); // seated, fully opaque
  });
});

describe('the phone call', () => {
  it('stands up, keeps the phone at the ear the whole way round, and sits back down', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.errandPhone('Ada')).toBe(true);
    let sawWalkingOnPhone = false;
    let sawStanding = false;
    let farthest = 0;
    let guard = 0;
    while (actors.active() && guard++ < 6000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      if (p.sit < 0.5) sawStanding = true;
      // The whole point of the beat: the pose survives the walk cycle. A caller whose arm only comes up
      // while standing still is somebody checking their phone, not somebody on a call.
      if (p.moving && p.carry === 'phone' && p.gesture === GESTURE.call) sawWalkingOnPhone = true;
      farthest = Math.max(farthest, Math.hypot(p.lx - home.lx, p.ly - home.ly));
    }
    expect(sawStanding).toBe(true);
    expect(sawWalkingOnPhone).toBe(true);
    expect(farthest).toBeGreaterThan(120); // actually went wandering, not a lap of the desk

    seated(actors, 'Ada');
    const done = actors.poses().get('Ada')!;
    expect(done.lx).toBeCloseTo(home.lx, 5);
    expect(done.ly).toBeCloseTo(home.ly, 5);
    expect(done.carry).toBeNull(); // phone back in the pocket
  });

  it('will not pull a member out of the nook or off another errand', () => {
    const { placements, byName } = world([node('Bo', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.errandPhone('Bo')).toBe(false);
  });
});

describe('neighbour conversations', () => {
  /** A full desk row: enough working members that at least one pod row fills up side by side. */
  function fullRoom() {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    const { placements, byName } = world(nodes);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return actors;
  }

  it('finds side-by-side desk pairs to offer', () => {
    const actors = fullRoom();
    const pairs = actors.deskNeighbours();
    expect(pairs.length).toBeGreaterThan(0);
    // Each pair really is one desk apart and facing the same way.
    for (const [a, b] of pairs) {
      const pa = actors.poses().get(a)!;
      const pb = actors.poses().get(b)!;
      expect(pa.dir).toBe(pb.dir);
      expect(Math.hypot(pa.lx - pb.lx, pa.ly - pb.ly)).toBeLessThan(130);
    }
  });

  it('turns both of them toward each other and leaves them seated the whole time', () => {
    const actors = fullRoom();
    const [a, b] = actors.deskNeighbours()[0]!;
    const before = actors.poses().get(a)!.dir;
    expect(actors.deskChat(a, b)).toBe(true);

    let minSit = 1;
    let turned = false;
    let guard = 0;
    while (actors.active() && guard++ < 1200) {
      actors.step(0.05);
      const pa = actors.poses().get(a)!;
      minSit = Math.min(minSit, pa.sit);
      if (pa.dir !== before) turned = true;
    }
    expect(turned).toBe(true); // they actually swivelled to face each other
    expect(minSit).toBeGreaterThan(0.9); // and never got out of the chair to do it
    expect(actors.poses().get(a)!.dir).toBe(before); // back to the monitor afterwards
  });

  it('offers nobody who is already busy', () => {
    const actors = fullRoom();
    const [a, b] = actors.deskNeighbours()[0]!;
    actors.deskChat(a, b);
    expect(actors.deskNeighbours().some(([x, y]) => x === a || y === a)).toBe(false);
  });
});

describe('the room notices (ADR 617)', () => {
  function fullRoom() {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    const { placements, byName } = world(nodes);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return actors;
  }

  it('turns a seated member toward what moved, keeps them in the chair, then back to the desk', () => {
    const actors = fullRoom();
    const [a] = actors.deskNeighbours()[0]!;
    const home = actors.poses().get(a)!;
    // Somewhere off to the side of their desk: a quarter turn away from where they face.
    const target = { lx: home.lx + 120, ly: home.ly - 120 };
    expect(actors.notice(a, target, () => 0.5)).toBe(true);
    let minSit = 1;
    let turned = false;
    let guard = 0;
    while (actors.active() && guard++ < 1200) {
      actors.step(0.05);
      const p = actors.poses().get(a)!;
      minSit = Math.min(minSit, p.sit);
      if (p.dir !== home.dir) turned = true;
    }
    expect(turned).toBe(true);
    expect(minSit).toBeGreaterThan(0.9);
    expect(actors.poses().get(a)!.dir).toBe(home.dir);
  });

  it('declines a member who is already busy, so the scene can fall back to a gesture', () => {
    const actors = fullRoom();
    const [a, b] = actors.deskNeighbours()[0]!;
    actors.deskChat(a, b);
    const h = actors.poses().get(a)!;
    expect(actors.notice(a, { lx: h.lx + 100, ly: h.ly }, () => 0.5)).toBe(false);
  });
});

describe('the check-in beat', () => {
  it('does NOT fire for members already present on the first snapshot', () => {
    // The first reconcile is how a page load seats the room. Everyone in it is "new" to the client
    // but none of them just arrived — without this gate a refresh replays the whole ritual and you
    // get the roster queueing at the door because somebody hit reload.
    const actors = createActors();
    const w = world([node('Ada'), node('Bo'), node('Cy')]);
    actors.setHomes(w.placements, w.byName, false);
    expect(actors.pendingCheckIns()).toHaveLength(0);
  });

  it('fires exactly once for a member who appears in a later update', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.pendingCheckIns()).toEqual(['Bo']);
  });

  it('checks simultaneous arrivals in at their own marks, in parallel', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo'), node('Cy'), node('Dev')]);
    actors.setHomes(w2.placements, w2.byName, true);
    const marks = actors.pendingCheckIns().map((n) => actors.checkInMark(n));
    expect(new Set(marks).size).toBe(marks.length); // distinct marks, not a queue
  });

  it('pauses at the mark — the receptionist sees a hold while the beat plays', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    let sawHold = false;
    for (let i = 0; i < 400 && actors.active(); i++) {
      actors.step(0.05);
      if (actors.checkInHolds() > 0) sawHold = true;
    }
    expect(sawHold).toBe(true);
  });

  it('never strands an arrival at the mark — the beat ends and they reach their seat', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    expect(actors.pendingCheckIns()).toHaveLength(0);
    const home = homePoses(w2.placements, w2.byName).get('Bo')!;
    const pose = actors.poses().get('Bo')!;
    expect(Math.hypot(pose.lx - home.lx, pose.ly - home.ly)).toBeLessThan(2);
  });

  it('an away arrival (small, into the nook) skips the ceremony', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo', 'away')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.pendingCheckIns()).toHaveLength(0);
  });
});

describe('deskNeighbourPairs — the shared pair pool (E1 spec §2)', () => {
  /** Same roster as fullRoom, but keeping the shared inputs to compare pure vs scene-state pools. */
  function fullWorld() {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    const { placements, byName } = world(nodes);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return { placements, byName, actors };
  }

  /** A room with members sitting somewhere OTHER than a desk. `active` (between claims) is what puts
   *  someone on the leisure furniture — it is not desk overflow, which is the wrong guess I made
   *  first and the guard assertion below caught. The 12-desk fixture above has no leisure sitters at
   *  all, which is why it could not see the two pools disagree (2026-09-14). */
  function loungeWorld() {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    for (let i = 0; i < 5; i++) nodes[i]!.posture = 'active';
    const { placements, byName } = world(nodes);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return { placements, byName, actors };
  }

  it('the two pools still agree once members sit somewhere other than a desk', () => {
    const { placements, byName, actors } = loungeWorld();
    const leisure = [...placements.values()].filter((p) => p.kind === 'leisure');
    // Guard the guard: if seating ever stops overflowing, this test silently stops testing anything.
    expect(leisure.length, 'fixture must actually seat someone off-desk').toBeGreaterThan(0);
    expect(deskNeighbourPairs(placements, byName)).toEqual(actors.deskNeighbours());
  });

  it('pairs two members in the same leisure zone, and never across zones', () => {
    const { placements, byName } = loungeWorld();
    const zoneOf = new Map<string, string>();
    for (const [name, pl] of placements) {
      if (pl.kind === 'leisure') zoneOf.set(name, LEISURE_SPOTS[pl.spot]?.zone ?? '?');
    }
    const pairs = deskNeighbourPairs(placements, byName).filter(
      ([a, b]) => zoneOf.has(a) && zoneOf.has(b),
    );
    for (const [a, b] of pairs) {
      expect(zoneOf.get(a), `${a} and ${b} must share a zone`).toBe(zoneOf.get(b));
    }
  });

  it('matches the scene-state pool exactly when nobody is busy', () => {
    const { placements, byName, actors } = fullWorld();
    expect(deskNeighbourPairs(placements, byName)).toEqual(actors.deskNeighbours());
  });

  it('is pure over roster inputs: local busy-state cannot shrink it', () => {
    const { placements, byName, actors } = fullWorld();
    const before = deskNeighbourPairs(placements, byName);
    const [a, b] = before[0]!;
    actors.deskChat(a, b); // one browser has a chat in flight; the shared pool must not know
    expect(deskNeighbourPairs(placements, byName)).toEqual(before);
    expect(actors.deskNeighbours().some(([x, y]) => x === a || y === a)).toBe(false);
  });

  it('returns pairs in canonical order — same value on every viewer regardless of Map history', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    const forward = world(nodes);
    const reversed = world([...nodes].reverse());
    const rebuilt = deskNeighbourPairs(
      new Map([...reversed.placements].sort(() => -1)),
      reversed.byName,
    );
    expect(rebuilt).toEqual(deskNeighbourPairs(forward.placements, forward.byName));
  });
});

describe('ambient beats under an injected rng (E1 spec §2)', () => {
  /** Two independent scene instances over the same roster — stand-ins for two browsers. */
  function twoViewers() {
    const nodes = Array.from({ length: 12 }, (_, i) => node('N' + String(i).padStart(2, '0')));
    const make = () => {
      const { placements, byName } = world(nodes);
      const actors = createActors();
      actors.setHomes(placements, byName, true);
      return actors;
    };
    return [make(), make()] as const;
  }

  it('two viewers play the same phone errand identically from the same slot rng', () => {
    const [a, b] = twoViewers();
    expect(a.errandPhone('N03', slotRng('revive', 7, 'phone'))).toBe(true);
    expect(b.errandPhone('N03', slotRng('revive', 7, 'phone'))).toBe(true);
    let guard = 0;
    while ((a.active() || b.active()) && guard++ < 4000) {
      a.step(0.05);
      b.step(0.05);
      expect(a.poses().get('N03')).toEqual(b.poses().get('N03'));
    }
    expect(guard).toBeLessThan(4000);
  });

  it('two viewers play the same desk chat for the same length', () => {
    const [a, b] = twoViewers();
    const [x, y] = a.deskNeighbours()[0]!;
    expect(a.deskChat(x, y, slotRng('revive', 9, 'chat'))).toBe(true);
    expect(b.deskChat(x, y, slotRng('revive', 9, 'chat'))).toBe(true);
    let aTicks = 0;
    let bTicks = 0;
    for (let i = 0; i < 4000 && a.active(); i++, aTicks++) a.step(0.05);
    for (let i = 0; i < 4000 && b.active(); i++, bTicks++) b.step(0.05);
    expect(aTicks).toBe(bTicks);
  });

  it('two viewers send the same member to the same lounge seat', () => {
    const [a, b] = twoViewers();
    const seatA = a.errandFridge('N05', slotRng('revive', 4, 'fridge'));
    const seatB = b.errandFridge('N05', slotRng('revive', 4, 'fridge'));
    expect(seatA).not.toBeNull();
    expect(seatA).toEqual(seatB);
  });
});

describe('the laptop on the person (laptop/dock design §0)', () => {
  /** An idle member: on the floor, not working — so their laptop is never in a dock. `active` is what
   *  the composed posture calls idle-but-present (`memberPosture`), and it is what seating reads. */
  function idle(name: string): OfficeNode {
    return { ...node(name), activity: 'active', posture: 'active' };
  }

  it('a working member has empty hands — their laptop is docked at the desk they are sitting at', () => {
    const { placements, byName } = world([node('Ada')]);
    expect(homePoses(placements, byName).get('Ada')!.carry).toBeNull();
  });

  it('an idle member holds it — seated at a leisure spot, it is in their lap', () => {
    const { placements, byName } = world([idle('Ada')]);
    const pose = homePoses(placements, byName).get('Ada')!;
    expect(placements.get('Ada')!.kind).toBe('leisure');
    expect(pose.carry).toBe('laptop');
  });

  /** Walk `who` in from the door onto an empty floor, and return their pose one step in. */
  function arriving(who: OfficeNode) {
    const actors = createActors();
    const empty = world([]);
    actors.setHomes(empty.placements, empty.byName, true); // an empty floor, settled
    const { placements, byName } = world([who]);
    actors.setHomes(placements, byName, true); // …then they appear: a walk in from the door
    actors.step(0.05);
    return actors.poses().get(who.name)!;
  }

  it('the entrance walk carries it: an idle member arrives with it under their arm', () => {
    const p = arriving(idle('Ada'));
    expect(Math.hypot(p.lx - ENTRANCE.lx, p.ly - ENTRANCE.ly)).toBeLessThan(40); // still at the door
    expect(p.carry).toBe('laptop');
  });

  it('so does a member who comes online ALREADY working — a walker is not at their desk', () => {
    // The regression nick caught (2026-09-04): reading posture here meant someone who appeared as
    // `working` walked in empty-handed, because the predicate said their laptop was already in a
    // dock they had not reached yet. Crossing the floor is not being at your desk, whatever the
    // roster says — so the walk carries it, and the dock stays empty until they sit (render side).
    const p = arriving(node('Ada'));
    expect(Math.hypot(p.lx - ENTRANCE.lx, p.ly - ENTRANCE.ly)).toBeLessThan(40);
    expect(p.carry).toBe('laptop');
  });

  it('every non-errand walk carries it: a help walk there, the hold, and the walk home (v3-6 audit)', () => {
    // An errand's prop WINS for its duration (the plate, the bottle, the box); an act walk names no
    // prop, so the laptop is under the arm for every leg of it.
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    for (let i = 0; i < 60; i++) actors.step(0.05); // settle at the desk
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    let frames = 0;
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      if (p.sit > 0.9) continue; // back in the chair: the dock takes it
      frames++;
      expect(p.carry).toBe('laptop');
    }
    expect(frames).toBeGreaterThan(20);
  });

  it('and they still have it mid-walk, not only at the door', () => {
    const actors = createActors();
    const empty = world([]);
    actors.setHomes(empty.placements, empty.byName, true);
    const { placements, byName } = world([node('Ada')]);
    actors.setHomes(placements, byName, true);
    let carried = 0;
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      actors.step(0.05);
      if (actors.poses().get('Ada')!.carry === 'laptop') carried++;
    }
    expect(carried).toBeGreaterThan(5); // held for the crossing, not a single frame at the threshold
    seated(actors, 'Ada');
    expect(actors.poses().get('Ada')!.carry).toBeNull(); // …and docked once they are home and SEATED
  });

  it('holds it through the sit blend — the laptop is never nowhere (gptbot, reviewing #1304)', () => {
    // The dock fills on `workingAtDesk(node, sit)`, which needs `sit > 0.9`; the carry was read off
    // `carriesLaptop(node)`, which goes false the moment the roster says `working`. Between those two
    // thresholds a working member was neither carrying the laptop nor docking it — it existed
    // NOWHERE for the length of the blend. Reproduced on the sit-down at the end of a water errand:
    // at home, not walking, sit 0.083, carry null, dock empty.
    //
    // One predicate means one predicate, read off the same frame's pose: the hand lets go exactly
    // when the dock takes it.
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    for (let i = 0; i < 60; i++) actors.step(0.05); // settle at the desk
    expect(actors.errandWater('Ada')).toBe(true);

    let sawRamp = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      // At home, mid-sit, and holding no errand prop — the frames where the laptop is the only thing
      // the hands could have, and the dock does not have it yet.
      if (!p.moving && p.sit <= 0.9 && p.carry !== 'bottle') {
        sawRamp = true;
        expect({ sit: Number(p.sit.toFixed(3)), carry: p.carry }).toEqual({
          sit: Number(p.sit.toFixed(3)),
          carry: 'laptop',
        });
      }
    }
    expect(sawRamp).toBe(true); // the ramp was actually observed, not skipped in one step
    seated(actors, 'Ada');
    expect(actors.poses().get('Ada')!.carry).toBeNull(); // seated past 0.9 again: the dock has it
  });

  it('an errand outranks the laptop for its duration, and the laptop is back when it ends', () => {
    const { placements, byName } = world([idle('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.poses().get('Ada')!.carry).toBe('laptop'); // idle at home: on the person

    expect(actors.errandWater('Ada')).toBe(true);
    actors.step(0.1); // inside the pick-it-up hold
    expect(actors.poses().get('Ada')!.carry).toBe('bottle'); // you put the laptop down to fill a bottle

    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Ada')!.carry).toBe('laptop'); // and it is back on the arm afterwards
  });

  it('posture is read live: a member who stops working picks their laptop up without a reseat', () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.poses().get('Ada')!.carry).toBeNull();
    // Same placements object — only the roster node changed. `homes` would not rebuild on its own,
    // which is exactly why the carry is derived per frame rather than baked into the home pose.
    actors.setHomes(placements, new Map([['Ada', idle('Ada')]]), true);
    expect(actors.poses().get('Ada')!.carry).toBe('laptop');
  });
});

describe('the gesture window table', () => {
  /*
   * Lane 01M2JYBGMQ, finding 2 (delta, re-read by izzo). Four ids shipped in #1430 with no entry
   * here — shoulders/behindHead/rubEyes/pocketPhone all fell through `?? 2.4` to the SHORTEST
   * window in the table, two of them held poses where the duration *is* the beat. It shipped
   * because `Record<number, number>` cannot report that it is incomplete. The type now can;
   * this is the runtime half of the same claim, so a new beat cannot slip past either.
   */
  it('declares a window for every beat the scheduler can pick — and for nothing else', () => {
    expect(
      Object.keys(GESTURE_DUR)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...IDLE_GESTURES].sort((a, b) => a - b));
  });

  it('no beat rides the old 2.4s fallback by accident — every window is one somebody chose', () => {
    for (const kind of IDLE_GESTURES) {
      expect(GESTURE_DUR[kind], `gesture ${String(kind)} has no declared window`).toBeGreaterThan(
        0,
      );
    }
  });

  it('a held pose outlasts the quickest arc — behindHead is not a twitch', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.gestureBeat('Ada', GESTURE.behindHead)).toBe(true);
    expect(actors.gestureBeat('Bo', GESTURE.glance)).toBe(true);
    for (let i = 0; i < 68; i++) actors.step(0.05); // 3.4s: past glance (2.4s)
    expect(actors.poses().get('Bo')!.gesture).toBe(0);
    expect(actors.poses().get('Ada')!.gesture).toBe(GESTURE.behindHead); // still laced behind the head
  });

  it('settle stays the longest of them — getting comfortable is not a quick motion', () => {
    const longest = Math.max(...IDLE_GESTURES.map((k) => GESTURE_DUR[k]));
    expect(GESTURE_DUR[GESTURE.settle]).toBe(longest);
  });
});

/**
 * The runtime half of what `Record<IdleGesture, number>` promises at compile time.
 *
 * The type stops a MISSING key. It cannot stop a present key holding something unusable, and the
 * failure this guards is not a wrong number — it is `dur` being absent or non-finite, which makes
 * `g.t >= g.dur` permanently false and strands the member mid-beat (izzo, reviewing #1434).
 */
describe('GESTURE_DUR covers every scheduler beat with a usable window', () => {
  it('has a finite, positive window for each one', () => {
    for (const kind of IDLE_GESTURES) {
      const dur = GESTURE_DUR[kind];
      expect(Number.isFinite(dur), `gesture ${kind} has no usable window`).toBe(true);
      expect(dur).toBeGreaterThan(0);
    }
  });
});

describe('first arrival (lane 01M3F81DD9)', () => {
  it('a flagged arrival carries the moving box and stands longer at the mark', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    actors.expectFirstArrival('Bo', 'movingBox');
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.pendingCheckIns()).toEqual(['Bo']);
    let sawBox = false;
    let heldFor = 0;
    for (let i = 0; i < 600 && actors.active(); i++) {
      actors.step(0.05);
      const p = actors.poses().get('Bo');
      if (p?.carry === 'movingBox') sawBox = true;
      if (actors.checkInHolds() > 0) heldFor += 0.05;
    }
    expect(sawBox).toBe(true);
    expect(heldFor).toBeGreaterThan(FIRST_ARRIVAL_HOLD_S - 0.2);
    seated(actors, 'Bo');
    expect(actors.isSeated('Bo')).toBe(true);
  });

  it('the flag is spent by the arrival it was set for — the next walk-in is ordinary', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    actors.expectFirstArrival('Bo', 'movingBox');
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    for (let i = 0; i < 600 && actors.active(); i++) actors.step(0.05);
    actors.setHomes(w1.placements, w1.byName, true); // Bo leaves
    for (let i = 0; i < 600 && actors.active(); i++) actors.step(0.05);
    actors.setHomes(w2.placements, w2.byName, true); // …and comes back
    let sawBox = false;
    for (let i = 0; i < 600 && actors.active(); i++) {
      actors.step(0.05);
      if (actors.poses().get('Bo')?.carry === 'movingBox') sawBox = true;
    }
    expect(sawBox).toBe(false);
  });

  it('an unflagged arrival never carries the moving box (their laptop is theirs to carry)', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    let sawBox = false;
    for (let i = 0; i < 600 && actors.active(); i++) {
      actors.step(0.05);
      if (actors.poses().get('Bo')?.carry === 'movingBox') sawBox = true;
    }
    expect(sawBox).toBe(false);
  });

  it('isSeated is false mid-walk and true once they have sat down', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    expect(actors.isSeated('Ada')).toBe(true); // snapped home, already in the chair
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    actors.step(0.05);
    expect(actors.isSeated('Bo')).toBe(false);
    expect(actors.isSeated('nobody')).toBe(false);
  });
});

describe('the welcome wave (lane 01M3F81DD9)', () => {
  it('plays on a seated, free desk member', () => {
    const actors = createActors();
    const w = world([node('Ada')]);
    actors.setHomes(w.placements, w.byName, false);
    expect(actors.welcomeWave('Ada')).toBe(true);
    actors.step(0.05);
    expect(actors.poses().get('Ada')?.gesture).toBe(GESTURE.wave);
  });

  it('is refused for someone mid-walk or already gesturing', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.welcomeWave('Bo')).toBe(false); // walking in
    expect(actors.welcomeWave('Ada')).toBe(true);
    expect(actors.welcomeWave('Ada')).toBe(false); // already waving
  });
});

describe('what the Welcome Wagon asks the actors (lane 01M3F81DD9)', () => {
  it('actWalking counts a real act walk, never an arrival', () => {
    const actors = createActors();
    const w1 = world([node('Ada'), node('Cy')]);
    actors.setHomes(w1.placements, w1.byName, false);
    const w2 = world([node('Ada'), node('Cy'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.active()).toBe(true); // Bo is walking in…
    expect(actors.actWalking()).toBe(false); // …which is presence, not an act
    expect(actors.walk('Ada', { kind: 'help', to: 'Cy', urgent: false })).toBe(true);
    expect(actors.actWalking()).toBe(true);
  });

  it('reachedMark is false on the way to the mark and true from the pause onward', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, false);
    expect(actors.reachedMark('Ada')).toBe(true); // not checking in at all
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, true);
    expect(actors.reachedMark('Bo')).toBe(false);
    let reached = false;
    for (let i = 0; i < 400 && !reached; i++) {
      actors.step(0.05);
      reached = actors.reachedMark('Bo');
    }
    expect(reached).toBe(true);
    expect(actors.checkInHolds()).toBe(1); // it turned true AT the mark, not after walking on
  });
});

/**
 * Claiming a lane (nick, 2026-10-09): the claimer walks to the wall board, stands and thinks, reaches
 * up and takes the card, carries it home and sets it down. The card leaves the wall at the reach —
 * `takenSeeds()` is what the board painter reads — and not before.
 */
describe('claiming a lane at the board', () => {
  const SEED = 0xc1a1;
  const run = () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return { actors, home: actors.poses().get('Ada')! };
  };

  it('walks to the board, thinks there, takes the card, and carries it home', () => {
    const { actors, home } = run();
    expect(actors.claim('Ada', SEED)).toBe(true);
    const seen = {
      nearBoard: Infinity,
      chin: false,
      reach: false,
      cardCarried: false,
      takenEarly: false,
    };
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      seen.nearBoard = Math.min(
        seen.nearBoard,
        Math.hypot(p.lx - BOARD_STAND.lx, p.ly - BOARD_STAND.ly),
      );
      if (p.gesture === GESTURE.chin) {
        seen.chin = true;
        if (actors.takenSeeds().includes(SEED)) seen.takenEarly = true;
      }
      if (p.gesture === GESTURE.reach) seen.reach = true;
      if (p.carry === 'card') seen.cardCarried = true;
    }
    expect(actors.active()).toBe(false);
    expect(seen.nearBoard).toBeLessThan(12);
    expect(seen.chin).toBe(true);
    expect(seen.reach).toBe(true);
    expect(seen.cardCarried).toBe(true);
    expect(seen.takenEarly).toBe(false); // the card stays on the wall while they think
    seated(actors, 'Ada');
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
    expect(back.carry).not.toBe('card');
  });

  it('plays at REPLAY_TEMPO: a replayed claim lands in half the frames (lane 01M50TZA8X)', () => {
    const frames = (tempo: number) => {
      const { actors } = run();
      actors.claim('Ada', SEED);
      let n = 0;
      while (actors.active() && n < 8000) {
        actors.step(0.05 * tempo); // the frame loop's `actors.step(dt * tempo)`
        n++;
      }
      return n;
    };
    const live = frames(1);
    const replayed = frames(REPLAY_TEMPO);
    expect(REPLAY_TEMPO).toBe(2);
    expect(Math.abs(live / replayed - REPLAY_TEMPO)).toBeLessThan(0.1);
  });

  it('reports the card as taken from the reach until the walk ends', () => {
    const { actors } = run();
    actors.claim('Ada', SEED);
    let takenWhileCarrying = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      if (actors.poses().get('Ada')!.carry === 'card' && actors.takenSeeds().includes(SEED))
        takenWhileCarrying = true;
    }
    expect(takenWhileCarrying).toBe(true);
    expect(actors.takenSeeds()).toEqual([]);
  });

  it('is a real act: it preempts an errand and refuses a member who is not in the room', () => {
    const { actors } = run();
    expect(actors.claim('Nobody', SEED)).toBe(false);
    expect(actors.ambientWalk('Ada')).toBe(true);
    actors.step(0.3);
    expect(actors.claim('Ada', SEED)).toBe(true);
    let chin = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      if (actors.poses().get('Ada')!.gesture === GESTURE.chin) chin = true;
    }
    expect(chin).toBe(true);
  });
});

/**
 * Finishing a lane (nick, 2026-10-12): the owner picks the card up at the desk, carries it to the wall
 * board, reaches and pins it, looks at it a beat, and walks home empty-handed. The card reaches the
 * cork at the pin — `pinnedSeeds()` is what the board painter reads — and not before.
 */
describe('pinning a finished lane on the board', () => {
  const SEED = 0xd0e;
  const run = () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return { actors, home: actors.poses().get('Ada')! };
  };

  it('carries the card to the board, pins it, and comes home without it', () => {
    const { actors, home } = run();
    expect(actors.pin('Ada', SEED, 'done')).toBe(true);
    const seen = {
      nearBoard: Infinity,
      carriedOut: false,
      reach: false,
      chin: false,
      pinnedEarly: false,
      carriedBack: false,
    };
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      const d = Math.hypot(p.lx - BOARD_STAND.lx, p.ly - BOARD_STAND.ly);
      seen.nearBoard = Math.min(seen.nearBoard, d);
      if (p.carry === 'card' && d > 12) {
        if (actors.pinnedSeeds().length)
          seen.carriedBack = true; // in hand after the pin = wrong
        else seen.carriedOut = true;
        if (actors.pinnedSeeds().length) seen.pinnedEarly = true;
      }
      if (p.gesture === GESTURE.reach) seen.reach = true;
      if (p.gesture === GESTURE.chin) seen.chin = true;
    }
    expect(actors.active()).toBe(false);
    expect(seen.nearBoard).toBeLessThan(12);
    expect(seen.carriedOut).toBe(true);
    expect(seen.reach).toBe(true);
    expect(seen.chin).toBe(true);
    expect(seen.pinnedEarly).toBe(false);
    expect(seen.carriedBack).toBe(false);
    seated(actors, 'Ada');
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
    expect(back.carry).not.toBe('card');
  });

  it('reports the card as pinned, under its column, from the pin until the walk ends', () => {
    const { actors } = run();
    actors.pin('Ada', SEED, 'awaiting_acceptance');
    let pinnedEmptyHanded = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      const pinned = actors.pinnedSeeds();
      if (pinned.length && actors.poses().get('Ada')!.carry !== 'card') {
        pinnedEmptyHanded = true;
        expect(pinned).toEqual([{ seed: SEED, state: 'awaiting_acceptance' }]);
      }
    }
    expect(pinnedEmptyHanded).toBe(true);
    expect(actors.pinnedSeeds()).toEqual([]);
  });

  it('is a real act: it preempts an errand and refuses a member who is not in the room', () => {
    const { actors } = run();
    expect(actors.pin('Nobody', SEED, 'done')).toBe(false);
    expect(actors.ambientWalk('Ada')).toBe(true);
    actors.step(0.3);
    expect(actors.pin('Ada', SEED, 'done')).toBe(true);
    let reach = false;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(0.05);
      if (actors.poses().get('Ada')!.gesture === GESTURE.reach) reach = true;
    }
    expect(reach).toBe(true);
  });
});

/**
 * The aisle meet (nick, 2026-10-12): two idle desk members get up, meet between their desks, talk a
 * few seconds facing each other, and go back. Ambient — a real act sends both home.
 */
describe('meeting in the aisle', () => {
  const run = () => {
    const { placements, byName } = world([node('ghost'), node('Ada'), node('Cy')]); // ghost + Ada, not Ada + Bo: at 22 seats (and again after the café rework) the pair has to hash to desks within five legs of one aisle (2026-10-27)
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    return {
      actors,
      homes: new Map([...actors.poses()].map(([n, p]) => [n, { lx: p.lx, ly: p.ly }])),
    };
  };

  it('both leave home, stand near each other, exchange gestures, and both come back', () => {
    const { actors, homes } = run();
    expect(actors.aisleMeet('ghost', 'Ada', () => 0.5)).toBe(true);
    let closest = Infinity;
    let bothOut = false;
    let gestured = false;
    let guard = 0;
    while (actors.active() && guard++ < 6000) {
      actors.step(0.05);
      const a = actors.poses().get('ghost')!;
      const b = actors.poses().get('Ada')!;
      const d = Math.hypot(a.lx - b.lx, a.ly - b.ly);
      closest = Math.min(closest, d);
      const ha = homes.get('ghost')!;
      const hb = homes.get('Ada')!;
      if (
        Math.hypot(a.lx - ha.lx, a.ly - ha.ly) > 10 &&
        Math.hypot(b.lx - hb.lx, b.ly - hb.ly) > 10
      )
        bothOut = true;
      if (a.gesture && b.gesture && d < 60) gestured = true;
    }
    expect(actors.active()).toBe(false);
    expect(bothOut).toBe(true);
    expect(closest).toBeLessThan(60);
    expect(closest).toBeGreaterThan(4); // facing each other, not inside each other
    expect(gestured).toBe(true);
    for (const n of ['ghost', 'Ada']) {
      seated(actors, n);
      const p = actors.poses().get(n)!;
      expect(p.lx).toBeCloseTo(homes.get(n)!.lx, 5);
      expect(p.ly).toBeCloseTo(homes.get(n)!.ly, 5);
    }
  });

  it('is ambient: a real act for either sends both home, and a busy member refuses', () => {
    const { actors } = run();
    expect(actors.aisleMeet('ghost', 'ghost')).toBe(false);
    expect(actors.aisleMeet('ghost', 'Nobody')).toBe(false);
    expect(actors.aisleMeet('ghost', 'Ada')).toBe(true);
    expect(actors.aisleMeet('ghost', 'Cy')).toBe(false); // Ada is already on her way
    for (let i = 0; i < 20; i++) actors.step(0.1);
    expect(actors.ambientOnly()).toBe(true);
    actors.cancelAmbient();
    let guard = 0;
    while (actors.active() && guard++ < 6000) actors.step(0.05);
    expect(actors.ambientOnly()).toBe(false);
  });
});

describe('a conversation (lane 01M5XS6GYM): who turns to whom', () => {
  it('everyone addressed turns to the speaker, the speaker turns to the first of them present, nobody to themself', () => {
    const poses = new Map([
      ['Ada', { lx: 100, ly: 100 }],
      ['Bo', { lx: 300, ly: 100 }],
      ['Cy', { lx: 100, ly: 300 }],
    ]);
    expect(conversationLooks('Ada', ['Bo', 'Cy'], poses)).toEqual([
      { who: 'Bo', at: { lx: 100, ly: 100 } },
      { who: 'Cy', at: { lx: 100, ly: 100 } },
      { who: 'Ada', at: { lx: 300, ly: 100 } },
    ]);
    expect(conversationLooks('Ada', ['Ada', 'Zed'], poses)).toEqual([]); // self and the absent are skipped
    expect(conversationLooks('Zed', ['Ada'], poses)).toEqual([]); // an absent speaker turns nobody
    expect(conversationLooks('Ada', [], poses)).toEqual([]); // a team act is nobody's conversation
  });
});

describe('heads that look (lane 01M5XS5ZYP): lookAt', () => {
  it('turns a seated desk member’s head toward a point, quantised to 45° or 90° on the nearer side', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const h = actors.poses().get('Ada')!;
    const [fx, fy] = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] }[h.dir] as [number, number];
    // The "L" clips turn clockwise in floor coords (y down): east-facing toward south, north-facing
    // toward east — what the rendered stills show (actors.ts `lookToward`).
    const [lx, ly] = [-fy, fx];
    const at = (ax: number, ay: number) => ({ lx: h.lx + ax * 100, ly: h.ly + ay * 100 });
    // straight ahead: nothing to turn toward
    expect(actors.lookAt('Ada', at(fx, fy))).toBe(0);
    // 45° off to the left, and 90° to the left
    expect(actors.lookAt('Ada', at(fx + lx, fy + ly))).toBe(GESTURE.look45L);
    actors.cancelAmbient('Ada');
    expect(actors.lookAt('Ada', at(lx, ly))).toBe(GESTURE.look90L);
    actors.cancelAmbient('Ada');
    // to the right, and behind on the right — behind is a 90°, never an owl
    expect(actors.lookAt('Ada', at(-lx, -ly))).toBe(GESTURE.look90R);
    actors.cancelAmbient('Ada');
    expect(actors.lookAt('Ada', at(-fx - lx, -fy - ly))).toBe(GESTURE.look90R);
  });

  it('is a held beat the member returns from on its own, and refuses the busy or the small', () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Zoe', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const h = actors.poses().get('Ada')!;
    const at = { lx: h.lx + (h.dir === 'E' || h.dir === 'W' ? 0 : 100), ly: h.ly + (h.dir === 'E' || h.dir === 'W' ? 100 : 0) };
    expect(actors.lookAt('Zoe', at)).toBe(0); // the nook's small figures don't
    expect(actors.lookAt('Ada', at, { hold: 1.0 })).not.toBe(0);
    expect(actors.lookAt('Ada', at)).toBe(0); // already looking
    expect(actors.ambientOnly()).toBe(true);
    actors.step(0.5);
    expect([GESTURE.look90L, GESTURE.look90R]).toContain(actors.poses().get('Ada')!.gesture);
    let g = 0;
    while (actors.active() && g++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
  });

  it('a dnd member keeps typing — do-not-disturb is honoured by the look as by every other interruption', () => {
    const { placements, byName } = world([{ ...node('Ada'), dnd: true }, node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const h = actors.poses().get('Ada')!;
    const at = { lx: h.lx + (h.dir === 'E' || h.dir === 'W' ? 0 : 100), ly: h.ly + (h.dir === 'E' || h.dir === 'W' ? 100 : 0) };
    expect(actors.lookAt('Ada', at)).toBe(0);
    expect(actors.active()).toBe(false);
  });

  it('a delayed look stays at rest until its delay has passed, so a row of heads turns in sequence', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const h = actors.poses().get('Ada')!;
    const at = { lx: h.lx + (h.dir === 'E' || h.dir === 'W' ? 0 : 100), ly: h.ly + (h.dir === 'E' || h.dir === 'W' ? 100 : 0) };
    expect(actors.lookAt('Ada', at, { delay: 0.3, hold: 1.0 })).not.toBe(0);
    actors.step(0.1);
    expect(actors.poses().get('Ada')!.gestureT).toBe(0); // still at rest
    actors.step(0.4);
    expect(actors.poses().get('Ada')!.gestureT).toBeGreaterThan(0);
  });
});
