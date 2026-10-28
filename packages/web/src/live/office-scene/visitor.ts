import type { WorkingHours } from '@musterd/protocol';
import { ENTRANCE } from './layout';
import { walkable } from './nav';
import { createPet, petBeside, petLookAt, petTrip, stepPet, type PetState } from './pet';

/**
 * The visiting dog (lane 01M5XS6DP2): about once a working day a neighbour's dog comes in at the door,
 * goes over to the office dog, the two of them wander a little, and it leaves the way it came. A
 * visitor, not a resident — it never naps here, never wears a nameplate, and only one comes at a time.
 *
 * When is the same for every viewer: a minute of the team's working day picked from the team's name
 * and the date, in the team's own timezone. Someone who opens the room a minute into the visit still
 * sees it; someone who opens it after has missed it, the way you miss a dog that came by the office.
 */

/** How long after its minute a visit may still start — a viewer who loads a little late still sees it. */
export const VISIT_GRACE_MIN = 3;
/** The longest a visit may run before the dog is shown the door, whatever its script was doing. */
export const VISIT_MAX_S = 150;
/** How many places the pair wander to between the greeting and the goodbye. */
const WANDER_STOPS = 2;

/** Today's date and the minute of the day in `tz` (the team's timezone; the viewer's when absent). */
export function dayMinute(now: Date, tz?: string): { day: string; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday').slice(0, 3).toLowerCase(),
  };
}

const toMinute = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The minute of `day` the dog comes by, or null when it does not come that day (not a working day).
 * Inside the team's working hours with a quarter hour clear at each end; 10:00–16:00 without hours.
 */
export function visitMinute(team: string, day: string, weekday: string, hours: WorkingHours | null): number | null {
  if (hours && !hours.days.includes(weekday as WorkingHours['days'][number])) return null;
  const start = (hours ? toMinute(hours.start) : 600) + 15;
  const end = (hours ? toMinute(hours.end) : 960) - 15;
  if (end <= start) return null;
  return start + (hash(`${team}\n${day}`) % (end - start));
}

/** Whether the dog is due now: its minute has come, and not so long ago that the visit is over. */
export function visitDue(team: string, now: Date, hours: WorkingHours | null): string | null {
  const { day, minute, weekday } = dayMinute(now, hours?.timezone);
  const at = visitMinute(team, day, weekday, hours);
  return at !== null && minute >= at && minute < at + VISIT_GRACE_MIN ? day : null;
}

export interface Visit {
  dog: PetState;
  stage: 'greet' | 'wander' | 'leave' | 'done';
  /** Wander stops still to make. */
  left: number;
  /** Seconds since it came in. */
  t: number;
}

/** A visitor's trip: straight off at a walk — it is out and about, not getting up from a nap. */
function go(dog: PetState, target: { lx: number; ly: number } | null, sitFor: number): boolean {
  if (!petTrip(dog, target, sitFor)) return false;
  dog.mode = 'walk';
  dog.modeT = 0;
  return true;
}

/** Just inside the door, where the visitor appears and where it leaves from. */
const DOORSTEP = { lx: ENTRANCE.lx + 30, ly: ENTRANCE.ly - 8 };

/** It comes in at the door and heads for the office dog. */
export function startVisit(resident: PetState | null, rng: () => number = Math.random): Visit {
  const dog = createPet(rng);
  dog.lx = DOORSTEP.lx;
  dog.ly = DOORSTEP.ly;
  dog.mode = 'sit';
  const v: Visit = { dog, stage: 'greet', left: WANDER_STOPS, t: 0 };
  go(dog, resident ? petBeside(resident) : { lx: DOORSTEP.lx + 120, ly: DOORSTEP.ly - 80 }, 6 + rng() * 3);
  return v;
}

/** A walkable spot a short wander away from `at`. */
function wanderSpot(at: { lx: number; ly: number }, rng: () => number): { lx: number; ly: number } | null {
  for (let i = 0; i < 12; i++) {
    const a = rng() * Math.PI * 2;
    const r = 90 + rng() * 110;
    const p = { lx: at.lx + Math.cos(a) * r, ly: at.ly + Math.sin(a) * r };
    if (walkable(p.lx, p.ly)) return p;
  }
  return null;
}

/**
 * Advance the visit. The visitor sits out each stop, then goes on: the greeting at the office dog
 * (which wakes and turns to it), a couple of wanders with the office dog trotting after, then out of
 * the door. Returns true while the visit needs frames; `stage` reaches `done` when the dog has gone.
 */
export function stepVisit(v: Visit, resident: PetState | null, dt: number, rng: () => number = Math.random): boolean {
  if (v.stage === 'done') return false;
  v.t += dt;
  const dog = v.dog;
  stepPet(dog, dt);
  const arrived = dog.path.length > 0 && dog.seg >= dog.path.length - 1;
  // A stop is over once it has sat most of its time — or, past that, begun to curl up for a nap, which a
  // visitor never gets to take.
  const done =
    arrived &&
    ((dog.mode === 'sit' && dog.modeT >= dog.sitFor * 0.9) || dog.mode === 'curl' || dog.mode === 'sleep');
  if (v.stage === 'greet' && resident && dog.mode === 'sit') {
    // The office dog notices its guest: up from the nap, looking at it.
    petLookAt(resident, dog);
    if (resident.mode === 'sleep') {
      resident.mode = 'sit';
      resident.modeT = 0;
    }
    petLookAt(dog, resident);
  }
  if (v.t > VISIT_MAX_S && v.stage !== 'leave') {
    v.stage = 'leave';
    go(dog, DOORSTEP, 0.6);
    return true;
  }
  if (!done) return true;
  if (v.stage === 'leave') {
    v.stage = 'done';
    return false;
  }
  if (v.stage === 'greet' || (v.stage === 'wander' && v.left > 0)) {
    const spot = wanderSpot(dog, rng);
    v.stage = 'wander';
    v.left -= 1;
    if (spot && go(dog, spot, 3 + rng() * 3)) {
      // The office dog tags along to wherever its guest goes.
      if (resident) petTrip(resident, petBeside(spot), 4 + rng() * 3);
      return true;
    }
  }
  v.stage = 'leave';
  go(dog, DOORSTEP, 0.6);
  return true;
}
