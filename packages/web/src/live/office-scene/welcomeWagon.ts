import type { Arrival } from './arrivals';

/**
 * The Welcome Wagon (lane 01M3F81DD9, spec §3) — WHEN each welcome beat happens, and nothing about how
 * it looks. A plain state object stepped by the scene loop, the shape pet.ts / receptionist.ts use:
 * arrivals are enqueued as the roster diff finds them, grouped into 2 s waves, turned into a timed
 * script, and stepped. The scene (index.ts) dispatches each returned beat to the resident that plays
 * it. Pure and clock-injected, so every rule below is a unit test, not a thing to eyeball.
 *
 * The copy in this file is brand voice on a public surface (/live, /broadcast) — sloane reviews it.
 */

export type WelcomeBeat =
  | { type: 'ring' }
  | { type: 'say'; text: string }
  | { type: 'label'; name: string; hue: number | null }
  | { type: 'wagon'; name: string }
  | { type: 'toss'; name: string; hue: number | null }
  | { type: 'wave'; name: string }
  | { type: 'confetti'; name: string; hue: number | null }
  | { type: 'hello'; name: string }
  | { type: 'zoomies' }
  | { type: 'caption'; text: string; who: string };

/** What the sequencer needs to know about the room, asked fresh every step. */
export interface WagonDeps {
  /** Real choreography is playing — a sequence may not START (once started, it finishes). */
  busy: boolean;
  /** prefers-reduced-motion: end states and captions only. */
  reduced: boolean;
  /** Still on the roster — a beat about someone who has left is skipped. */
  present(name: string): boolean;
  hasDesk(name: string): boolean;
  seated(name: string): boolean;
  /** Standing at a check-in mark right now — the lanyard toss waits for it. */
  atMark(name: string): boolean;
}

/** Arrivals this close together are one wave. */
export const WAVE_MS = 2_000;
/** A wave with this many online arrivals is a crowd. */
export const CROWD_MIN = 3;
/** The receptionist's conveyor cadence in a crowd, seconds. */
export const TOSS_GAP_S = 0.6;
/**
 * How long a ready wave waits out real choreography before it starts anyway, ms. A team as chatty as
 * the one this was built on always has an act walk somewhere; "wait for a quiet room" alone meant the
 * welcome never played there (found on the office-preview harness, 2026-09-26).
 */
export const MAX_WAIT_MS = 4_000;
/** Past this many queued arrivals, everything pending plays as one wave. */
export const BACKLOG_MAX = 6;
/** A gated beat (toss at the mark, confetti at the seat) gives up after this long, seconds. */
export const GATE_TIMEOUT_S = 12;
/** A sequence unstepped for this long (a hidden tab), seconds, is dropped — never burst. */
export const STALE_S = 20;
/**
 * A gap between steps longer than this (ms) is a pause — a hidden tab, a collapsed panel — and the
 * sequence resumes where it stopped instead of firing every beat that fell due in the gap at once.
 * Well above a frame (the loop never runs slower than ~20 fps), well below anything a viewer sees.
 */
export const PAUSE_GAP_MS = 250;

type Gate = { kind: 'seated' | 'mark'; name: string };
interface Cue {
  /** Seconds from the start of the sequence. */
  t: number;
  beat: WelcomeBeat;
  /** The Member the beat is about — skipped if they are no longer in the room. */
  who?: string;
  gate?: Gate;
}
interface Sequence {
  startedAt: number;
  lastStepAt: number;
  cues: Cue[];
}
interface Pending extends Arrival {
  at: number;
}
export interface WelcomeWagonState {
  /** Arrivals waiting for their wave to start. Read by the scene to keep its loop awake. */
  pending: Pending[];
  playing: Sequence | null;
}

export function createWelcomeWagon(): WelcomeWagonState {
  return { pending: [], playing: null };
}

export function enqueueArrivals(
  s: WelcomeWagonState,
  arrivals: readonly Arrival[],
  now: number,
): void {
  for (const a of arrivals) s.pending.push({ ...a, at: now });
}

export function welcomePlaying(s: WelcomeWagonState): boolean {
  return s.playing !== null;
}

function addedLine(a: Arrival): string {
  return a.sponsor
    ? `${a.name} was added to the team · by ${a.sponsor}`
    : `${a.name} was added to the team`;
}

/** The new nameplate goes onto their desk by wagon. A deskless newcomer gets no delivery: the wall
 *  used to take a polaroid, retired 2026-10-12 (nick: one kind of card on the wall — the board's). */
function delivery(a: Arrival, d: WagonDeps): WelcomeBeat | null {
  return d.hasDesk(a.name) ? { type: 'wagon', name: a.name } : null;
}

/** Act 1 alone: the room makes space (spec §3.1). */
function actOne(a: Arrival, d: WagonDeps): Cue[] {
  const delivered = delivery(a, d);
  const caption: Cue = { t: 4.0, beat: { type: 'caption', text: addedLine(a), who: a.name } };
  if (d.reduced)
    return [{ t: 0, beat: { type: 'label', name: a.name, hue: a.hue } }, { ...caption, t: 0 }];
  return [
    { t: 0, beat: { type: 'ring' } },
    { t: 0, beat: { type: 'say', text: `oh! someone new: ${a.name}` } },
    { t: 0.9, beat: { type: 'label', name: a.name, hue: a.hue }, who: a.name },
    ...(delivered ? [{ t: 1.4, beat: delivered, who: a.name } as Cue] : []),
    caption,
  ];
}

/** Act 2, with Act 1 folded in when the Member was also just created (spec §3.2–3.3). */
function actTwo(a: Arrival, d: WagonDeps): Cue[] {
  const caption: Cue = {
    t: 6.2,
    beat: { type: 'caption', text: `${a.name} joined the team — welcome`, who: a.name },
    who: a.name,
  };
  if (d.reduced) {
    const end: Cue[] =
      a.kind === 'created' ? [{ t: 0, beat: { type: 'label', name: a.name, hue: a.hue } }] : [];
    return [...end, { ...caption, t: 0 }];
  }
  const fold: Cue[] =
    a.kind === 'created'
      ? [
          { t: 0.1, beat: { type: 'label', name: a.name, hue: a.hue }, who: a.name },
          ...(delivery(a, d) ? [{ t: 0.4, beat: delivery(a, d)!, who: a.name } as Cue] : []),
        ]
      : [];
  const mark: Gate = { kind: 'mark', name: a.name };
  const seat: Gate = { kind: 'seated', name: a.name };
  // The door itself rang when they walked in (welcomeRoom.onRoster) — the script starts inside.
  return [
    ...fold,
    { t: 1.6, beat: { type: 'toss', name: a.name, hue: a.hue }, who: a.name, gate: mark },
    { t: 1.6, beat: { type: 'say', text: `welcome, ${a.name}!` }, who: a.name, gate: mark },
    { t: 2.6, beat: { type: 'wave', name: a.name }, who: a.name },
    { t: 5.2, beat: { type: 'confetti', name: a.name, hue: a.hue }, who: a.name, gate: seat },
    { t: 6.0, beat: { type: 'hello', name: a.name }, who: a.name, gate: seat },
    caption,
  ];
}

/** A crowd: one lap of zoomies, conveyor tosses, one confetti, one caption (§3.4). */
function crowd(online: Pending[], s: WelcomeWagonState, d: WagonDeps): Cue[] {
  const n = online.length;
  // Never "guests": everyone who joins is a Member like anyone else (sloane's copy read, 2026-09-26).
  const noun = online.every((a) => a.memberKind === 'human') ? 'people' : 'members';
  const end = 1.2 + n * TOSS_GAP_S;
  const caption: Cue = {
    t: end,
    beat: { type: 'caption', text: `${n} ${noun} joined — welcome`, who: online[0]!.name },
  };
  if (d.reduced) return [{ ...caption, t: 0 }];
  const cues: Cue[] = [{ t: 0.2, beat: { type: 'zoomies' } }];
  online.forEach((a, i) => {
    const t = 1.2 + i * TOSS_GAP_S;
    cues.push({ t, beat: { type: 'toss', name: a.name, hue: a.hue }, who: a.name });
    if (i === 0) cues.push({ t, beat: { type: 'say', text: 'welcome!' } });
  });
  cues.push({ t: end, beat: { type: 'confetti', name: online[0]!.name, hue: null } });
  cues.push(caption);
  return cues;
}

/** Members created offline in one wave: Act 1 for one; one ring, their labels, one line for many. */
function createdGroup(created: Pending[], d: WagonDeps): Cue[] {
  if (created.length === 1) return actOne(created[0]!, d);
  const caption: Cue = {
    t: 4.0,
    beat: {
      type: 'caption',
      text: `${created.length} members were added to the team`,
      who: created[0]!.name,
    },
  };
  const labels = created.map(
    (a, i): Cue => ({
      t: d.reduced ? 0 : 0.9 + i * 0.3,
      beat: { type: 'label', name: a.name, hue: a.hue },
      who: a.name,
    }),
  );
  if (d.reduced) return [...labels, { ...caption, t: 0 }];
  // One wagon trip in flight at a time (spec §3.4): the first newcomer with a desk gets the delivery.
  const withDesk = created.find((a) => d.hasDesk(a.name));
  return [
    { t: 0, beat: { type: 'ring' } },
    ...labels,
    ...(withDesk
      ? [{ t: 1.4, beat: { type: 'wagon', name: withDesk.name }, who: withDesk.name } as Cue]
      : []),
    caption,
  ];
}

function scriptFor(wave: Pending[], s: WelcomeWagonState, d: WagonDeps): Cue[] {
  const online = wave.filter((a) => a.online);
  const offlineCreated = wave.filter((a) => !a.online && a.kind === 'created');
  const cues: Cue[] = [];
  if (online.length >= CROWD_MIN) cues.push(...crowd(online, s, d));
  else
    online.forEach((a, i) =>
      // One or two online arrivals: the full welcome each, the second a beat behind the first.
      cues.push(...actTwo(a, d).map((c) => ({ ...c, t: c.t + i * 1.0 }))),
    );
  if (offlineCreated.length > 0) {
    const offset = cues.length > 0 ? 7 : 0; // after the welcome, never over it
    cues.push(...createdGroup(offlineCreated, d).map((c) => ({ ...c, t: c.t + offset })));
  }
  // Stable: beats authored at the same `t` keep their order (toss before its bubble).
  return cues.sort((x, y) => x.t - y.t);
}

function takeWave(s: WelcomeWagonState, d: WagonDeps): Pending[] {
  let wave: Pending[];
  if (s.pending.length > BACKLOG_MAX) {
    wave = s.pending;
    s.pending = [];
  } else {
    const first = s.pending[0]!.at;
    wave = s.pending.filter((p) => p.at - first <= WAVE_MS);
    s.pending = s.pending.filter((p) => p.at - first > WAVE_MS);
  }
  return settle(wave, d);
}

/**
 * One record per Member, and only for Members still here. `member add` then a connect a second later
 * reach the diff as two refetches — `created` offline, then `firstOnline` — and played as two they ran
 * backwards (the welcome, then "oh! someone new" seven seconds after). Merged, they are the one folded
 * moment §3.3 describes. A Member added and removed before the wave starts (a typo) is not announced.
 */
function settle(wave: Pending[], d: WagonDeps): Pending[] {
  const byName = new Map<string, Pending>();
  for (const p of wave) {
    const had = byName.get(p.name);
    byName.set(
      p.name,
      had
        ? { ...p, kind: had.kind === 'created' || p.kind === 'created' ? 'created' : p.kind, online: had.online || p.online }
        : p,
    );
  }
  return [...byName.values()].filter((p) => d.present(p.name));
}

/** Advance the wagon to `now`; returns the beats to play this frame, in order. */
export function stepWelcomeWagon(s: WelcomeWagonState, now: number, d: WagonDeps): WelcomeBeat[] {
  if (s.playing) {
    const gap = now - s.playing.lastStepAt;
    if (gap / 1000 > STALE_S) s.playing = null;
    else if (gap > PAUSE_GAP_MS) s.playing.startedAt += gap; // paused, not elapsed
  }
  if (!s.playing) {
    if (s.pending.length === 0) return [];
    const waited = now - s.pending[0]!.at;
    const ready = s.pending.length > BACKLOG_MAX || waited >= WAVE_MS;
    if (!ready || (d.busy && waited < WAVE_MS + MAX_WAIT_MS)) return [];
    const wave = takeWave(s, d);
    if (wave.length === 0) return [];
    s.playing = { startedAt: now, lastStepAt: now, cues: scriptFor(wave, s, d) };
  }
  const seq = s.playing;
  seq.lastStepAt = now;
  const elapsed = (now - seq.startedAt) / 1000;
  const out: WelcomeBeat[] = [];
  seq.cues = seq.cues.filter((c) => {
    if (c.t > elapsed) return true;
    if (c.who && !d.present(c.who)) return false; // they left before their beat
    if (c.gate) {
      const open = c.gate.kind === 'seated' ? d.seated(c.gate.name) : d.atMark(c.gate.name);
      if (!open) return elapsed - c.t < GATE_TIMEOUT_S; // keep waiting, or give up quietly
    }
    out.push(c.beat);
    return false;
  });
  if (seq.cues.length === 0) s.playing = null;
  return out;
}
