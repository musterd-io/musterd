import { BEAM_LEN, BEAM_SHEAR } from './layout';

/**
 * The office lighting model — one source of truth for how the room is lit, derived from real-world PST
 * time-of-day and whether anyone's in. The scene had three *decoupled* notions of light (baked per-face
 * shading, hand-placed contact shadows, and a CSS "day-cycle" wash on a fake 210s loop); this replaces the
 * loop with an honest clock and gives every light surface one place to read from.
 *
 * Three physical lights, all keyed off `computeLightEnv`:
 *  - **Natural light** — a sky wash whose strength + warmth follow the PST sun: amber at dawn/dusk, bright
 *    and cool at noon, gone at night. Rendered as the `.lc-amb-daylight` CSS overlay (see index.ts).
 *  - **Overhead lights** — the ceiling fill. On whenever the office is occupied, off when everyone's gone
 *    home; raises the interior `ambient` level so an occupied room reads lit even after dark.
 *  - **Desk lamps** — switch on when it's dark out (like a person would), only at an occupied desk. Warm
 *    floor pools that punch through the night veil (see render.ts).
 *
 * The interior `ambient` (natural + overhead + a never-black floor) becomes a canvas "night veil": the
 * darker the room, the more we paint over it. So an empty office at 9pm goes properly dark, the same office
 * with someone working glows from the overhead + their lamp, and midday is bright whether or not anyone's in.
 */

/** Time-of-day → lighting boundaries (PST hours, 0..24). Dawn/dusk are ramps, not switches. */
const DAWN_START = 5.0;
const DAWN_END = 7.5;
const DUSK_START = 17.5;
const DUSK_END = 20.0;

/** Desk lamps come on one by one as the light goes, the way people notice dusk at different moments
 * (lane 01M5XS62RF): the first at this daylight level, the last at `LAMP_LAST`. Through a normal dusk that
 * is about 18:30 to 19:20, one desk at a time. Dawn runs it backwards. The span is centred on the single
 * threshold every lamp used before (0.42). */
const LAMP_FIRST = 0.62;
const LAMP_LAST = 0.22;

/** Interior light budget: a small never-black floor, the sun through the windows, and the ceiling fill.
 *
 * Re-tuned 2026-09-03 on nick's read of the stream ("a little too dark"). The values below did not
 * change what the room is *made of* — they changed how much of the answer the flat veil is allowed to
 * carry. A full-canvas wash is the one light source in this model that has no shape: it dims the
 * bookshelf, the sitter's face and the floor by the identical amount, so past a certain alpha the room
 * stops reading as "lit dimly" and starts reading as "greyed out". The fix is to take alpha off the
 * wash (VEIL_MAX 0.82 → 0.70) and give it back as fixed light (the floor and the two fills), which the
 * warm sources in `drawInteriorLight` then punch through with actual direction. Measured at the three
 * states that matter: occupied in-shift after dark 0.33 → 0.22 veil, occupied after-hours 0.62 → 0.46,
 * empty office 0.75 → 0.62 — so the dark room is still unmistakably dark, the gaps *between* the three
 * states are preserved, and only the inhabited ones lift. Deliberately "a little", which is what was
 * asked: a first pass at VEIL_MAX 0.62 took the in-shift night to 0.16 and the room stopped reading as
 * night at all. The room is meant to run on minimal light after dark — string lights, desk lamps, the
 * members themselves — and that only means anything if there is dark for them to be minimal against. */
const FLOOR_LIGHT = 0.12;
const NATURAL_GAIN = 0.9;
const OVERHEAD_FILL = 0.56;
/** Occupied outside the team's declared hours: the ceiling bank stays off and this small spill is all the
 * fixed light — a late worker reads as a lamp pool in a dark office, while bodies stay legible. */
const AFTER_HOURS_SPILL = 0.22;
/** How opaque the darkest possible night veil gets — kept under 1 so a dark room still reads. */
const VEIL_MAX = 0.7;

/** Cool deep-blue the room falls toward at night (the veil colour). */
const VEIL_COLOR = 'rgb(15, 21, 38)';

export interface LightEnv {
  /** The office clock this envelope was computed from: hour-of-day 0..24 in PST, normalised. The wall
   * clock reads it, so the hands and the daylight always agree — including under the `?light=HH` override. */
  hours: number;
  /** 0 (deep night) … 1 (bright midday) — how much natural light is entering. */
  daylight: number;
  /** Overall interior light level 0..1 (natural + overhead + floor). Drives the night veil. */
  ambient: number;
  /** Overhead ceiling lights — on when the office is occupied *during declared working hours* (a late
   * worker doesn't flip the whole ceiling bank; they work by lamp under `AFTER_HOURS_SPILL`). */
  overheadOn: boolean;
  /** Dark enough for the first desk lamp. Each desk switches at its own level (`deskLampOn`), and is
   * still gated on occupancy in render. */
  lampsOn: boolean;
  /** The team declared working hours and this instant is outside them (presence spec §5.5). False when
   * no schedule exists — the off-shift flavor never appears without one. */
  afterHours: boolean;
  /** Alpha of the night veil painted over the interior — `(1 - ambient)`, capped. */
  veilAlpha: number;
  /** The veil colour (cool near-black). */
  veilColor: string;
  /** Warm→cool sky tint for the natural-light wash (CSS overlay), as an `rgb()` string. */
  skyTint: string;
  /** Strength 0..1 of the natural-light wash overlay. */
  skyStrength: number;
}

/** Smoothstep between edges a→b, clamped to [0,1]. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blend two `[r,g,b]` triples. */
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
}

const SKY_COOL: [number, number, number] = [206, 226, 244]; // bright blue-white midday
const SKY_WARM: [number, number, number] = [255, 178, 96]; // amber golden-hour

/**
 * Compute the office lighting for a given PST time-of-day, occupancy, and shift state.
 * @param pstHours  hour-of-day in America/Los_Angeles, 0..24 (e.g. 13.5 = 1:30pm).
 * @param occupied  is anyone currently in the office? (drives the overhead lights)
 * @param inShift   is this instant inside the team's declared working hours? `null` (the default)
 *                  means no schedule is declared, which lights exactly like being in shift.
 */
export function computeLightEnv(pstHours: number, occupied: boolean, inShift: boolean | null = null): LightEnv {
  const h = ((pstHours % 24) + 24) % 24;
  // Daylight: 0 before dawn, ramps to 1 across the dawn window, holds at midday, ramps back down at dusk.
  const rise = smooth(DAWN_START, DAWN_END, h);
  const fall = 1 - smooth(DUSK_START, DUSK_END, h);
  const daylight = Math.min(rise, fall);

  // Warmth peaks at the horizon (dawn/dusk) and is lowest at high sun — a golden-hour parabola.
  const warmth = Math.max(0, Math.min(1, daylight * (1 - daylight) * 4));
  const [r, g, b] = mix(SKY_COOL, SKY_WARM, warmth);

  const afterHours = inShift === false;
  const overheadOn = occupied && !afterHours;
  const natural = daylight * NATURAL_GAIN;
  const overhead = overheadOn ? OVERHEAD_FILL : occupied ? AFTER_HOURS_SPILL : 0;
  const ambient = Math.min(1, FLOOR_LIGHT + natural + overhead);

  return {
    hours: h,
    daylight,
    ambient,
    overheadOn,
    afterHours,
    lampsOn: daylight < LAMP_FIRST,
    veilAlpha: (1 - ambient) * VEIL_MAX,
    veilColor: VEIL_COLOR,
    skyTint: `rgb(${r}, ${g}, ${b})`,
    // The wash is strongest mid-morning/afternoon and eased off at flat noon (where face-shading carries
    // it) and at night (where the veil takes over) — so it reads as *entering* light, not a flat filter.
    skyStrength: daylight * 0.5,
  };
}

/**
 * The daylight level below which desk `id` has its lamp on. Spread evenly across `LAMP_FIRST`…`LAMP_LAST`
 * by the golden-ratio sequence, so neighbouring desks switch far apart in time and the order looks
 * scattered rather than a sweep across the room. Pure and stable per desk.
 */
export function deskLampLevel(id: number): number {
  const rank = (((id + 1) * 0.6180339887) % 1 + 1) % 1;
  return LAMP_FIRST - rank * (LAMP_FIRST - LAMP_LAST);
}

/** Is desk `id`'s lamp on under `env`? (Occupancy is the caller's gate.) */
export function deskLampOn(env: Pick<LightEnv, 'daylight'>, id: number): boolean {
  return env.daylight < deskLampLevel(id);
}

/** A fully-lit daytime env — the safe default for any renderer that hasn't wired the clock yet. */
export const DAY_ENV: LightEnv = computeLightEnv(12, true);

/**
 * Where the sun is, as the window light shafts see it (lane 01M4VR902N): how far a window's beam reaches
 * onto the floor and how far its far end leans sideways, in logical units. A low sun throws long and leans
 * hard; noon is shorter and straight; the lean flips sides across the day (positive in the morning). Pure
 * over the office hour, so the painted beams, the dust motes in them and the dog's sunbeam nap spots all read
 * the same sun. The beams were constants (150, 46) — 7 am and noon differed only in tint and strength.
 */
export function sunBeam(hours: number): { len: number; shear: number } {
  const height = Math.max(0, Math.sin((Math.PI * (hours - 6.5)) / 12.5)); // 0 at the horizon … 1 at noon
  const side = Math.max(-1, Math.min(1, (12.75 - hours) / 6.25)); // + morning … − evening
  return { len: BEAM_LEN * (0.8 + 0.8 * (1 - height)), shear: BEAM_SHEAR * 1.4 * side };
}
