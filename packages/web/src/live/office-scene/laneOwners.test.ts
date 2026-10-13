import { describe, expect, it } from 'vitest';
import { createLaneOwners } from './laneOwners';

describe('lane owners (lane 01M4V774MK)', () => {
  it('carries as the owner the room saw, not the ask sender', () => {
    const owners = createLaneOwners();
    owners.note('L1', 'slippy');
    // A re-routed acceptance ask arrives from nick; slippy still owns the card.
    expect(owners.carrier('L1', 'nick')).toBe('slippy');
  });

  it('falls back to the sender for a lane the room never saw', () => {
    expect(createLaneOwners().carrier('L9', 'nick')).toBe('nick');
  });

  it('follows a lane that changed hands', () => {
    const owners = createLaneOwners();
    owners.note('L1', 'slippy');
    owners.note('L1', 'fifty');
    expect(owners.carrier('L1', 'nick')).toBe('fifty');
  });

  it('forgets the stalest lanes past its bound', () => {
    const owners = createLaneOwners();
    for (let i = 0; i < 300; i++) owners.note(`L${i}`, 'slippy');
    expect(owners.carrier('L0', 'nick')).toBe('nick');
    expect(owners.carrier('L299', 'nick')).toBe('slippy');
  });
});
