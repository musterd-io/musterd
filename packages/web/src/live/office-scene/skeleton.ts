/**
 * The character's animation vocabulary — the beats a member can play (`GESTURE`), how a beat moves the
 * chair under them, the typing rhythm, and a member's seed. The actor system picks these; `character.ts`
 * maps them onto the figure's sprite clips (`animFor`).
 *
 * This file used to be the skeleton solver too — `solveSkeleton()` returned joint positions in the
 * character's own 3D space and `character.ts` flattened them onto the canvas. The pre-rendered figure
 * replaced that (office realism, plan Task 13); the solver went with the painted office (plan Task 19,
 * lane 01M5D8EJ40 — `docs/wiki/restoring-the-painted-office.md`). Two rules survive it, because the
 * sprite path leans on them the same way: **the gait phase advances with distance travelled, not with
 * wall-clock time** (`actors.ts`; a stride is a fixed length of floor, so feet plant instead of skating),
 * and every beat starts and ends at the plain pose (`chairShift`, `chairYaw`, `handsInLap` are zero at
 * both ends of their windows).
 */

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Smooth 0→1 ease with zero velocity at both ends — the default for every blend in here. */
export const smooth = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Floor units one gait cycle covers — two steps. Measured from the rendered walk (office v3-5): the
 * stance foot sweeps 43.4 units back across half a cycle (`figure.json` `anims.walk.contact`, written
 * by render.py), so the body covers 87 per cycle. It was 46 against a clip that swept ~77, which is
 * why the feet read as skating: they moved faster than the floor under them. `stride.test.ts` holds
 * this to the measured number.
 */
export const STRIDE = 87;

/**
 * The gesture-kind registry — every in-place beat a member can play (`SkelInput.gesture`). One named
 * source of truth for the actor system (durations), the scheduler (weights/eligibility) and the solver
 * (overlays); `0` is "no gesture". Seated micro-beats make an idle office read as *inhabited*: nobody
 * sits frozen at a desk for four minutes, they scratch, sip, lean back, swivel.
 */
export const GESTURE = {
  stretch: 1,
  glance: 2,
  scratch: 3,
  chin: 4,
  lean: 5,
  sip: 6,
  swivel: 7,
  roll: 8,
  /**
   * The lounge beat: a slow shift of weight onto one hip, the free arm coming up along the seat back,
   * the head drifting with it — then settling. The one beat that belongs to the *casual* seats (couch,
   * meeting chairs, waiting chair), where the desk beats have nothing to work against: `lean` reclines
   * a member who is already reclined, and `swivel`/`roll` need casters. Held, not arced, so it reads
   * as making yourself comfortable rather than a twitch.
   */
  settle: 14,
  /** Both shoulders roll up, back and down — the desk-stiffness beat. Reads by silhouette. */
  shoulders: 15,
  /** Back in the chair, both hands laced behind the head, elbows wide. Held, not arced. */
  behindHead: 16,
  /** Thumb and fingers to the eyes, a brief squeeze. The tired beat. */
  rubEyes: 17,
  /** A glance at the phone in the hand, down in the lap, then back to the screen. */
  pocketPhone: 18,
  // Errand beats (played on a walk's hold/sit legs via `Leg.overlay`, not by the gesture scheduler):
  /** Peering into the open fridge, one hand on the door. */
  browse: 9,
  /** Holding the bottle under the cooler tap, leaning in a touch. */
  fill: 10,
  /** Seated with a plate, the free hand cycling plate → mouth. */
  eat: 11,
  /** Working the espresso machine at counter height. */
  pour: 12,
  /** Phone to the ear, held for the length of a call. */
  call: 13,
  /**
   * The welcome wave (lane 01M3F81DD9): a hand up beside the head, the forearm rocking. Played only by
   * the Welcome Wagon, on the teammates nearest a first arrival — never by the gesture scheduler, which
   * is why it is listed in `ERRAND_GESTURES` below (that list IS the "not scheduler-pickable" family).
   */
  wave: 19,
  /** Claiming a lane (2026-10-09): the right hand goes up to the wall board for the card. Rises and
   *  holds at the top — `take` brings it down — so the two legs read as one reach. */
  reach: 20,
  /** …and down again with the card in it, to where `carry: 'card'` holds it. */
  take: 21,
} as const;

/**
 * The errand beats: played on a walk's hold/sit legs via `Leg.overlay`, never chosen by the gesture
 * scheduler. Listed here (rather than by id range) because this is the ONLY thing that separates the
 * two families, and the separation has to be derivable — see `IDLE_GESTURES` directly below.
 */
const ERRAND_GESTURES = ['browse', 'fill', 'eat', 'pour', 'call', 'wave', 'reach', 'take'] as const;

/** Beats that are the two halves of ONE motion over two legs — the first ends where the second starts
 *  (the hand up at the wall board), so neither returns to rest alone; the pair does. */
export const SPLIT_BEATS: ReadonlyArray<readonly [number, number]> = [[GESTURE.reach, GESTURE.take]];

/** A beat the gesture scheduler may pick: everything in the registry that is not an errand overlay. */
export type IdleGesture = (typeof GESTURE)[Exclude<keyof typeof GESTURE, (typeof ERRAND_GESTURES)[number]>];

/**
 * Every scheduler-pickable beat, DERIVED from the registry rather than re-listed (lane 01M2JYBGMQ).
 * #1430 added four beats and the duration table did not hear about it, so all four silently took the
 * shortest window in it; a re-listed set would have gone stale the same way. Add a beat to `GESTURE`
 * and it lands here automatically — and `GESTURE_DUR`, keyed by `IdleGesture`, stops compiling until
 * somebody chooses its window.
 */
export const IDLE_GESTURES: readonly IdleGesture[] = Object.entries(GESTURE)
  .filter(([key]) => !(ERRAND_GESTURES as readonly string[]).includes(key))
  .map(([, id]) => id as IdleGesture);

/**
 * Is this number a beat the scheduler may pick?
 *
 * The one place a gesture id arrives from OUTSIDE the type system is `pokeGesture`, which
 * `/office-preview?beat=<n>` feeds a URL param. `GESTURE_DUR` is keyed by `IdleGesture` and has no
 * fallback (#1434, correctly — a table that cannot report its own gaps is how four beats shipped on
 * the shortest window in it), so an errand id arriving there produced `dur: undefined`, and
 * `g.t >= g.dur` is never true against `undefined`: the member gestured for the life of the scene
 * and was excluded from every later beat. A cast cannot catch that; this can (izzo, reviewing #1434
 * — falsify: `pokeGesture(GESTURE.call)` and step the scene; a member still holding a gesture after
 * its longest window means this guard is not on the path).
 */
export function isIdleGesture(kind: number): kind is IdleGesture {
  return (IDLE_GESTURES as readonly number[]).includes(kind);
}

/** An arc-shaped envelope over the gesture window: 0 → 1 → 0, zero-velocity at both ends (no pop). */
export const arcEnv = (gT: number): number => Math.sin(smooth(gT) * Math.PI);
/** A plateau envelope: ramp in over the first ~18% of the window, hold, ramp out over the last ~18%. */
export const holdEnv = (gT: number): number => Math.min(smooth(gT / 0.18), 1, smooth((1 - gT) / 0.18));

/**
 * How far a rolling chair (and its sitter) shifts straight back from the desk through the `roll` beat —
 * 0 at both ends, peaking mid-window. Pure, so the actor system (body offset) and the scene painter
 * (chair pieces) derive the *same* displacement from the same pose instead of drifting apart.
 */
export function chairShift(gesture: number, gestureT: number): number {
  return gesture === GESTURE.roll ? arcEnv(gestureT) * 12 : 0;
}

/**
 * The swivel beat's yaw (radians): a gentle left-right-left oscillation that ends where it began. Added
 * to the sitter's continuous heading by the actor system and to the chair backrest by the painter.
 * (The hands stay near the keys — the whole figure yawing under them is what reads as a chair swivel.)
 */
export function chairYaw(gesture: number, gestureT: number): number {
  return gesture === GESTURE.swivel ? Math.sin(smooth(gestureT) * 3 * Math.PI) * 0.16 : 0;
}

/**
 * True while a seated beat has pulled the hands off the desk into the lap (blend past a threshold) —
 * the painter's cue to skip the arms-over-desk overlay pass, which would otherwise float lap-resting
 * arms on top of the desk slab.
 */
export function handsInLap(gesture: number, gestureT: number): boolean {
  if (gesture === GESTURE.lean) return holdEnv(gestureT) > 0.15;
  if (gesture === GESTURE.roll) return arcEnv(gestureT) > 0.15;
  return false;
}

/** A tiny deterministic hash → [0,1), so a member's idle rhythm is stable across frames and reloads. */
export function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Typing intensity for a working member: **bursts, not a metronome.** A stable per-member cycle alternates
 * a few seconds of clattering with a pause to think, and each burst ramps in and out so hands settle onto
 * the keys rather than snapping to them. Returns 0 when the member isn't typing at all — which is also what
 * lets the scene rest (a room of pausing members stops redrawing).
 */
export function typingBurst(seed: number, t: number): number {
  const period = 7 + seed * 5; // 7–12s: type a while, think a while
  const on = 2.2 + seed * 1.6; // 2.2–3.8s of actual clatter
  const p = (t + seed * 40) % period;
  if (p > on) return 0;
  // ramp in over 0.35s, out over 0.5s — no hard edges
  return Math.min(1, smooth(p / 0.35), smooth((on - p) / 0.5));
}

/** The pulse-driven burst's period, s. Shorter than `typingBurst`'s: the pauses are now the seat's own. */
export const PULSE_TYPING_PERIOD_S = 6;

/**
 * Typing amplitude from the seat's pulse (ADR 660 §3.3) — `intensity` is distinct harness tool
 * calls in the last minute, 0 when the pulse is stale or the seat has no hooks. Returns 0 for 0:
 * every tap traces to a real call, and a `working` posture alone no longer types (that was
 * `typingBurst`'s seeded loop, which this replaces at the desk). From one call a minute upward the
 * burst's duty cycle rises with intensity — about a quarter of each period at 1–2/min, about 85% at
 * twelve or more — still phase-seeded per member so neighbours don't type in lockstep, with the same
 * ramps as `typingBurst` so hands settle onto the keys rather than snapping.
 */
export function typingFromPulse(intensity: number, seed: number, t: number): number {
  if (intensity <= 0) return 0;
  const duty = clamp(0.25 + (0.6 * (intensity - 1)) / 11, 0.25, 0.85);
  const on = duty * PULSE_TYPING_PERIOD_S;
  const p = (t + seed * 40) % PULSE_TYPING_PERIOD_S;
  if (p > on) return 0;
  return Math.min(1, smooth(p / 0.35), smooth((on - p) / 0.5));
}
