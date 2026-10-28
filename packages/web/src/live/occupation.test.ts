import { describe, expect, it } from 'vitest';

import { isGovernanceRole, plateRole, seatRoles } from './occupation';

describe('seatRoles', () => {
  it('shows the roster’s own role names, in the seat’s order', () => {
    expect(seatRoles(['admin', 'founder'], 'admin')).toEqual(['admin', 'founder']);
    expect(seatRoles(['comms'], 'comms')).toEqual([
      'comms',
    ]);
  });

  it('reads the display role where roles is absent or empty', () => {
    expect(seatRoles(undefined, 'designer')).toEqual(['designer']);
    expect(seatRoles([], 'security')).toEqual(['security']);
  });

  it('shows nothing for a member with no role', () => {
    expect(seatRoles([], '')).toEqual([]);
    expect(seatRoles(null, null)).toEqual([]);
  });

  it('drops blanks and repeats', () => {
    expect(seatRoles([' platform ', '', 'platform'], 'platform')).toEqual(['platform']);
  });
});

describe('plateRole (nick, 2026-10-28)', () => {
  it('wears founder over admin over the first role, for a human', () => {
    expect(plateRole(['engineer', 'admin', 'founder'], 'human')).toBe('founder');
    expect(plateRole(['engineer', 'admin'], 'human')).toBe('admin');
    expect(plateRole(['engineer', 'comms'], 'human')).toBe('engineer');
    expect(plateRole([], 'human')).toBeNull();
  });

  it('leaves an agent on its first role whatever it holds', () => {
    expect(plateRole(['engineer', 'admin'], 'agent')).toBe('engineer');
  });

  it('names founder and admin as the roles that never fold, humans only', () => {
    expect(isGovernanceRole('founder', 'human')).toBe(true);
    expect(isGovernanceRole('admin', 'human')).toBe(true);
    expect(isGovernanceRole('engineer', 'human')).toBe(false);
    expect(isGovernanceRole('admin', 'agent')).toBe(false);
    expect(isGovernanceRole(null, 'human')).toBe(false);
  });
});
