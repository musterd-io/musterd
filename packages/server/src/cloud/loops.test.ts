import { describe, expect, it } from 'vitest';
import { LOOPS, loopsFor } from './loops.js';

describe('which background loops a server runs (1C task 8)', () => {
  it('self-hosted runs every loop, as before', () => {
    expect([...loopsFor('self-hosted')].sort()).toEqual([...LOOPS].sort());
  });

  it('cloud runs the database loops and none that read this machine', () => {
    expect([...loopsFor('cloud')].sort()).toEqual(
      [
        'reaper',
        'trace_prune',
        'trace_coverage',
        'expired_member_sweep',
        'provision_sweep',
        'digest',
        'policy_review',
      ].sort(),
    );
  });

  it.each([
    'roster_watch',
    'footprint',
    'sync_push',
    'sync_pull',
    'trace_push',
    'audit_retention',
    // Review M4: an admin-set relay URL is fetched with no public-host check — not on a fleet.
    'seeds_ingest',
  ])('cloud does not run %s', (loop) => {
    expect(loopsFor('cloud').has(loop as never)).toBe(false);
  });
});
