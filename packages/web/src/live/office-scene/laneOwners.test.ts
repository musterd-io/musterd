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

  it('tells an acceptance from a self-close', () => {
    const owners = createLaneOwners();
    owners.note('L1', 'slippy');
    expect(owners.closedByOther('L1', 'nick')).toBe(true); // the acceptor resolved it
    expect(owners.closedByOther('L1', 'slippy')).toBe(false); // the owner closed their own lane
    expect(owners.closedByOther('L9', 'nick')).toBe(true); // never saw it owned: celebrate
  });

  describe('seeded from the board (lane 01M50TZDDM)', () => {
    it('carries as the board owner when the room never saw the claim', () => {
      const owners = createLaneOwners();
      owners.seed(new Map([['L1', 'slippy']]));
      expect(owners.carrier('L1', 'nick')).toBe('slippy');
    });

    it('a board refresh replaces what the room watched before it', () => {
      const owners = createLaneOwners();
      owners.note('L1', 'slippy');
      owners.seed(new Map([['L1', 'fifty']])); // handed over while the room was not looking
      expect(owners.carrier('L1', 'nick')).toBe('fifty');
    });

    it('a walk the room watched after the refresh wins until the next one', () => {
      const owners = createLaneOwners();
      owners.seed(new Map([['L1', 'slippy']]));
      owners.note('L1', 'fifty'); // claimed in front of the viewer; the board has not caught up
      expect(owners.carrier('L1', 'nick')).toBe('fifty');
      owners.seed(new Map([['L1', 'fifty']]));
      expect(owners.carrier('L1', 'nick')).toBe('fifty');
    });

    it('a lane the board does not list keeps what the room watched, then the sender', () => {
      const owners = createLaneOwners();
      owners.seed(new Map([['L2', 'slippy']]));
      owners.note('L1', 'fifty');
      expect(owners.carrier('L1', 'nick')).toBe('fifty');
      expect(owners.carrier('L9', 'nick')).toBe('nick');
    });

    it('a self-close of a lane the room never saw claimed is not an acceptance', () => {
      const owners = createLaneOwners();
      owners.seed(new Map([['L1', 'slippy']]));
      expect(owners.closedByOther('L1', 'slippy')).toBe(false);
      expect(owners.closedByOther('L1', 'nick')).toBe(true);
    });
  });
});
