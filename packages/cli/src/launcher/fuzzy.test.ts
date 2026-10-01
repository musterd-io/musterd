import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankSeats } from './fuzzy.js';
import type { Seat } from './store.js';

const seat = (address: string): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team,
    project,
    member,
    server: '',
    path: `/w/${address}`,
    kind: 'agent',
    harnesses: [],
    remote: null,
    last_session: null,
    problem: null,
  };
};

describe('fuzzy search (spec §3.2)', () => {
  it('matches a subsequence, and every space-separated term', () => {
    expect(fuzzyScore('sta', 'revive/agents/stanley')).not.toBeNull();
    expect(fuzzyScore('rev sta', 'revive/agents/stanley')).not.toBeNull();
    expect(fuzzyScore('rev zzz', 'revive/agents/stanley')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers word starts and runs', () => {
    expect(fuzzyScore('sta', 'revive/agents/stanley')!).toBeGreaterThan(
      fuzzyScore('sta', 'revive/estates/x')!,
    );
  });

  it('ranks by score, then last use, then address', () => {
    const seats = [
      seat('revive/agents/sloane'),
      seat('revive/agents/stanley'),
      seat('dawn/agents/stanley'),
    ];
    const used = (s: Seat) => (s.address === 'dawn/agents/stanley' ? 5 : null);
    expect(rankSeats('stan', seats, used).map((s) => s.address)).toEqual([
      'dawn/agents/stanley',
      'revive/agents/stanley',
    ]);
    expect(rankSeats('s', seats, () => null).length).toBe(3);
  });
});
