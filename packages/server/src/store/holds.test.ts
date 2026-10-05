import { HOLD_MAX_MS } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createTeam } from './teams.js';
import { holdExpiry, listActiveHolds, projectHoldEvent } from './holds.js';

const NOW = 1_791_229_200_000;

describe('holdExpiry (ADR 516)', () => {
  it('takes until or for_ms, and refuses the past and anything over 12h', () => {
    expect(holdExpiry({ effect: 'notice', reason: 'x', for_ms: 60_000 }, NOW)).toBe(NOW + 60_000);
    expect(holdExpiry({ effect: 'notice', reason: 'x', until: NOW + 5 }, NOW)).toBe(NOW + 5);
    expect(() => holdExpiry({ effect: 'notice', reason: 'x', until: NOW }, NOW)).toThrow(/future/);
    expect(() =>
      holdExpiry({ effect: 'notice', reason: 'x', for_ms: HOLD_MAX_MS + 1 }, NOW),
    ).toThrow(/12h/);
  });
});

withDrivers('holds-store', (_o, kind) => {
  describe('projectHoldEvent — the fold side', () => {
    it('reads what it can and answers unknown for what it cannot, so the fold stops loudly', async () => {
      const db = await openTestDriver(kind);
      const team = await createTeam(db, { slug: 'dawn' });
      const hold = {
        id: 'h1',
        effect: 'notice',
        reason: 'leave the deck',
        created_by: 'nick',
        created_at: NOW,
        expires_at: NOW + 60_000,
        lifted_at: null,
        lifted_by: null,
      };
      expect(await projectHoldEvent(db, team.id, 'hold.set', { hold })).toBe('applied');
      // Re-delivery is a no-op on the hub's id.
      expect(await projectHoldEvent(db, team.id, 'hold.set', { hold })).toBe('applied');
      expect(await listActiveHolds(db, team.id, NOW)).toHaveLength(1);

      expect(await projectHoldEvent(db, team.id, 'hold.set', { hold: { id: 'h2' } })).toBe(
        'unknown',
      );
      expect(await projectHoldEvent(db, team.id, 'hold.lifted', { id: 'h1' })).toBe('unknown');
      expect(await projectHoldEvent(db, team.id, 'hold.widened', {})).toBe('unknown');

      expect(
        await projectHoldEvent(db, team.id, 'hold.lifted', {
          id: 'h1',
          lifted_at: NOW + 1,
          lifted_by: 'nick',
        }),
      ).toBe('applied');
      expect(await listActiveHolds(db, team.id, NOW + 2)).toEqual([]);
    });
  });
});
