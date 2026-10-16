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
        // ADR 478 on Cloud (lane 01M3W6GWVN): it archives into `audit_archive`, not beside a file.
        'audit_retention',
        'trace_coverage',
        'expired_member_sweep',
        'provision_sweep',
        'digest',
        'policy_review',
        // Lane 01M3W815KR: the relay pull is resolved, checked public and pinned (ADR 443 §5).
        'seeds_ingest',
      ].sort(),
    );
  });

  const machineLoops = ['roster_watch', 'footprint', 'sync_push', 'sync_pull', 'trace_push'];
  it.each(machineLoops)('cloud does not run %s', (loop) => {
    expect(loopsFor('cloud').has(loop as never)).toBe(false);
  });
});
