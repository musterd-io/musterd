import { diffArrivals, type Arrival, type ArrivalSubject } from './arrivals';
import type { CarryKind, WelcomePaint } from './types';
import {
  createWelcomeWagon,
  enqueueArrivals,
  stepWelcomeWagon,
  welcomePlaying,
  type WelcomeBeat,
} from './welcomeWagon';

/**
 * The Welcome Wagon's wiring (lane 01M3F81DD9): roster → arrivals → sequencer → the room's residents.
 *
 * Everything the scene has to DECIDE about a welcome lives here — which arrivals are flagged for the
 * first-day walk-in, what each beat asks of whom, what the painter is shown and when it stops being
 * shown — behind `WelcomePorts`, so it is unit-tested with fakes. `mountOffice` cannot run under the
 * test environment (no canvas, no rAF; scene-loop.test.ts), so index.ts is left with nothing but the
 * plumbing: build the ports from the real residents, call `onRoster` from `update()` and `step` from
 * the frame loop.
 */

/** Where a welcome sound comes from — the stereo pan follows it. */
export type WelcomeSoundAt = 'desk' | 'door' | { name: string };
export type WelcomeSound = 'ring' | 'ratchet' | 'rattle' | 'doorbell' | 'whoosh' | 'pop';

export interface WelcomePorts {
  // What the sequencer asks about the room.
  present(name: string): boolean;
  hasDesk(name: string): boolean;
  seated(name: string): boolean;
  reachedMark(name: string): boolean;
  /** A real act's walk is in flight — a welcome will not START over it. */
  busy(): boolean;
  kindOf(name: string): 'agent' | 'human';
  color(name: string, hue: number | null): string;
  // The residents who play the beats.
  expectFirstArrival(name: string, carry: CarryKind | null): void;
  receptionist(cue: 'ring' | 'label' | 'toss'): void;
  say(text: string): void;
  /** The dog fetches the wagon and pulls it to `name`'s desk. */
  wagon(name: string): void;
  zoomies(): void;
  /** The nearest teammates wave at `name`; the dog trots alongside. */
  wave(name: string): void;
  confetti(name: string, color: string | null): void;
  door(hue: number | null): void;
  caption(text: string, who: string): void;
  sound(m: WelcomeSound, at: WelcomeSoundAt): void;
}

export interface WelcomeRoom {
  /** Feed the roster the scene is about to seat. Returns the arrivals it found (never on the first). */
  onRoster(nodes: readonly ArrivalSubject[], now: number): Arrival[];
  /** Advance to `now` (wall ms) at scene clock `clock` (s); plays due beats. */
  step(now: number, clock: number): void;
  /** Something is queued or playing, or a transient paint is still animating — keep the loop running. */
  active(): boolean;
  /** How many welcome sequences have started — a probe for the perf harness (`stats()`). */
  started(): number;
  readonly paint: WelcomePaint;
}

/** How long each transient paint lives, in scene seconds. */
const LABEL_S = 2.0;
/** A tossed lanyard's flight from the counter to the newcomer — render.ts reads the same number. */
export const TOSS_S = 0.6;
const HELLO_S = 1.0;
const BLINK_S = 1.2;
/** A lanyard outlives its moment by at most this long — a guest in the overflow gallery never sits. */
const LANYARD_MAX_S = 12;

export function createWelcomeRoom(
  ports: WelcomePorts,
  opts: { reduced: boolean; still: boolean },
): WelcomeRoom {
  const wagon = createWelcomeWagon();
  let prev: Map<string, ArrivalSubject> | null = null;
  /** Everyone seen online since the page loaded — a return is never a first arrival. */
  const seenOnline = new Set<string>();
  let started = 0;
  /** When each lanyard was tossed (scene clock) — the painter only needs the colour. */
  const tossedAt = new Map<string, number>();
  const paint: WelcomePaint = {
    lanyards: new Map(),
    tosses: [],
    hello: new Map(),
    bootBlink: new Map(),
    labels: [],
  };

  function play(b: WelcomeBeat, clock: number): void {
    switch (b.type) {
      case 'ring':
        if (!opts.reduced) ports.receptionist('ring');
        ports.sound('ring', 'desk');
        return;
      case 'say':
        ports.say(b.text);
        return;
      case 'label':
        // Under reduced motion the nameplate simply appears (the desk already renders its owner);
        // the label maker is still heard — audio is not motion (E3 spec §2).
        if (!opts.reduced) {
          ports.receptionist('label');
          paint.labels.push({ color: ports.color(b.name, b.hue), t0: clock });
        }
        ports.sound('ratchet', 'desk');
        return;
      case 'wagon':
        ports.wagon(b.name);
        ports.sound('rattle', 'desk');
        return;
      case 'toss':
        ports.receptionist('toss');
        paint.lanyards.set(b.name, ports.color(b.name, b.hue));
        paint.tosses.push({ name: b.name, color: ports.color(b.name, b.hue), t0: clock });
        tossedAt.set(b.name, clock);
        if (ports.kindOf(b.name) === 'agent') paint.bootBlink.set(b.name, clock);
        ports.sound('whoosh', 'desk');
        return;
      case 'wave':
        ports.wave(b.name);
        return;
      case 'confetti':
        ports.confetti(b.name, b.hue === null ? null : ports.color(b.name, b.hue));
        ports.sound('pop', { name: b.name });
        return;
      case 'hello':
        paint.hello.set(b.name, clock);
        return;
      case 'zoomies':
        ports.zoomies();
        return;
      case 'caption':
        ports.caption(b.text, b.who);
        return;
    }
  }

  function prune(clock: number): void {
    paint.labels = paint.labels.filter((l) => clock - l.t0 < LABEL_S);
    paint.tosses = paint.tosses.filter((x) => clock - x.t0 < TOSS_S);
    for (const [n, t0] of paint.hello) if (clock - t0 >= HELLO_S) paint.hello.delete(n);
    for (const [n, t0] of paint.bootBlink) if (clock - t0 >= BLINK_S) paint.bootBlink.delete(n);
    // The lanyard is a prop of the moment: gone once they sit, if they left mid-welcome, or — for a
    // guest standing in the overflow gallery, who never sits — once the moment is long over.
    for (const n of paint.lanyards.keys()) {
      if (ports.seated(n) || !ports.present(n) || clock - (tossedAt.get(n) ?? clock) >= LANYARD_MAX_S) {
        paint.lanyards.delete(n);
        tossedAt.delete(n);
      }
    }
  }

  return {
    paint,
    onRoster(nodes, now) {
      // An empty roster before any roster is the page mounting ahead of its data, not an empty team:
      // taking it as the baseline made the real roster read as the whole team arriving at once.
      if (prev === null && nodes.length === 0) return [];
      const arrivals = opts.still ? [] : diffArrivals(prev, nodes, { now, seenOnline });
      prev = new Map(nodes.map((n) => [n.name, n]));
      for (const n of nodes) if (n.presence !== 'offline') seenOnline.add(n.name);
      if (!opts.reduced)
        for (const a of arrivals)
          if (a.online) ports.expectFirstArrival(a.name, a.memberKind === 'human' ? 'movingBox' : null);
      enqueueArrivals(wagon, arrivals, now);
      // The door rings as they walk through it — now, with the walk-in `setHomes` is about to build,
      // not two seconds later when the wave's script starts and they are already past it. One ring
      // for a crowd, in no one colour; the glow is motion, the bell is not (E3 spec §2).
      const walkingIn = arrivals.filter((a) => a.online);
      if (walkingIn.length > 0) {
        if (!opts.reduced) ports.door(walkingIn.length === 1 ? walkingIn[0]!.hue : null);
        ports.sound('doorbell', 'door');
      }
      return arrivals;
    },
    step(now, clock) {
      const wasPlaying = welcomePlaying(wagon);
      const beats = stepWelcomeWagon(wagon, now, {
        busy: ports.busy(),
        reduced: opts.reduced,
        present: ports.present,
        hasDesk: ports.hasDesk,
        seated: ports.seated,
        atMark: ports.reachedMark,
      });
      if (!wasPlaying && (welcomePlaying(wagon) || beats.length > 0)) started++;
      for (const b of beats) play(b, clock);
      prune(clock);
    },
    active() {
      return (
        welcomePlaying(wagon) ||
        wagon.pending.length > 0 ||
        paint.labels.length > 0 ||
        paint.tosses.length > 0 ||
        paint.hello.size > 0 ||
        paint.bootBlink.size > 0 ||
        paint.lanyards.size > 0
      );
    },
    started: () => started,
  };
}
