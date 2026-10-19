import type { SeatPulseFrame } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { scrubForBroadcast, scrubForReader } from './broadcastScrub.js';

describe('scrubForBroadcast', () => {
  const pulse = (member: string): SeatPulseFrame => ({
    type: 'seat_pulse',
    member,
    ts: 1_790_000_000_000,
    intensity: 4,
    kind: 'run',
    last_ts: 1_789_999_999_000,
  });

  it('passes a seat_pulse through unchanged: its only string is a seat name (ADR 660)', () => {
    const frame = pulse('miley');
    expect(scrubForBroadcast(frame)).toEqual(frame);
    expect(scrubForReader('broadcast', frame)).toEqual(frame);
  });

  it('is not bypassed for a seat_pulse: a credential-shaped string is still redacted', () => {
    const scrubbed = scrubForBroadcast(pulse('mskey_lookalike'));
    expect(scrubbed.member).not.toBe('mskey_lookalike');
    expect(scrubbed.member).toMatch(/^<redacted:/);
    expect({ ...scrubbed, member: '' }).toEqual({ ...pulse('mskey_lookalike'), member: '' });
  });
});
