import { describe, expect, it } from 'vitest';
import { Affinity, decide, ownerFor, parseVmsTxt } from './affinity.js';

describe('ADR 608 — team affinity by rendezvous hash', () => {
  const machines = ['m1', 'm2', 'm3', 'm4'];

  it('is deterministic and picks a member of the list', () => {
    for (const t of ['revive', 'dawn', 'lb-run43']) {
      const o = ownerFor(t, machines);
      expect(machines).toContain(o);
      expect(ownerFor(t, [...machines].reverse())).toBe(o);
    }
    expect(ownerFor('revive', [])).toBeNull();
  });

  it('spreads teams across machines', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const o = ownerFor(`team-${i}`, machines)!;
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    for (const m of machines) expect(counts.get(m)!).toBeGreaterThan(50);
  });

  it('removing a machine moves only the teams it owned', () => {
    const before = new Map<string, string>();
    for (let i = 0; i < 200; i++) before.set(`t${i}`, ownerFor(`t${i}`, machines)!);
    const without = machines.filter((m) => m !== 'm2');
    for (const [t, o] of before) {
      const now = ownerFor(t, without)!;
      if (o !== 'm2') expect(now).toBe(o);
      else expect(without).toContain(now);
    }
  });

  it('decide: local for a global route, when affinity is off, when already replayed, or when owner', () => {
    expect(decide(null, 'm1', machines, false).local).toBe(true);
    expect(decide('revive', null, machines, false).local).toBe(true);
    expect(decide('revive', 'm1', machines, true).local).toBe(true);
    const owner = ownerFor('revive', machines)!;
    expect(decide('revive', owner, machines, false)).toEqual({ local: true, owner });
    const other = machines.find((m) => m !== owner)!;
    expect(decide('revive', other, machines, false)).toEqual({ local: false, owner });
  });

  it('decide: a list that does not name this machine is stale — serve, do not replay', () => {
    expect(decide('revive', 'm9', machines, false).local).toBe(true);
  });

  it('parses the Fly TXT answer', () => {
    expect(parseVmsTxt([['e784079b 1234 iad,3287 51d3 ord']])).toEqual(['3287', 'e784079b']);
    expect(parseVmsTxt([['ab12 iad'], ['cd34 iad']])).toEqual(['ab12', 'cd34']);
    expect(parseVmsTxt([])).toEqual([]);
  });

  it('refresh: a list change hands lost teams to onLost; an empty or failing read changes nothing', async () => {
    let list = ['m1'];
    const lost: string[][] = [];
    const a = new Affinity({
      self: 'm1',
      machines: async () => list,
      onLost: (teams) => lost.push(teams),
    });
    const teams = Array.from({ length: 50 }, (_, i) => `team-${i}`);
    for (const t of teams) expect(a.decide(t, false).local).toBe(true);
    list = [];
    await a.refresh();
    expect(a.machines).toEqual(['m1']);
    list = ['m1', 'm2', 'm3'];
    await a.refresh();
    expect(lost).toHaveLength(1);
    const moved = lost[0]!;
    expect(moved.length).toBeGreaterThan(0);
    for (const t of moved) expect(ownerFor(t, list)).not.toBe('m1');
    for (const t of teams.filter((x) => !moved.includes(x))) expect(ownerFor(t, list)).toBe('m1');
    // Off: never replays, never refreshes.
    const off = new Affinity({ self: null, machines: async () => ['x', 'y'] });
    await off.refresh();
    expect(off.decide('revive', false).local).toBe(true);
  });
});
