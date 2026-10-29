/**
 * The character wardrobe — who a member *looks like*, derived deterministically from their name.
 *
 * Pure and renderer-free, like `skeleton.ts`: `appearanceOf(name, kind, color) → Appearance` returns a
 * complete description of a person (skin, hair, facial hair, hat, top, trousers, shoes), and `character.ts`
 * paints it. Nothing here is random at runtime — every choice is a salted hash of the member's name, so a
 * teammate looks the same across every frame, every reload, and every machine, exactly like their seat and
 * their signature colour do.
 *
 * ## The one thing that is NOT free: the top's hue
 *
 * A member's `color` (`memberColor(name, kind)`) is **identity**, not decoration — it is the same hue as
 * their roster dot, their label, and their desk, and it is how you pick miley out of a crowded floor at a
 * glance. So the **top keeps the identity hue** and varies by *pattern and cut* instead (tee, stripes,
 * hoodie, vest, long-sleeve). Everything else — skin, hair, facial hair, hats, trousers, shoes — runs free.
 * You still know who's who; nobody is a clone.
 *
 * The agent/human tell (ADR 079) also stays load-bearing and survives the wardrobe: **agents have an
 * antenna + chest LED + visor** (readable from any facing, even the back of the head), humans have eyes and
 * may have facial hair. A hat does not hide an antenna — it pokes through, which is the correct joke.
 */

import type { OfficeNode } from './types';

/**
 * FNV-1a, salted, with a proper avalanche — one independent stable stream of choices per member.
 *
 * The finalizer is load-bearing and used not to be. With FNV's single `h ^= h >>> 15`, the streams
 * for different salts stayed correlated on structured names, and `Math.floor(hash × len)` collapsed
 * into a few buckets: measured over 400 names, the `hoodie` top cut came up **zero times** and
 * `long` sleeves seven, while `stripe`/`vest` took most of the floor. Every "pick from a list" in
 * this file was quietly drawing from about half its palette.
 *
 * `fmix32` (murmur3's finalizer) is what makes the salts genuinely independent. Note this **changes
 * everyone's existing look** — it is a reshuffle, not a redesign, and the wardrobe was always
 * "stable per name", never "these specific people look like this".
 */
function hash(name: string, salt: number): number {
  let h = (2166136261 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Pick from a list by a salted hash of the name — stable forever, uncorrelated across salts. */
function pick<T>(list: readonly T[], name: string, salt: number): T {
  return list[Math.floor(hash(name, salt) * list.length)]!;
}

/** Perceived brightness of a `#rrggbb`, 0–1 (Rec. 601 — good enough, and cheap). */
function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/**
 * Pick a hair colour that actually *reads* against this skin.
 *
 * With a full-rainbow skin palette, an independent hair pick will sooner or later put green hair on a green
 * head — and at 30px that isn't a person, it's a blob. So we walk the palette from the hashed starting point
 * and take the first colour with enough brightness separation from the skin. Still deterministic (same name
 * → same hair), still uncorrelated in *which* colour you get; it just refuses the invisible ones.
 */
const MIN_CONTRAST = 0.22;
/** Walk a palette from a hashed start and take the first entry that separates from `against`. */
function pickContrasting(palette: readonly string[], name: string, salt: number, against: string): string {
  const start = Math.floor(hash(name, salt) * palette.length);
  const l = luma(against);
  for (let i = 0; i < palette.length; i++) {
    const c = palette[(start + i) % palette.length]!;
    if (Math.abs(luma(c) - l) >= MIN_CONTRAST) return c;
  }
  // Nothing in the palette separates enough (a mid-tone skin) — fall back to the extremes, which always do.
  return l > 0.5 ? '#221a14' : '#e8dcc8';
}

/**
 * Skin, from deep browns through to mint and peach. Deliberately **not** a "realistic" ramp: these are
 * stylised block people in a stylised office, and a floor where everyone is a slightly different beige is
 * both duller and a worse look than one where people are plainly, cheerfully different. The natural tones
 * and the fantastical ones sit in one list on purpose, so no member is ever "the odd one out".
 */
const SKINS = [
  '#f7d9b8',
  '#f0c9a0',
  '#e8b07d',
  '#d99b62',
  '#c68642',
  '#a9683a',
  '#8d5524',
  '#6b3f1f',
  '#4e2c14',
  '#9fd8b8', // mint
  '#8ed1c9', // seafoam
  '#a9c6f0', // periwinkle
  '#e6c8a4', // sand (lavender until 2026-10-12 — nick: too much purple on the floor)
  '#f2c4a0', // peach (was orchid)
  '#f2a6a6', // coral
  '#f5cf6e', // gold
  '#9db8c9', // slate
  '#b8d97a', // moss
] as const;

const HAIR_COLORS = [
  '#221a14', // black
  '#3d2a1c', // dark brown
  '#6b4a2b', // brown
  '#a06c38', // auburn
  '#d8b45c', // blonde
  '#e8dcc8', // platinum
  '#b0b6bb', // grey
  '#8a3a2e', // red
  '#3f6fa8', // blue
  '#2f8f7a', // teal
  '#b5603a', // copper (was magenta)
  '#4a6a8f', // steel blue (was violet)
  '#4f8a3a', // green
  '#e07a3f', // orange
] as const;

/** Hair silhouettes. These must read at ~30px, so they differ by *shape*, not by strand detail. */
export type HairStyle = 'bald' | 'buzz' | 'short' | 'side' | 'bob' | 'long' | 'ponytail' | 'afro' | 'bun';

export type FacialHair = 'none' | 'stubble' | 'moustache' | 'goatee' | 'beard' | 'beard-wild';

/**
 * Style, grooming and the spots (office figure v2, spec §2.4–2.5, lane 01M62411D3).
 *
 * People dress in a **style**, not a random mix, so the top, the trousers and the shoes are picked
 * from the style's pools. **Grooming** is one dial per member that chooses whether hair and facial
 * hair come from the polished pool or the relaxed one — picked separately from style, so a formal
 * dresser can have messy hair. Accessories are **one pick per spot** (eyes, ears, head, neck; the
 * wrist arrives with its first piece), each rare on its own, so most people wear none or one and a
 * few wear two.
 *
 * This retired `presents`, the femme/masc/neutral axis that coordinated hair length with facial hair
 * (added 2026-07-30 because the floor read as all male). Under nick's rule (2026-10-22) nothing is
 * tied to gender or race: a long-haired member with a beard, or a bearded member in a dress, is a
 * person, not a mismatch. The guard against the floor drifting back to one look is **pick weights,
 * never coupling** — long hair is weighted to stay common in both grooming pools, and every pick is
 * its own salt of the name.
 */
export type Style = 'formal' | 'smart' | 'casual' | 'athletic';
const STYLES: readonly Style[] = ['formal', 'formal', 'smart', 'smart', 'casual', 'casual', 'casual', 'athletic'];
export type Grooming = 'polished' | 'relaxed';
const GROOMING: readonly Grooming[] = ['polished', 'polished', 'relaxed', 'relaxed', 'relaxed'];

/** Hair by grooming. Long shapes (bob, long, ponytail, bun) sit in BOTH pools, weighted so that about
 *  half the floor wears one — the thing the retired axis existed to guarantee. */
const POLISHED_HAIR: readonly HairStyle[] = ['side', 'bun', 'bob', 'buzz', 'short', 'ponytail', 'side', 'bun', 'bald'];
const RELAXED_HAIR: readonly HairStyle[] = ['long', 'afro', 'short', 'ponytail', 'bob', 'long', 'buzz', 'afro', 'long'];
/** Facial hair by grooming. Weighted toward `none` either way — a floor where everyone has a beard is
 *  as uniform as one where nobody does. The untrimmed beard joins the relaxed pool with v2-3a. */
const POLISHED_FACIAL: readonly FacialHair[] = ['none', 'none', 'none', 'none', 'none', 'moustache', 'goatee', 'beard'];
// `beard-wild` is the untrimmed beard (figure v2-3a): relaxed grooming's own, never the polished pool's.
const RELAXED_FACIAL: readonly FacialHair[] = ['none', 'none', 'none', 'none', 'stubble', 'stubble', 'beard-wild', 'goatee', 'beard'];

export type Hat = 'none' | 'cap' | 'beanie' | 'band';
/** Hats are the rarest thing on the floor, so they stay a small delight rather than a uniform. */
const HATS: readonly Hat[] = ['none', 'none', 'none', 'none', 'none', 'cap', 'beanie', 'band'];
const HAT_COLORS = ['#d1503f', '#2f7f6a', '#3f6fa8', '#e1ad01', '#2f8fa3', '#2a2118', '#e8dcc8', '#e07a3f'] as const;

/**
 * The cut of the top, by style. `sleeves` is the one that does real visual work: a short sleeve leaves
 * the forearm **bare skin**, which — on a 90px character — is a bigger, clearer difference than any
 * pattern. Today's five cuts stand in for the spec's catalogue until the new pieces land (v2-5b…):
 * `long` is the shirt, `vest` the sleeveless knit, `tee` doubles as the sport tee.
 */
export type TopCut = 'tee' | 'long' | 'stripe' | 'hoodie' | 'vest';
const CUTS_BY_STYLE: Record<Style, readonly TopCut[]> = {
  formal: ['long', 'vest', 'long', 'stripe'],
  smart: ['long', 'stripe', 'vest', 'stripe'],
  casual: ['tee', 'hoodie', 'stripe', 'tee', 'hoodie'],
  athletic: ['tee', 'hoodie', 'tee'],
};

const BOTTOMS = {
  denim: '#3f5570',
  charcoal: '#2b3038',
  khaki: '#7a6a4f',
  olive: '#4a5a3a',
  plum: '#6b3f52',
  grey: '#5a5f66',
  rust: '#8a4a32',
  teal: '#2f4a4a',
  mauve: '#7d6b8f',
  black: '#1f2226',
} as const;
const BOTTOMS_BY_STYLE: Record<Style, readonly string[]> = {
  formal: [BOTTOMS.charcoal, BOTTOMS.khaki, BOTTOMS.grey, BOTTOMS.plum, BOTTOMS.black],
  smart: [BOTTOMS.denim, BOTTOMS.olive, BOTTOMS.khaki, BOTTOMS.charcoal, BOTTOMS.mauve],
  casual: [BOTTOMS.denim, BOTTOMS.olive, BOTTOMS.rust, BOTTOMS.mauve, BOTTOMS.denim],
  athletic: [BOTTOMS.charcoal, BOTTOMS.grey, BOTTOMS.teal, BOTTOMS.black],
};

const SHOES = {
  white: '#f2eee6',
  black: '#22262b',
  red: '#d1503f',
  navy: '#2f4a70',
  tan: '#a9683a',
  green: '#2f8f7a',
  yellow: '#e1ad01',
} as const;
const SHOES_BY_STYLE: Record<Style, readonly string[]> = {
  formal: [SHOES.black, SHOES.tan, SHOES.navy, SHOES.black],
  smart: [SHOES.white, SHOES.tan, SHOES.navy, SHOES.black, SHOES.green],
  casual: [SHOES.white, SHOES.red, SHOES.green, SHOES.yellow, SHOES.navy],
  athletic: [SHOES.white, SHOES.red, SHOES.yellow, SHOES.white],
};

/**
 * The spots (spec §2.4): one pick each, each rare, so most people wear none or one. Glasses need a
 * face, so agents never get them. On-ear headphones are the do-not-disturb signal (`lookFor`): they
 * take the ears spot. Earrings (v2-4b) share the ears spot, so dnd headphones replace them; the watch
 * (v2-4c) and headphones around the neck (v2-4d) slot into their spots as they land.
 */
export type Eyes = 'none' | 'glasses' | 'glasses-square' | 'glasses-browline';
export type Ears = 'none' | 'headphones' | 'earrings-stud' | 'earrings-hoop';
export type Neck = 'none' | 'scarf';
// Three frame shapes (v2-4a): round, square rims, a browline — about one in four wear any, as before.
const EYES: readonly Eyes[] = ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'glasses', 'glasses-square', 'glasses-browline'];
// Studs and hoops (v2-4b) beside the headphones: about one in four wear something on the ears.
const EARS: readonly Ears[] = ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'earrings-stud', 'earrings-hoop', 'headphones'];
/** Earring metals — gold, silver, rose gold: jewellery reads as metal, not as the cosy accessory set. */
const METALS = ['#e2b85c', '#cfd3d8', '#dca48c'] as const;
const NECK: readonly Neck[] = ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'scarf'];
/** The one legacy summary the painters still read (`character.ts`, the portrait): the most visible
 *  of the worn spots. The rendered figure draws every spot (`layersFor`). */
export type Accessory = 'none' | 'glasses' | 'headphones' | 'scarf';
/** Cosy, saturated accessory tones (scarf wool / headphone shells) — a warm set, deliberately off the
 * identity hue so the accessory reads as *a thing they own*, not part of their colour signature. */
const ACCESSORY_COLORS = ['#d1503f', '#e08a43', '#e1ad01', '#2f8f7a', '#3f6fa8', '#2f8fa3', '#c86a3a', '#4f8a3a'] as const;

/** A gentle per-person smile for humans — some beam wide, some just turn the corners up. */
export type Smile = 'soft' | 'wide';
const SMILES: readonly Smile[] = ['soft', 'soft', 'wide'];

/**
 * Build, the one bodily difference between members (office figure v2, spec §2.1): the rendered figure is
 * drawn this much wider or narrower about its floor point. Everyone is the same height; nick's line is
 * "too much variation in avatar build" — so it stays within 4%.
 */
const BUILDS = [0.96, 0.98, 1.0, 1.02, 1.04] as const;

export interface Appearance {
  skin: string;
  /** How they dress — picks the top, trousers and shoes pools. */
  style: Style;
  /** One dial for hair and facial hair: the polished pool or the relaxed one. */
  grooming: Grooming;
  hair: HairStyle;
  hairColor: string;
  facialHair: FacialHair;
  hat: Hat;
  hatColor: string;
  /** The cut of the top. The *hue* is not here — it is the member's identity colour (see the file docs). */
  cut: TopCut;
  /** True when the forearms are bare (short sleeves) — the strongest small-scale variation we have. */
  bareArms: boolean;
  bottom: string;
  shoes: string;
  /** The spots, one pick each. */
  eyes: Eyes;
  ears: Ears;
  neck: Neck;
  /** The most visible worn spot, for the painters that draw one thing — see `Accessory`. */
  accessory: Accessory;
  /** The accessories' own cosy colour — never the identity hue. */
  accessoryColor: string;
  /** The metal of their earrings. */
  metal: string;
  /** How a human smiles. */
  smile: Smile;
  /** Horizontal draw scale of the rendered figure, 0.96–1.04 — see `BUILDS`. */
  build: number;
}

function summaryOf(eyes: Eyes, ears: Ears, neck: Neck): Accessory {
  if (ears === 'headphones') return ears; // earrings are too small for the painters to draw
  if (eyes !== 'none') return 'glasses'; // whatever the frame, the painters draw one pair
  if (neck !== 'none') return neck;
  return 'none';
}

/**
 * A member's complete look. Every field is an independent salted hash of the name — style, grooming,
 * hair, each spot, skin — so hair colour doesn't correlate with skin, hats don't correlate with beards,
 * and nothing about the hair says anything about the beard. The floor looks like a room of people
 * rather than a row of palette swatches, and nothing in it reads a gender off a name.
 */
export function appearanceOf(node: Pick<OfficeNode, 'name' | 'kind'>): Appearance {
  const { name, kind } = node;
  const style = pick(STYLES, name, 16);
  const grooming = pick(GROOMING, name, 17);
  const hair = pick(grooming === 'polished' ? POLISHED_HAIR : RELAXED_HAIR, name, 3);
  const cut = pick(CUTS_BY_STYLE[style], name, 8);
  const skin = pick(SKINS, name, 1);
  // Agents never wear glasses — the eye glow is their tell, and frames would sit on it.
  const eyes = kind === 'agent' ? 'none' : pick(EYES, name, 18);
  const ears = pick(EARS, name, 19);
  const neck = pick(NECK, name, 20);
  return {
    skin,
    style,
    grooming,
    hair,
    // Both hair and hats are picked to *contrast with the skin*. With a full-rainbow skin palette an
    // independent pick eventually lands teal hair (or a teal beanie) on a teal head — which at 30px is not
    // a person, it is a blob. Both shipped once; the character sheet caught them.
    hairColor: pickContrasting(HAIR_COLORS, name, 4, skin),
    // Agents have no facial hair (the glow tell wants a clear face); humans draw from their grooming pool,
    // whatever their hair — a beard under a bun is a person.
    facialHair: kind === 'agent' ? 'none' : pick(grooming === 'polished' ? POLISHED_FACIAL : RELAXED_FACIAL, name, 5),
    hat: pick(HATS, name, 6),
    hatColor: pickContrasting(HAT_COLORS, name, 7, skin),
    cut,
    bareArms: cut === 'tee' || cut === 'vest',
    bottom: pick(BOTTOMS_BY_STYLE[style], name, 9),
    shoes: pick(SHOES_BY_STYLE[style], name, 10),
    eyes,
    ears,
    neck,
    accessory: summaryOf(eyes, ears, neck),
    accessoryColor: pick(ACCESSORY_COLORS, name, 12),
    metal: pick(METALS, name, 21),
    smile: pick(SMILES, name, 13),
    build: pick(BUILDS, name, 15),
  };
}

/** The look a member wears this frame: their hashed one, with headphones on the ears while they are
 *  dnd — the room-readable signal (§4) — whatever that spot held. */
export function lookFor(node: Pick<OfficeNode, 'name' | 'kind' | 'dnd'>): Appearance {
  const a = appearanceOf(node);
  return node.dnd ? { ...a, ears: 'headphones', accessory: 'headphones' } : a;
}
