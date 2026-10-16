import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FULL_ROOM,
  AMBIENT_P_FULL,
  AMBIENT_P_QUIET,
  AMBIENT_QUIET_ROOM,
  AMBIENT_SLOT_MS,
  ambientFireP,
  ambientPool,
  type AmbientPool,
  COMPANION_MIN_ROOM,
  COVERAGE_WINDOW_SLOTS,
  decideAmbient,
  roll,
  slotAt,
  slotRng,
} from './ambientSeed';

/**
 * The shared-seed contract (E1 spec §2): every ambient decision is a pure function of inputs every
 * viewer already holds — team slug, wall-clock slot, purpose tag. What's worth pinning is the
 * falsifier itself: same inputs → same value on any machine, different purpose/slot/team →
 * independent draws, and a distribution healthy enough to weight beats with.
 */

describe('slotAt — the 10 s lattice', () => {
  it('floors wall-clock time into fixed slots', () => {
    expect(slotAt(0)).toBe(0);
    expect(slotAt(AMBIENT_SLOT_MS - 1)).toBe(0);
    expect(slotAt(AMBIENT_SLOT_MS)).toBe(1);
    expect(slotAt(AMBIENT_SLOT_MS * 7 + 3)).toBe(7);
  });

  it('two viewers with skewed clocks inside one slot agree on the slot', () => {
    const t = 1_756_000_000_000; // an arbitrary real epoch ms
    const skewMs = 2_000; // ordinary NTP-grade skew, well under the 10 s slot
    expect(slotAt(t)).toBe(
      slotAt(t + skewMs - (t % AMBIENT_SLOT_MS > AMBIENT_SLOT_MS - skewMs ? skewMs : 0)),
    );
  });
});

describe('roll — one shared draw per (team, slot, purpose)', () => {
  it('is deterministic: two viewers computing the same draw get the same value', () => {
    expect(roll('revive', 87_654_321, 'fire')).toBe(roll('revive', 87_654_321, 'fire'));
  });

  it('stays in [0, 1)', () => {
    for (let s = 0; s < 1000; s++) {
      const v = roll('revive', s, 'fire');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('purposes are independent — one slot yields as many uncorrelated draws as a beat needs', () => {
    const s = 42;
    const values = ['fire', 'actor', 'beat', 'pet-follow', 'phone-stop-2'].map((p) =>
      roll('revive', s, p),
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('slots are independent — consecutive slots do not repeat or trend', () => {
    const values = Array.from({ length: 200 }, (_, s) => roll('revive', s, 'fire'));
    expect(new Set(values).size).toBe(values.length);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });

  it('teams are independent — two teams watching the same wall clock see different rooms', () => {
    const a = Array.from({ length: 50 }, (_, s) => roll('revive', s, 'fire'));
    const b = Array.from({ length: 50 }, (_, s) => roll('other-team', s, 'fire'));
    expect(a).not.toEqual(b);
  });

  it('fills its range — no bucket collapse (the appearance.ts FNV lesson)', () => {
    const buckets = new Array(10).fill(0);
    for (let s = 0; s < 2000; s++) buckets[Math.floor(roll('revive', s, 'beat') * 10)]!++;
    for (const count of buckets) expect(count).toBeGreaterThan(100);
  });
});

describe('slotRng — a slot-scoped sequence for beat interiors', () => {
  it('is deterministic: both viewers playing the same beat draw the same sequence', () => {
    const a = slotRng('revive', 7, 'walk');
    const b = slotRng('revive', 7, 'walk');
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
  });

  it('is slot-scoped: no state survives the slot, so a skipped slot cannot desync the next one', () => {
    const first = slotRng('revive', 7, 'walk');
    first();
    first();
    first(); // one viewer consumes; the other never ran this slot
    const fresh = slotRng('revive', 8, 'walk');
    const other = slotRng('revive', 8, 'walk');
    expect(fresh()).toBe(other());
  });

  it('draws within a sequence are independent and in [0, 1)', () => {
    const rng = slotRng('revive', 3, 'walk');
    const values = Array.from({ length: 100 }, () => rng());
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('ambientFireP — the occupancy curve (E1b)', () => {
  it('is flat at both ends, so an arriving twelfth member changes nothing', () => {
    expect(ambientFireP(0)).toBe(AMBIENT_P_QUIET);
    expect(ambientFireP(AMBIENT_QUIET_ROOM)).toBe(AMBIENT_P_QUIET);
    expect(ambientFireP(AMBIENT_FULL_ROOM)).toBe(AMBIENT_P_FULL);
    expect(ambientFireP(40)).toBe(AMBIENT_P_FULL);
  });

  it('rises monotonically through the middle — no step a viewer could read as the room reacting to them', () => {
    for (let n = 0; n < 20; n++)
      expect(ambientFireP(n + 1)).toBeGreaterThanOrEqual(ambientFireP(n));
    // Mid-ramp really is between the ends, not snapped to one of them.
    const mid = ambientFireP((AMBIENT_QUIET_ROOM + AMBIENT_FULL_ROOM) / 2);
    expect(mid).toBeGreaterThan(AMBIENT_P_QUIET);
    expect(mid).toBeLessThan(AMBIENT_P_FULL);
  });

  it('never leaves the room metronomic — a probability of 1 would delete the randomness entirely', () => {
    for (let n = 0; n < 40; n++) {
      expect(ambientFireP(n)).toBeGreaterThan(0);
      expect(ambientFireP(n)).toBeLessThan(0.9);
    }
  });
});

describe('decideAmbient — the per-slot decision, pure over the shared pool', () => {
  const pool = {
    members: ['ada', 'bo', 'cy', 'dev', 'eli', 'fen'],
    pairs: [
      ['ada', 'bo'],
      ['cy', 'dev'],
    ] as Array<[string, string]>,
  };

  it('two viewers over the same slot range and pool produce identical decision logs', () => {
    const log = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => decideAmbient('revive', from + i, pool));
    expect(log(0, 500)).toEqual(log(0, 500));
    // A viewer that missed the first 300 slots reconverges immediately: per-slot purity means the
    // overlap is identical regardless of where either viewer started.
    expect(log(300, 500)).toEqual(log(0, 500).slice(300));
  });

  it('ignores pool array order — candidate ordering is canonical, array order never leaks in', () => {
    const shuffled = {
      members: ['fen', 'cy', 'ada', 'eli', 'bo', 'dev'],
      pairs: [
        ['cy', 'dev'],
        ['ada', 'bo'],
      ] as Array<[string, string]>,
    };
    for (let s = 0; s < 200; s++) {
      expect(decideAmbient('revive', s, shuffled)).toEqual(decideAmbient('revive', s, pool));
    }
  });

  it("fires at the occupancy curve's rate — the six-member pool sits mid-ramp", () => {
    let fired = 0;
    for (let s = 0; s < 5000; s++) if (decideAmbient('revive', s, pool).kind !== 'none') fired++;
    const want = ambientFireP(pool.members.length);
    expect(fired / 5000).toBeGreaterThan(want - 0.03);
    expect(fired / 5000).toBeLessThan(want + 0.03);
  });

  it('a fuller room fires more often than a room of two — the whole point of E1b', () => {
    const rate = (n: number) => {
      const members = Array.from({ length: n }, (_, i) => `m${i}`);
      let fired = 0;
      for (let s = 0; s < 5000; s++)
        if (decideAmbient('revive', s, { members, pairs: [] }).kind !== 'none') fired++;
      return fired / 5000;
    };
    const two = rate(2);
    const full = rate(AMBIENT_FULL_ROOM);
    expect(full).toBeGreaterThan(two * 2);
    expect(two).toBeLessThan(0.32);
  });

  it('keeps the category split: ~35% pet, then ~22% pair among the rest, else a member', () => {
    let pet = 0,
      pair = 0,
      member = 0;
    for (let s = 0; s < 10_000; s++) {
      const d = decideAmbient('revive', s, pool);
      if (d.kind === 'pet') pet++;
      else if (d.kind === 'pair') pair++;
      else if (d.kind === 'member' || d.kind === 'meet') member++;
    }
    const fired = pet + pair + member;
    expect(pet / fired).toBeGreaterThan(0.31);
    expect(pet / fired).toBeLessThan(0.39);
    expect(pair / (pair + member)).toBeGreaterThan(0.18);
    expect(pair / (pair + member)).toBeLessThan(0.26);
  });

  it('spreads member picks across the whole pool', () => {
    const counts = new Map<string, number>();
    for (let s = 0; s < 10_000; s++) {
      const d = decideAmbient('revive', s, pool);
      if (d.kind === 'member') counts.set(d.who, (counts.get(d.who) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(pool.members);
  });

  it('never picks a pair when the pool has none, and no beat at all from an empty room', () => {
    for (let s = 0; s < 500; s++) {
      const d = decideAmbient('revive', s, { members: ['ada'], pairs: [] });
      expect(d.kind === 'pair').toBe(false);
      expect(decideAmbient('revive', s, { members: [], pairs: [] })).toEqual({ kind: 'none' });
    }
  });
});

describe('ambientPool — a working member keeps their desk (ADR 464 §3.1, falsifier 1)', () => {
  const node = (name: string, posture: 'working' | 'active') =>
    ({
      name,
      posture,
      presence: 'online',
      kind: 'agent',
    }) as unknown as import('./types').OfficeNode;
  // Row-mates: desk slots 0 and 1 share a pod row in the layout; 2 and 3 the next.
  const placements = new Map<string, import('./seating').Placement>([
    ['ada', { kind: 'desk', slot: 0 }],
    ['bo', { kind: 'desk', slot: 1 }],
    ['cy', { kind: 'desk', slot: 2 }],
    ['di', { kind: 'desk', slot: 3 }],
    ['ev', { kind: 'leisure', spot: 0 }],
  ]);
  const nodes = new Map([
    ['ada', node('ada', 'working')],
    ['bo', node('bo', 'active')],
    ['cy', node('cy', 'active')],
    ['di', node('di', 'active')],
    ['ev', node('ev', 'active')],
  ]);

  it('lists every present desk member for micro-gestures, working or not', () => {
    expect(ambientPool(placements, nodes).members.sort()).toEqual(['ada', 'bo', 'cy', 'di']);
  });

  it('never sends a working member on an errand', () => {
    const pool = ambientPool(placements, nodes);
    expect(pool.errands).not.toContain('ada');
    expect(pool.errands?.sort()).toEqual(['bo', 'cy', 'di']);
  });

  it('never pairs a working member for a desk chat', () => {
    const pool = ambientPool(placements, nodes);
    for (const [a, b] of pool.pairs) {
      expect(a).not.toBe('ada');
      expect(b).not.toBe('ada');
    }
    // The rule bites: with nobody working, ada's row pair is back.
    const rested = new Map(nodes);
    rested.set('ada', node('ada', 'active'));
    const pairs = ambientPool(placements, rested).pairs.map((p) => p.join('+'));
    expect(pairs.some((p) => p.includes('ada'))).toBe(true);
  });
});

describe('decideAmbient — the aisle meet (nick, 2026-10-12)', () => {
  const pool = { members: ['ada', 'bo', 'cy', 'dev'], pairs: [] as Array<[string, string]>, errands: ['ada', 'bo', 'cy'] };
  it('picks two different errand-free members, ~18% of what is left after pet and pair', () => {
    let meet = 0,
      rest = 0;
    for (let s = 0; s < 10_000; s++) {
      const d = decideAmbient('revive', s, pool);
      if (d.kind === 'meet') {
        meet++;
        expect(d.a).not.toBe(d.b);
        expect(pool.errands).toContain(d.a);
        expect(pool.errands).toContain(d.b);
      } else if (d.kind === 'member') rest++;
    }
    expect(meet / (meet + rest)).toBeGreaterThan(0.14);
    expect(meet / (meet + rest)).toBeLessThan(0.22);
  });
  it('needs two who are free — a lone errand-free member never meets', () => {
    for (let s = 0; s < 2_000; s++)
      expect(decideAmbient('revive', s, { ...pool, errands: ['ada'] }).kind).not.toBe('meet');
  });
});

describe('decideAmbient — who fidgets is a rotation (lane 01M4V9VNMY, spec L1)', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const poolOf = (n: number): AmbientPool => ({ members: names(n), errands: names(n), pairs: [] });

  /** The member decisions of one coverage window, in slot order. */
  function memberRun(team: string, n: number, w: number): string[] {
    const out: string[] = [];
    for (let s = w * COVERAGE_WINDOW_SLOTS; s < (w + 1) * COVERAGE_WINDOW_SLOTS; s++) {
      const d = decideAmbient(team, s, poolOf(n));
      if (d.kind === 'member') out.push(d.who);
      // A companion takes the next turn of the same rotation (ADR 617), right after the slot's own.
      if (d.kind !== 'none' && d.companion) out.push(d.companion);
    }
    return out;
  }

  it('a lap is a permutation: every member before anyone repeats', () => {
    for (const team of ['revive', 'a', 'b', 'c']) {
      const run = memberRun(team, 6, 3);
      expect(run.length).toBeGreaterThanOrEqual(6);
      expect(new Set(run.slice(0, 6)).size).toBe(6);
    }
  });

  it('never picks the same member twice in a row', () => {
    for (const team of ['revive', 'a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      for (const n of [2, 3, 6, 12]) {
        const run = memberRun(team, n, 5);
        for (let i = 1; i < run.length; i++) expect(run[i]).not.toBe(run[i - 1]);
      }
    }
  });

  it('keeps two viewers in step: the rotation is a pure replay, nobody remembers anything', () => {
    const log = (team: string) =>
      Array.from({ length: 180 }, (_, s) => JSON.stringify(decideAmbient(team, s, poolOf(8))));
    expect(log('revive')).toEqual(log('revive'));
  });

  /** A room-quiet model: a played beat holds the room for one or two slots, and a slot landing in it
   *  never reaches the decision (ADR 086). Returns the share of members with no single-member beat in 10 min. */
  function frozenShare(team: string, n: number): number {
    const gestured = new Set<string>();
    let busyUntil = -1;
    for (let s = 0; s < COVERAGE_WINDOW_SLOTS; s++) {
      if (s < busyUntil) continue;
      const d = decideAmbient(team, s, poolOf(n));
      if (d.kind === 'none') continue;
      busyUntil = s + 1 + Math.floor(roll(team, s, 'len') * 2);
      if (d.kind === 'member') gestured.add(d.who);
      if (d.companion) gestured.add(d.companion);
    }
    return 1 - gestured.size / n;
  }
  const teams = ['revive', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const mean = (n: number) => teams.reduce((acc, t) => acc + frozenShare(t, n), 0) / teams.length;

  it('leaves few desks frozen for ten minutes (a uniform draw left 22% of six and 35% of twelve)', () => {
    expect(mean(6)).toBeLessThan(0.15);
    expect(mean(12)).toBeLessThan(0.2);
  });

  describe('the companion gesture (ADR 617)', () => {
    it("meets nick's bar in practice: a twelve-person room almost never leaves anyone still for ten minutes", () => {
      // Not zero by construction (ADR 617): the replay cannot know which slots a browser skipped.
      const T = Array.from({ length: 200 }, (_, k) => `t${k}`);
      const frozen = T.map((t) => frozenShare(t, 12));
      const members = frozen.reduce((a, f) => a + f, 0) / T.length;
      const windows = frozen.filter((f) => f > 0).length / T.length;
      expect(members).toBeLessThanOrEqual(0.005);
      expect(windows).toBeLessThanOrEqual(0.05);
    });

    it('is never the actor of the beat it accompanies', () => {
      for (const team of teams) {
        for (let s = 0; s < 4 * COVERAGE_WINDOW_SLOTS; s++) {
          const d = decideAmbient(team, s, poolOf(12));
          if (d.kind === 'none' || !d.companion) continue;
          if (d.kind === 'member') expect(d.companion).not.toBe(d.who);
          if (d.kind === 'pair' || d.kind === 'meet') expect([d.a, d.b]).not.toContain(d.companion);
        }
      }
    });

    it('keeps a small room calm: five or fewer members never get one', () => {
      for (const team of teams)
        for (let s = 0; s < 2 * COVERAGE_WINDOW_SLOTS; s++) {
          const d = decideAmbient(team, s, poolOf(COMPANION_MIN_ROOM - 1));
          expect(d.kind === 'none' ? undefined : d.companion).toBeUndefined();
        }
    });

    it('rides along on some fired slots, not all of them', () => {
      let fired = 0;
      let withCompanion = 0;
      for (const team of teams)
        for (let s = 0; s < COVERAGE_WINDOW_SLOTS; s++) {
          const d = decideAmbient(team, s, poolOf(12));
          if (d.kind === 'none') continue;
          fired++;
          if (d.companion) withCompanion++;
        }
      expect(withCompanion / fired).toBeGreaterThan(0.55);
      expect(withCompanion / fired).toBeLessThan(0.9);
    });
  });
});
