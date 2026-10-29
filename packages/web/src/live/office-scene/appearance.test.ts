import { describe, expect, it } from 'vitest';
import { appearanceOf, type Appearance, lookFor } from './appearance';

/**
 * The wardrobe's contract. The point of the whole module is that a floor of members looks like a room of
 * *people* — so what's worth pinning is variety, independence, and the one thing that must NOT vary.
 */

const agent = (name: string) => appearanceOf({ name, kind: 'agent' as const });
const human = (name: string) => appearanceOf({ name, kind: 'human' as const });

/** A realistic spread of names, to sample the distribution the way a real roster would. */
const NAMES = [
  'miley', 'izzo', 'stanley', 'ryder', 'nick', 'ada', 'bo', 'cy', 'dev', 'eli',
  'fen', 'gus', 'hana', 'ivy', 'jo', 'kit', 'lu', 'mo', 'nia', 'ola',
  'pax', 'quinn', 'rex', 'sol', 'tay', 'uma', 'vic', 'wren', 'xan', 'yuki',
];

describe('determinism', () => {
  it('is stable per name — a teammate looks the same across frames, reloads, and machines', () => {
    expect(agent('miley')).toEqual(agent('miley'));
    expect(human('nick')).toEqual(human('nick'));
  });

  it('differs between people', () => {
    const looks = NAMES.map((n) => JSON.stringify(agent(n)));
    expect(new Set(looks).size).toBeGreaterThan(NAMES.length * 0.9);
  });
});

describe('build (office figure v2)', () => {
  it('gives everyone a build within 4% of the base, stable per name, and varied', () => {
    const builds = NAMES.map((n) => human(n).build);
    expect(builds.every((b) => b >= 0.96 && b <= 1.04)).toBe(true);
    expect(human('ada').build).toBe(human('ada').build);
    expect(new Set(builds).size).toBeGreaterThan(2);
  });
});

describe('variety', () => {
  const looks = NAMES.map(human);
  const spread = (key: keyof Appearance) => new Set(looks.map((l) => String(l[key]))).size;

  it('varies skin, hair, hair colour, trousers and shoes across a roster', () => {
    expect(spread('skin')).toBeGreaterThan(6);
    expect(spread('hair')).toBeGreaterThan(4);
    expect(spread('hairColor')).toBeGreaterThan(5);
    expect(spread('bottom')).toBeGreaterThan(4);
    expect(spread('shoes')).toBeGreaterThan(3);
    expect(spread('cut')).toBeGreaterThan(2);
  });

  it('lets people be bald, and lets some go bare-armed', () => {
    expect(looks.some((l) => l.hair === 'bald')).toBe(true);
    expect(looks.some((l) => l.bareArms)).toBe(true);
    expect(looks.some((l) => !l.bareArms)).toBe(true);
  });

  it('keeps hats and facial hair *rare* — a floor where everyone has one is as uniform as none', () => {
    const hatted = looks.filter((l) => l.hat !== 'none').length / looks.length;
    const bearded = looks.filter((l) => l.facialHair !== 'none').length / looks.length;
    expect(hatted).toBeGreaterThan(0);
    expect(hatted).toBeLessThan(0.55);
    expect(bearded).toBeGreaterThan(0);
    expect(bearded).toBeLessThan(0.7);
  });

  it('gives accessories (the per-person quirk) to some but keeps them rare, and varies the smile', () => {
    const accessorised = looks.filter((l) => l.accessory !== 'none').length / looks.length;
    expect(accessorised).toBeGreaterThan(0);
    expect(accessorised).toBeLessThan(0.6);
    // more than one kind of accessory shows up across the roster
    expect(new Set(looks.map((l) => l.accessory)).size).toBeGreaterThan(2);
    // both smile widths are present
    expect(new Set(looks.map((l) => l.smile)).size).toBe(2);
  });

  it('never gives anyone hair that vanishes into their skin', () => {
    // With a full-rainbow skin palette, an independent hair pick eventually puts green hair on a green
    // head — which at 30px is not a person, it is a blob. (This shipped once; the sheet caught it.)
    const luma = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    for (const n of NAMES) {
      const l = human(n);
      if (l.hair === 'bald') continue;
      expect(Math.abs(luma(l.hairColor) - luma(l.skin))).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('picks each trait independently — hair colour must not correlate with skin', () => {
    // If two traits shared a salt they would move together; a shared stream would show up as the same
    // members always pairing the same two values.
    const pairs = new Set(NAMES.map((n) => `${human(n).skin}|${human(n).hairColor}`));
    const skins = new Set(NAMES.map((n) => human(n).skin));
    expect(pairs.size).toBeGreaterThan(skins.size);
  });
});

describe('the identity read (load-bearing)', () => {
  it('never puts a colour on the top — the top is the member colour, and that is how you know who it is', () => {
    // `Appearance` deliberately has no top-hue field. If one is ever added, the roster dot, the label and
    // the desk all stop agreeing with the body, and you can no longer pick a member out of the floor.
    expect(Object.keys(agent('miley'))).not.toContain('top');
    expect(Object.keys(agent('miley'))).not.toContain('topColor');
  });

  it('keeps the agent tell intact — no agent gets facial hair under its visor', () => {
    for (const n of NAMES) expect(agent(n).facialHair).toBe('none');
    // ...and humans do get it, so the absence is a tell rather than an oversight.
    expect(NAMES.some((n) => human(n).facialHair !== 'none')).toBe(true);
  });

  it('never puts glasses on an agent — a visor has nowhere for them to sit (like facial hair)', () => {
    for (const n of NAMES) expect(agent(n).accessory).not.toBe('glasses');
    // ...but humans do wear them, so the absence is a rule rather than a dead feature.
    expect(NAMES.some((n) => human(n).accessory === 'glasses')).toBe(true);
  });

  it('dresses the same person the same way whichever kind they are, apart from the tell', () => {
    const a = agent('sol');
    const h = human('sol');
    expect(a.skin).toBe(h.skin);
    expect(a.hair).toBe(h.hair);
    expect(a.cut).toBe(h.cut);
  });
});

describe('style, grooming and the spots (office figure v2-5a — presents retired)', () => {
  const names = Array.from({ length: 400 }, (_, i) => `person${i}`);
  const looks = names.map((n) => appearanceOf({ name: n, kind: 'human' }));

  it('puts long hair on the floor without coupling it to anything — about half, from both grooming pools', () => {
    const LONG = new Set(['bob', 'long', 'ponytail', 'bun']);
    const withLong = looks.filter((l) => LONG.has(l.hair));
    expect(withLong.length).toBeGreaterThan(names.length * 0.3);
    for (const g of ['polished', 'relaxed'] as const) {
      const pool = looks.filter((l) => l.grooming === g);
      expect(pool.filter((l) => LONG.has(l.hair)).length).toBeGreaterThan(pool.length * 0.25);
    }
  });

  it('deals beards to long hair as readily as to short — hair says nothing about facial hair', () => {
    const LONG = new Set(['bob', 'long', 'ponytail', 'bun']);
    const share = (list: typeof looks) => list.filter((l) => l.facialHair !== 'none').length / list.length;
    const long = looks.filter((l) => LONG.has(l.hair));
    const short = looks.filter((l) => !LONG.has(l.hair));
    expect(long.length).toBeGreaterThan(50);
    expect(Math.abs(share(long) - share(short))).toBeLessThan(0.12);
    expect(long.some((l) => l.facialHair === 'beard')).toBe(true);
  });

  it('draws every option from every palette — a weak hash silently halves the wardrobe', () => {
    expect(new Set(looks.map((l) => l.cut)).size).toBe(5);
    expect(new Set(looks.map((l) => l.hat)).size).toBe(5);
    expect(new Set(looks.map((l) => l.style))).toEqual(new Set(['formal', 'smart', 'casual', 'athletic']));
    expect(new Set(looks.map((l) => l.grooming))).toEqual(new Set(['polished', 'relaxed']));
    expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThan(14);
    expect(new Set(looks.map((l) => l.hair)).size).toBeGreaterThan(6);
  });

  it('dresses by style — a formal dresser never wears a hoodie, an athlete never a shirt', () => {
    for (const l of looks) {
      if (l.style === 'formal') expect(l.cut).not.toBe('hoodie');
      if (l.style === 'athletic') expect(['tee', 'hoodie']).toContain(l.cut);
    }
  });

  it('keeps style and grooming independent of each other and of the skin', () => {
    const formal = looks.filter((l) => l.style === 'formal');
    expect(formal.some((l) => l.grooming === 'relaxed')).toBe(true);
    expect(formal.some((l) => l.grooming === 'polished')).toBe(true);
    for (const st of ['formal', 'smart', 'casual', 'athletic'] as const) {
      expect(new Set(looks.filter((l) => l.style === st).map((l) => l.skin)).size).toBeGreaterThan(8);
    }
  });

  it('picks each spot on its own, rare, so most wear none or one and a few wear two', () => {
    const worn = (l: (typeof looks)[number]) => [l.eyes, l.ears, l.neck].filter((x) => x !== 'none').length;
    expect(looks.filter((l) => worn(l) === 0).length).toBeGreaterThan(names.length * 0.4);
    expect(looks.some((l) => worn(l) >= 2)).toBe(true);
    expect(looks.filter((l) => worn(l) >= 2).length).toBeLessThan(names.length * 0.15);
    // the legacy summary names the most visible worn spot
    for (const l of looks) {
      if (l.ears === 'headphones') expect(l.accessory).toBe('headphones');
      else if (l.eyes !== 'none') expect(l.accessory).toBe('glasses');
      else if (l.neck === 'scarf') expect(l.accessory).toBe('scarf');
      else expect(l.accessory).toBe('none');
    }
  });

  it('puts headphones on the ears while dnd, whatever that spot held, and takes them off after', () => {
    const on = lookFor({ name: 'person7', kind: 'human', dnd: true });
    expect(on.ears).toBe('headphones');
    expect(on.accessory).toBe('headphones');
    expect(lookFor({ name: 'person7', kind: 'human', dnd: false })).toEqual(appearanceOf({ name: 'person7', kind: 'human' }));
  });

  it('moves headphones worn round the neck up onto the ears on dnd, never two pairs', () => {
    const name = Array.from({ length: 400 }, (_, i) => `person${i}`).find((n) => appearanceOf({ name: n, kind: 'human' }).neck === 'headphones-neck')!;
    const on = lookFor({ name, kind: 'human', dnd: true });
    expect(on.ears).toBe('headphones');
    expect(on.neck).toBe('none');
    expect(lookFor({ name, kind: 'human', dnd: false }).neck).toBe('headphones-neck');
    const names = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    expect(names.some((n) => { const a = appearanceOf({ name: n, kind: 'human' }); return a.ears === 'headphones' && a.neck === 'headphones-neck'; })).toBe(false);
  });

  it('keeps beards on the floor', () => {
    expect(looks.filter((l) => l.facialHair !== 'none').length).toBeGreaterThan(20);
  });

  it('still gives agents no facial hair and no glasses, whatever their style', () => {
    for (const name of names) {
      const a = appearanceOf({ name, kind: 'agent' });
      expect(a.facialHair).toBe('none');
      expect(a.eyes).toBe('none');
    }
  });
});
