import { describe, expect, it } from 'vitest';

import { seatRoles } from './occupation';

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
