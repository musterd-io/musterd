import type { SeatPulseFrame } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { scrubForBroadcast, scrubForReader } from './broadcastScrub.js';

describe('scrubForBroadcast', () => {
  it('passes a seat_pulse through unchanged: its only string is a member name (ADR 660)', () => {
    const frame: SeatPulseFrame = {
      type: 'seat_pulse',
      member: 'mskey_lookalike',
      ts: 1_790_000_000_000,
      intensity: 4,
      kind: 'run',
      last_ts: 1_789_999_999_000,
    };
    expect(scrubForBroadcast(frame)).toEqual(frame);
    expect(scrubForReader('broadcast', frame)).toEqual(frame);
  });
});
